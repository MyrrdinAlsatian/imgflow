import { constants } from "node:fs";
import { access, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { WatchDirectories } from "./watch-files.ts";

const heartbeatIntervalMs = 5_000;
const heartbeatMaxAgeMs = 30_000;

/** Tracks operational health separately from the success or failure of individual images. */
export type WatchHealth = Readonly<{
  ready(input: string): void;
  scanned(input: string, ok: boolean): void;
  track<T>(run: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

/**
 * Writes an atomic heartbeat after checking readiness, disk and the live journal connection.
 * A fresh heartbeat also requires every active job to remain within the configured time budget.
 */
export function startWatchHealth(options: {
  path: string;
  folders: readonly WatchDirectories[];
  stateDirectory: string;
  maxJobSeconds: number;
  checkJournal: () => void;
  shutdown: AbortSignal;
  onError: (error: unknown) => void;
}): WatchHealth {
  const { path, folders, stateDirectory, maxJobSeconds, checkJournal, shutdown, onError } = options;
  if (!Number.isSafeInteger(maxJobSeconds) || maxJobSeconds < 1) {
    throw new Error("PIXELFLOW_HEALTH_MAX_JOB_SECONDS must be a positive integer.");
  }
  const inputs = folders.map(({ input }) => input);
  const directories = new Set([
    stateDirectory,
    ...folders.flatMap((folder) => Object.values(folder)),
  ]);
  const watched = new Set<string>();
  const scanned = new Set<string>();
  const active = new Set<{ started: number }>();
  const stop = new AbortController();
  const signal = AbortSignal.any([shutdown, stop.signal]);
  const temporary = `${path}.${process.pid}.tmp`;

  async function check(): Promise<void> {
    if (inputs.some((input) => !watched.has(input) || !scanned.has(input))) {
      throw new Error("A watch folder is starting or could not be reconciled.");
    }
    if ([...active].some(({ started }) => performance.now() - started > maxJobSeconds * 1000)) {
      throw new Error("An active job exceeded the healthcheck time budget.");
    }
    await Promise.all(
      [...directories].map(async (directory) => {
        if (!(await stat(directory)).isDirectory())
          throw new Error(`Expected a directory at "${directory}".`);
        await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
        if ((await statfs(directory)).bavail === 0)
          throw new Error(`No disk space at "${directory}".`);
      }),
    );
    await access(join(stateDirectory, "jobs.sqlite"), constants.R_OK | constants.W_OK);
    checkJournal();
  }

  async function heartbeat(): Promise<void> {
    try {
      while (!signal.aborted) {
        const error = await check().then(
          () => null,
          (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
        );
        if (signal.aborted) return;
        await writeFile(
          temporary,
          JSON.stringify({ pid: process.pid, writtenAt: Date.now(), error }),
        );
        await rename(temporary, path);
        await setTimeout(heartbeatIntervalMs, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) onError(error);
    } finally {
      await rm(temporary, { force: true });
      await rm(path, { force: true });
    }
  }
  const done = heartbeat().catch(onError);

  return {
    ready(input) {
      watched.add(input);
    },
    scanned(input, ok) {
      if (ok) scanned.add(input);
      else scanned.delete(input);
    },
    async track(run) {
      const job = { started: performance.now() };
      active.add(job);
      try {
        return await run();
      } finally {
        active.delete(job);
      }
    },
    async close() {
      stop.abort();
      await done;
    },
  };
}

/** Rejects an unhealthy or stale heartbeat or one written by a process that has exited. */
export async function checkWatchHealth(path: string): Promise<void> {
  const record: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !record ||
    typeof record !== "object" ||
    !("pid" in record) ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    !("writtenAt" in record) ||
    typeof record.writtenAt !== "number" ||
    !Number.isSafeInteger(record.writtenAt) ||
    !("error" in record) ||
    (record.error !== null && typeof record.error !== "string")
  )
    throw new Error("Invalid watch heartbeat.");
  const age = Date.now() - record.writtenAt;
  if (age < 0 || age > heartbeatMaxAgeMs) throw new Error("The watch heartbeat is stale.");
  if (record.error !== null) throw new Error(record.error);
  process.kill(record.pid, 0);
}
