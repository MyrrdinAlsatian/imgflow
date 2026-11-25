import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { watch } from "chokidar";
import PQueue from "p-queue";
import type { Logger } from "pino";
import { defaultMaxRetries, defaultScanIntervalSeconds } from "../application/job-journal.ts";
import type { JobJournal, JobRecord } from "../application/job-journal.ts";
import { processImage } from "../application/process-image.ts";
import type { WebpConverter, WebpRequest } from "../application/process-image.ts";
import { processWatchJob } from "../application/process-watch-job.ts";
import type { JobRenderer } from "../application/process-watch-job.ts";
import {
  fileSignature,
  openWatchStorage,
  readFileStamp,
  sameFile,
  watchDirectories,
} from "./watch-files.ts";
import type { WatchDirectories } from "./watch-files.ts";
import { openJobJournal } from "./sqlite-journal.ts";

/** Directory and conversion settings shared by all jobs in a watch session. */
type WatchSettings = Pick<WebpRequest, "width" | "height" | "quality"> & {
  /** Data directory containing the input and job directories. */
  root: string;
  /** Milliseconds between observations of an input file. */
  stabilityMs: number;
};

/**
 * Compares successive file snapshots across a full stability interval.
 * A stalled writer can appear stable, so producers can signal completion with a final rename.
 *
 * @returns The unchanged snapshot, or undefined if the file is absent, unsuitable or cancelled.
 */
async function waitForStableFile(path: string, delay: number, signal: AbortSignal) {
  let before = await readFileStamp(path);
  while (before && !signal.aborted) {
    try {
      await setTimeout(delay, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    }
    const after = await readFileStamp(path);
    if (sameFile(before, after)) return before;
    before = after;
  }
  return undefined;
}

/**
 * Starts a non-recursive watch, including an initial scan, and processes one job at a time.
 *
 * @param settings - Data directory, stability interval and settings for each WebP conversion.
 * @param convert - Adapter that renders the WebP for a claimed original.
 * @param logger - Logger for lifecycle events and individual job failures.
 * @param shutdown - Signal to stop accepting work and let the active job finish.
 * @returns Resolves after shutdown. Pending deposits remain in input for the next startup scan.
 * @throws If storage initialization or the watcher fails. A watcher failure drains the active job first.
 */
export function runWatchFolder(
  settings: WatchSettings,
  convert: WebpConverter,
  logger: Logger,
  shutdown: AbortSignal,
): Promise<void> {
  const render: JobRenderer = async (inputPath, staging) => {
    const name = "image.webp";
    const outputPath = join(staging, name);
    const dimensions = await processImage({ ...settings, inputPath, outputPath }, convert);
    return [{ name, dimensions }];
  };
  return runWatchFolders(
    [
      {
        directories: watchDirectories(settings.root),
        stabilityMs: settings.stabilityMs,
        render,
      },
    ],
    1,
    logger,
    shutdown,
    {
      stateDirectory: join(settings.root, "state"),
      maxRetries: defaultMaxRetries,
      scanIntervalSeconds: defaultScanIntervalSeconds,
    },
  );
}

/** A non-recursive input folder, its work directories and its renderer. */
type WatchPipeline = Readonly<{
  id?: string;
  directories: WatchDirectories;
  stabilityMs: number;
  render: JobRenderer;
}>;

type Reliability = Readonly<{
  stateDirectory: string;
  maxRetries: number;
  scanIntervalSeconds: number;
}>;

/**
 * Prepares all storage adapters before opening watchers. One queue limits jobs across all inputs.
 *
 * @param pipelines - Folder configurations with validated, disjoint directories.
 * @param concurrency - Maximum number of active jobs across the whole service.
 * @param logger - Logger used for lifecycle and job events, scoped by pipeline when an ID is present.
 * @param shutdown - Signal to stop claiming deposits and let in-flight jobs finish.
 * @param reliability - Journal location, retry budget and periodic scan interval.
 * @returns Resolves after all watchers have closed and job handling has settled.
 * @throws If storage setup fails or a watcher fails. A watcher failure stops the other watchers too.
 */
export async function runWatchFolders(
  pipelines: readonly WatchPipeline[],
  concurrency: number,
  logger: Logger,
  shutdown: AbortSignal,
  reliability: Reliability,
): Promise<void> {
  if (shutdown.aborted) return;
  const { journal, close } = await openJobJournal(reliability.stateDirectory);
  try {
    journal.assertLayouts(
      new Map(pipelines.map(({ directories }) => [directories.input, JSON.stringify(directories)])),
    );
    const prepared = await Promise.all(
      pipelines.map(async (pipeline) => ({
        pipeline,
        storage: await openWatchStorage(pipeline.directories),
      })),
    );
    if (shutdown.aborted) return;

    const failure = new AbortController();
    const signal = AbortSignal.any([shutdown, failure.signal]);
    const queue = new PQueue({ concurrency });
    await Promise.all(
      prepared.map(async ({ pipeline, storage }) => {
        try {
          const pipelineLogger = pipeline.id ? logger.child({ pipeline: pipeline.id }) : logger;
          await watchPipeline(
            pipeline,
            storage,
            queue,
            pipelineLogger,
            signal,
            failure,
            journal,
            reliability,
          );
        } catch (error) {
          failure.abort(error);
        }
      }),
    );
    if (failure.signal.aborted) throw failure.signal.reason;
  } finally {
    close();
  }
}

async function watchPipeline(
  { directories, stabilityMs, render }: WatchPipeline,
  { input, storage, claim, claimed, recoverableJobs }: Awaited<ReturnType<typeof openWatchStorage>>,
  queue: PQueue,
  logger: Logger,
  signal: AbortSignal,
  failure: AbortController,
  journal: JobJournal,
  { maxRetries, scanIntervalSeconds }: Reliability,
): Promise<void> {
  const inputs = new Map<string, Promise<void>>();
  const jobs = new Map<string, Promise<void>>();
  const changed = new Set<string>();
  const layout = JSON.stringify(directories);
  const ignored = (path: string) => {
    const name = basename(path).toLowerCase();
    return name.startsWith(".") || name.endsWith(".part") || name.endsWith(".tmp");
  };
  const watcher = watch(input, {
    depth: 0,
    followSymlinks: false,
    atomic: false,
    ignored: (path) => path !== input && ignored(path),
  });

  async function pause(ms: number): Promise<void> {
    try {
      await setTimeout(ms, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  async function advance(record: JobRecord): Promise<boolean> {
    if (signal.aborted) return false;
    const job = claimed(record);
    if (record.status === "claiming") {
      if (!(await claim(record))) {
        journal.set(record, "cancelled", "The deposit changed before the claim completed.");
        schedule(join(input, record.name));
        return false;
      }
      journal.set(record, "pending");
      record = { ...record, status: "pending" };
      logger.info({ jobId: job.id, name: job.name, originalPath: job.path }, "Image claimed");
    }
    const result = await processWatchJob(record, job, render, storage, journal, maxRetries);
    if (result.status === "retry") {
      logger.warn(
        {
          jobId: job.id,
          attempt: record.attempts + (record.status === "running" ? 0 : 1),
          err: result.error,
          retryAt: result.retryAt,
        },
        "Image retry scheduled",
      );
      return true;
    }
    if (result.status === "failed") {
      logger.warn(
        { jobId: job.id, failedPath: result.failedPath, err: result.error },
        "Image failed",
      );
    } else {
      logger.info(
        {
          jobId: job.id,
          output: result.output[0],
          variants: result.output,
          outputPath: result.outputPath,
          archivePath: result.archivePath,
        },
        "Image completed",
      );
    }
    return false;
  }

  /** Waits for persisted retry deadlines outside the shared job queue. */
  async function drive(id: string): Promise<void> {
    while (!signal.aborted) {
      const record = journal.find(id);
      if (!record) return;
      if (record.retryAt && record.retryAt > Date.now()) await pause(record.retryAt - Date.now());
      if (signal.aborted || !(await queue.add(() => advance(record)))) return;
    }
  }

  function scheduleJob(id: string): void {
    if (signal.aborted || jobs.has(id)) return;
    const task = drive(id)
      .catch((err: unknown) => logger.error({ jobId: id, err }, "Could not finalize image job"))
      .finally(() => jobs.delete(id));
    jobs.set(id, task);
  }

  /** Records a stable input before any move. Reuses an outstanding claim for that filename. */
  async function admit(path: string): Promise<void> {
    const stamp = await waitForStableFile(path, stabilityMs, signal);
    if (!stamp || signal.aborted) return;
    const name = basename(path);
    const record =
      journal.claiming(input, name) ??
      journal.add({ id: randomUUID(), name, scope: input }, layout, fileSignature(stamp));
    scheduleJob(record.id);
  }

  /**
   * Keeps one task per input path and remembers events that arrive while the task is active.
   * A final recheck covers a replacement deposited under the same name.
   */
  function schedule(path: string): void {
    if (signal.aborted || ignored(path)) return;
    if (inputs.has(path)) {
      changed.add(path);
      return;
    }
    const task = admit(path)
      .catch((err: unknown) => logger.error({ path, err }, "Could not claim input file"))
      .finally(() => {
        inputs.delete(path);
        if (changed.delete(path)) schedule(path);
      });
    inputs.set(path, task);
  }

  /**
   * Scans at startup and periodically for unfinished jobs, legacy originals in processing
   * and stable input candidates that filesystem notifications may have missed.
   */
  async function reconcile(): Promise<void> {
    while (!signal.aborted) {
      try {
        for (const job of await recoverableJobs()) {
          if (signal.aborted) return;
          if (!journal.find(job.id)) journal.add(job, layout, null);
        }
        for (const job of journal.unfinished(input)) scheduleJob(job.id);
        for (const entry of await readdir(input, { withFileTypes: true })) {
          if (entry.isFile()) schedule(join(input, entry.name));
        }
      } catch (err) {
        logger.error({ input, err }, "Could not reconcile watch folder");
      }
      await pause(scanIntervalSeconds * 1000);
    }
  }

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("ready", () => logger.info({ input }, "Watch folder ready"));
  watcher.on("error", (error) => failure.abort(error));
  watcher.on("unlinkDir", (path) => {
    if (path === input) failure.abort(new Error(`Input directory was removed: "${input}".`));
  });

  const scanning = reconcile();
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  logger.info({ input }, "Stopping watch folder");
  try {
    await watcher.close();
  } finally {
    await Promise.all([scanning, ...inputs.values(), ...jobs.values()]);
  }
  logger.info({ input }, "Watch folder stopped");
}
