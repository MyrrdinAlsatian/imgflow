import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { watch } from "chokidar";
import PQueue from "p-queue";
import type { Logger } from "pino";
import { processImage } from "../application/process-image.ts";
import type { WebpConverter, WebpRequest } from "../application/process-image.ts";
import { processWatchJob } from "../application/process-watch-job.ts";
import type { JobRenderer } from "../application/process-watch-job.ts";
import { openWatchStorage, readFileStamp, sameFile, watchDirectories } from "./watch-files.ts";
import type { WatchDirectories } from "./watch-files.ts";

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
  );
}

/** A non-recursive input folder, its work directories and its renderer. */
type WatchPipeline = Readonly<{
  id?: string;
  directories: WatchDirectories;
  stabilityMs: number;
  render: JobRenderer;
}>;

/**
 * Prepares all storage adapters before opening watchers. One queue limits jobs across all inputs.
 *
 * @param pipelines - Folder configurations with validated, disjoint directories.
 * @param concurrency - Maximum number of active jobs across the whole service.
 * @param logger - Logger used for lifecycle and job events, scoped by pipeline when an ID is present.
 * @param shutdown - Signal to stop claiming deposits and let in-flight jobs finish.
 * @returns Resolves after all watchers have closed and job handling has settled.
 * @throws If storage setup fails or a watcher fails. A watcher failure stops the other watchers too.
 */
export async function runWatchFolders(
  pipelines: readonly WatchPipeline[],
  concurrency: number,
  logger: Logger,
  shutdown: AbortSignal,
): Promise<void> {
  if (shutdown.aborted) return;
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
        await watchPipeline(pipeline, storage, queue, pipelineLogger, signal, failure);
      } catch (error) {
        failure.abort(error);
      }
    }),
  );
  if (failure.signal.aborted) throw failure.signal.reason;
}

async function watchPipeline(
  { stabilityMs, render }: WatchPipeline,
  { input, storage, claim }: Awaited<ReturnType<typeof openWatchStorage>>,
  queue: PQueue,
  logger: Logger,
  signal: AbortSignal,
  failure: AbortController,
): Promise<void> {
  const tasks = new Map<string, Promise<void>>();
  const changed = new Set<string>();
  const watcher = watch(input, {
    depth: 0,
    followSymlinks: false,
    atomic: false,
    ignored(path) {
      if (path === input) return false;
      const name = basename(path).toLowerCase();
      return name.startsWith(".") || name.endsWith(".part") || name.endsWith(".tmp");
    },
  });

  async function handle(path: string): Promise<void> {
    while (!signal.aborted) {
      const stamp = await waitForStableFile(path, stabilityMs, signal);
      if (!stamp || signal.aborted) return;

      await queue.add(async () => {
        if (signal.aborted) return;
        const job = await claim(path, stamp, signal);
        if (!job) return;
        logger.info({ jobId: job.id, name: job.name, originalPath: job.path }, "Image claimed");
        try {
          const result = await processWatchJob(job, render, storage);
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
                archivePath: result.archivePath,
              },
              "Image completed",
            );
          }
        } catch (err) {
          logger.error(
            { jobId: job.id, originalPath: job.path, err },
            "Could not finalize image job",
          );
        }
      });
      // A producer can deposit another file under the same name while this job is running.
    }
  }

  /**
   * Keeps one task per input path and remembers events that arrive while the task is active.
   * A final recheck covers a replacement deposited under the same name.
   */
  function schedule(path: string): void {
    if (signal.aborted) return;
    if (tasks.has(path)) {
      changed.add(path);
      return;
    }
    const task = handle(path)
      .catch((err: unknown) => logger.error({ path, err }, "Could not claim input file"))
      .finally(() => {
        tasks.delete(path);
        if (changed.delete(path)) schedule(path);
      });
    tasks.set(path, task);
  }

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("ready", () => logger.info({ input }, "Watch folder ready"));
  watcher.on("error", (error) => failure.abort(error));
  watcher.on("unlinkDir", (path) => {
    if (path === input) failure.abort(new Error(`Input directory was removed: "${input}".`));
  });

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  logger.info({ input }, "Stopping watch folder");
  try {
    await watcher.close();
  } finally {
    await Promise.all(tasks.values());
  }
  logger.info({ input }, "Watch folder stopped");
}
