import type { ImageDimensions } from "./process-image.ts";

/** An original in the service's processing directory. */
export type ClaimedImage = Readonly<{
  /** Unique identifier shared by the output, original and diagnostics. */
  id: string;
  /** File name as deposited in the input directory. */
  name: string;
  /** Current path of the original in the processing directory. */
  path: string;
}>;

/** A completed file in a private staging directory. The name is a single path component. */
export type RenderedVariant = Readonly<{ name: string; dimensions: ImageDimensions }>;

/**
 * Encodes a claimed original into an existing, private staging directory.
 * Resolves with relative filenames and dimensions for the complete batch. The storage adapter
 * publishes the directory on success or removes it after a render failure.
 */
export type JobRenderer = (
  original: string,
  stagingDirectory: string,
) => Promise<readonly RenderedVariant[]>;

type PublishedVariant = Readonly<{ path: string; dimensions: ImageDimensions }>;

/** Storage operations for a job whose original has already been claimed. */
export type WatchJobStorage = Readonly<{
  /** Publishes the complete staging directory in one operation and returns the final variant paths. */
  publish(job: ClaimedImage, render: JobRenderer): Promise<readonly PublishedVariant[]>;
  /** Moves the original after publication and returns its archive path. */
  archive(job: ClaimedImage): Promise<string>;
  /** Retains the original and writes a diagnostic, then returns the retained original's path. */
  fail(job: ClaimedImage, error: unknown): Promise<string>;
}>;

/**
 * Publishes a batch of variants and archives the original. A render or publication error is recorded with
 * the retained original. An archive error after publication propagates to the watcher.
 *
 * @param job - Original claimed from input.
 * @param render - Adapter that renders the variants for the configured pipeline.
 * @param storage - Port for output publication and original retention.
 * @returns A completed result with the output and archive paths, or a failed result with the
 * retained original's path and the error that prevented publication.
 * @throws If archiving or persisting the failure fails.
 */
export async function processWatchJob(
  job: ClaimedImage,
  render: JobRenderer,
  storage: WatchJobStorage,
) {
  let output: Awaited<ReturnType<WatchJobStorage["publish"]>>;
  try {
    output = await storage.publish(job, render);
  } catch (error) {
    const failedPath = await storage.fail(job, error);
    return { status: "failed", failedPath, error } as const;
  }

  const archivePath = await storage.archive(job);
  return { status: "completed", output, archivePath } as const;
}
