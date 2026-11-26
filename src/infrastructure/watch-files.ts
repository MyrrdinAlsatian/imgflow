import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { JobIdentity, JobRecord } from "../domain/job.ts";
import type { ClaimedImage, WatchJobStorage } from "../application/process-watch-job.ts";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const transfer = /^\.transfer-[0-9a-f-]{36}$/;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Reads the identity, size and timestamps of a regular file without following symlinks.
 * @returns Undefined for a missing path or an entry that is not a regular file.
 * @throws For filesystem errors other than a missing path.
 */
export async function readFileStamp(path: string): Promise<BigIntStats | undefined> {
  try {
    const stamp = await lstat(path, { bigint: true });
    return stamp.isFile() ? stamp : undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** Checks whether two observations have the same identity, size and modification timestamps. */
export function sameFile(left: BigIntStats, right: BigIntStats | undefined): boolean {
  return (
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Serializes file identity, size and nanosecond timestamps for a durable claim. */
export function fileSignature(stamp: BigIntStats): string {
  return [stamp.dev, stamp.ino, stamp.size, stamp.mtimeNs, stamp.ctimeNs].join(":");
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function syncPath(path: string, flags: "r" | "r+"): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Verifies the SHA-256 of a staged copy and publishes it in the reserved destination directory.
 *
 * @param source - Original file to copy.
 * @param destination - Final path for the working copy.
 * @param expected - Source identity and timestamps observed before the copy.
 * @returns True once the verified copy is available, or false if the source changed during copying.
 */
async function copyOriginal(
  source: string,
  destination: string,
  expected: BigIntStats,
): Promise<boolean> {
  const temporary = join(dirname(destination), `.transfer-${randomUUID()}`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const [sourceHash, copyHash] = await Promise.all([digest(source), digest(temporary)]);
    if (!sameFile(expected, await readFileStamp(source))) return false;
    if (sourceHash !== copyHash) throw new Error(`Copied file did not match "${source}".`);

    // Windows needs a writable handle to flush the working copy, even for read-only originals.
    if (process.platform === "win32" && !(expected.mode & 0o200n)) {
      await chmod(temporary, 0o600);
    }
    await syncPath(temporary, process.platform === "win32" ? "r+" : "r");
    await rename(temporary, destination);
    // Windows does not expose directory handles that can be flushed through fs.open.
    if (process.platform !== "win32") await syncPath(dirname(destination), "r");
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Moves a regular file into a reserved destination directory. On EXDEV, copies and verifies
 * the file on the destination volume before removing the source.
 *
 * @param source - Path of the original to move.
 * @param destination - Unused path in a directory reserved for this job.
 * @param expected - File snapshot to recheck before moving the source.
 * @param renameSource - Initial move operation, injectable to exercise the cross-volume fallback.
 * @returns True after the move, or false if the source changed or disappeared before publication.
 * @throws On transfer failure. If the verified copy was already published when the failure
 * occurred, it may remain alongside the source.
 */
export async function moveOriginal(
  source: string,
  destination: string,
  expected: BigIntStats,
  renameSource = rename,
): Promise<boolean> {
  if (!sameFile(expected, await readFileStamp(source))) return false;
  try {
    await renameSource(source, destination);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT") && !(await readFileStamp(source))) return false;
    if (!hasCode(error, "EXDEV")) throw error;
  }

  try {
    if (!(await copyOriginal(source, destination, expected))) return false;
    if (!sameFile(expected, await readFileStamp(source))) {
      throw new Error(`Source changed after copying "${source}". The copy is at "${destination}".`);
    }
    await unlink(source);
    return true;
  } catch (error) {
    throw new Error(`Could not transfer "${source}" to "${destination}".`, { cause: error });
  }
}

/** Roles of the directories used to claim inputs, publish variants and retain originals. */
export type WatchDirectories = Readonly<{
  input: string;
  processing: string;
  output: string;
  archive: string;
  failed: string;
}>;

/** Directory layout used by the single-folder CLI. */
export function watchDirectories(root: string): WatchDirectories {
  const base = resolve(root);
  return {
    input: join(base, "input"),
    processing: join(base, "processing"),
    output: join(base, "output"),
    archive: join(base, "archive"),
    failed: join(base, "failed"),
  };
}

/**
 * Ensures the managed directories exist and prepares operations for claims and output batches.
 * Staging lives under the output directory so a complete batch can be published by renaming it
 * on the same volume.
 *
 * @param directories - Absolute paths for one pipeline's inputs, work and retained files.
 * @returns The input path, the storage port implementation and the claim operation.
 * @throws If a directory cannot be created or an existing managed path is not a directory.
 */
export async function openWatchStorage({
  input,
  processing,
  output,
  archive,
  failed,
}: WatchDirectories) {
  for (const directory of [input, processing, output, archive, failed]) {
    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error(`Expected a directory at "${directory}".`);
    }
  }

  function claimed(job: JobIdentity): ClaimedImage {
    if (
      !uuid.test(job.id) ||
      !job.name ||
      job.name !== basename(job.name) ||
      job.name === "." ||
      job.name === ".."
    ) {
      throw new Error(`Invalid recorded job paths for "${job.id}".`);
    }
    return { id: job.id, name: job.name, path: join(processing, job.id, job.name) };
  }

  async function entries(path: string) {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  /**
   * Finishes an interrupted cross-volume move by verifying both copies and rechecking the
   * source observation before unlinking it. A changed or different source is kept.
   */
  async function removeDuplicate(source: string, destination: string, stamp: BigIntStats) {
    if (
      (await digest(source)) !== (await digest(destination)) ||
      !sameFile(stamp, await readFileStamp(source))
    ) {
      throw new Error(
        `Different originals at "${source}" and "${destination}". Both were retained.`,
      );
    }
    await unlink(source);
  }

  async function cleanTransfers(directory: string) {
    for (const entry of await entries(directory)) {
      if (entry.isFile() && transfer.test(entry.name)) await unlink(join(directory, entry.name));
    }
  }

  async function retain(job: ClaimedImage, destination: string): Promise<string> {
    const stamp = await readFileStamp(job.path);
    if (await readFileStamp(destination)) {
      if (stamp) await removeDuplicate(job.path, destination, stamp);
    } else if (!stamp || !(await moveOriginal(job.path, destination, stamp))) {
      throw new Error(`Claimed original changed or disappeared: "${job.path}".`);
    }
    const directory = dirname(job.path);
    await cleanTransfers(directory);
    await rmdir(directory).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY")) throw error;
    });
    return destination;
  }

  const stagingPath = (id: string) => join(output, `.pixelflow-${id}`);

  const storage: WatchJobStorage = {
    async published(job) {
      const path = join(output, job.id);
      try {
        if (
          !(await lstat(path)).isDirectory() ||
          !(await entries(path)).some((entry) => entry.isFile())
        ) {
          throw new Error(`Published batch is not a populated directory: "${path}".`);
        }
        return path;
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async failed(job) {
      const path = join(failed, job.id, "original", job.name);
      return (await readFileStamp(path)) ? path : undefined;
    },
    async discardStaging(job) {
      await rm(stagingPath(job.id), { recursive: true, force: true });
    },
    async publish(job, render) {
      const staging = stagingPath(job.id);
      await mkdir(staging);
      const destination = join(output, job.id);
      try {
        const files = await render(job.path, staging);
        if (!files.length) throw new Error("The renderer produced no variants.");
        for (const file of files) await syncPath(join(staging, file.name), "r+");
        if (process.platform !== "win32") await syncPath(staging, "r");
        await rename(staging, destination);
        if (process.platform !== "win32") await syncPath(output, "r");
        return files.map(({ name, dimensions }) => ({ path: join(destination, name), dimensions }));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    async archive(job) {
      const destination = join(archive, job.id);
      await mkdir(destination, { recursive: true });
      return retain(job, join(destination, job.name));
    },
    async fail(job, error) {
      const directory = join(failed, job.id);
      const original = join(directory, "original");
      await mkdir(original, { recursive: true });
      const details = {
        jobId: job.id,
        name: job.name,
        message: error instanceof Error ? error.message : String(error),
      };
      const temporary = join(directory, ".error.json.tmp");
      await writeFile(temporary, JSON.stringify(details, null, 2) + "\n");
      await rename(temporary, join(directory, "error.json"));
      return retain(job, join(original, job.name));
    },
  };

  return {
    input,
    storage,
    claimed,
    /** Finds work written by a version that predated the journal. */
    async recoverableJobs() {
      const jobs: JobIdentity[] = [];
      for (const directory of await entries(processing)) {
        if (!directory.isDirectory() || !uuid.test(directory.name)) continue;
        const originals = (await entries(join(processing, directory.name))).filter(
          (entry) => entry.isFile() && !transfer.test(entry.name),
        );
        const [original] = originals;
        if (originals.length === 1 && original) {
          jobs.push({ id: directory.name, name: original.name, scope: input });
        }
      }
      return jobs;
    },
    /**
     * Completes a recorded claim. The source stays in input if its recorded identity changed.
     * A verified duplicate left by an interrupted cross-device move is removed from input.
     *
     * @returns True once the original is in processing, or false if the claim can no longer be made.
     * @throws If the original cannot be moved or a suspected duplicate cannot be verified.
     */
    async claim(record: JobRecord): Promise<boolean> {
      const job = claimed(record);
      const source = join(input, job.name);
      const stamp = await readFileStamp(source);
      const matches = stamp && fileSignature(stamp) === record.signature;
      if (await readFileStamp(job.path)) {
        if (matches) await removeDuplicate(source, job.path, stamp);
        await cleanTransfers(dirname(job.path));
        return true;
      }
      if (!matches) return false;
      await mkdir(dirname(job.path), { recursive: true });
      if (!(await moveOriginal(source, job.path, stamp))) return false;
      await cleanTransfers(dirname(job.path));
      return true;
    },
    /**
     * Restores a manual retry's working copy from the retained failed original. A copy published
     * before an interruption is reusable. The retained original stays in the failure directory.
     *
     * @param job - Retry job and its destination path in processing.
     * @param previous - Source job in the same pipeline with the same original filename.
     * @returns True once a working copy exists, or false if the required original is unavailable.
     */
    async restoreRetry(job: ClaimedImage, previous: JobIdentity): Promise<boolean> {
      const source = claimed(previous);
      if (previous.scope !== input || source.name !== job.name) {
        throw new Error(`Retry source does not match job "${job.id}".`);
      }
      const directory = dirname(job.path);
      if (!(await readFileStamp(job.path))) {
        const path = join(failed, source.id, "original", source.name);
        const stamp = await readFileStamp(path);
        if (!stamp) return false;
        await mkdir(directory, { recursive: true });
        if (!(await copyOriginal(path, job.path, stamp))) {
          throw new Error(`Retained original changed while copying "${path}".`);
        }
      }
      await cleanTransfers(directory);
      return true;
    },
  };
}
