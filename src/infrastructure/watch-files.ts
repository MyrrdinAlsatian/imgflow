import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ClaimedImage, WatchJobStorage } from "../application/process-watch-job.ts";

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

  const temporary = join(dirname(destination), `.transfer-${randomUUID()}`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const [sourceHash, copyHash] = await Promise.all([digest(source), digest(temporary)]);
    if (!sameFile(expected, await readFileStamp(source))) return false;
    if (sourceHash !== copyHash) throw new Error(`Copied file did not match "${source}".`);

    await syncPath(temporary, "r+");
    await rename(temporary, destination);
    // Windows does not expose directory handles that can be flushed through fs.open.
    if (process.platform !== "win32") await syncPath(dirname(destination), "r");
    if (!sameFile(expected, await readFileStamp(source))) {
      throw new Error(`Source changed after copying "${source}". The copy is at "${destination}".`);
    }
    await unlink(source);
    return true;
  } catch (error) {
    throw new Error(`Could not transfer "${source}" to "${destination}".`, { cause: error });
  } finally {
    await rm(temporary, { force: true });
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

  async function retain(job: ClaimedImage, destination: string): Promise<string> {
    const stamp = await readFileStamp(job.path);
    if (!stamp || !(await moveOriginal(job.path, destination, stamp))) {
      throw new Error(`Claimed original changed or disappeared: "${job.path}".`);
    }
    await rmdir(dirname(job.path));
    return destination;
  }

  const storage: WatchJobStorage = {
    async publish(job, render) {
      const staging = await mkdtemp(join(output, ".pixelflow-"));
      const destination = join(output, job.id);
      try {
        const files = await render(job.path, staging);
        await rename(staging, destination);
        return files.map(({ name, dimensions }) => ({ path: join(destination, name), dimensions }));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    async archive(job) {
      const destination = join(archive, job.id);
      await mkdir(destination);
      return retain(job, join(destination, job.name));
    },
    async fail(job, error) {
      const directory = join(failed, job.id);
      const original = join(directory, "original");
      await mkdir(directory);
      await mkdir(original);
      const details = {
        jobId: job.id,
        name: job.name,
        message: error instanceof Error ? error.message : String(error),
      };
      await writeFile(join(directory, "error.json"), JSON.stringify(details, null, 2) + "\n", {
        flag: "wx",
      });
      return retain(job, join(original, job.name));
    },
  };

  return {
    input,
    storage,
    /**
     * Claims an unchanged deposit under a unique job identifier in the processing directory.
     * A move already in progress is allowed to finish during shutdown.
     *
     * @returns The claimed original, or undefined if the move was skipped or the deposit changed.
     */
    async claim(
      path: string,
      expected: BigIntStats,
      signal: AbortSignal,
    ): Promise<ClaimedImage | undefined> {
      const id = randomUUID();
      const directory = join(processing, id);
      const name = basename(path);
      const destination = join(directory, name);
      await mkdir(directory);
      if (signal.aborted || !(await moveOriginal(path, destination, expected))) {
        await rmdir(directory);
        return undefined;
      }
      return { id, name, path: destination };
    },
  };
}
