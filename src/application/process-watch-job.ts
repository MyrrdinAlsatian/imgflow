import { processImage } from "./process-image.ts";
import type { ImageDimensions, WebpConverter, WebpRequest } from "./process-image.ts";

/** An original in the service's processing directory. */
export type ClaimedImage = Readonly<{
  /** Unique identifier shared by the output, original and diagnostics. */
  id: string;
  /** File name as deposited in the input directory. */
  name: string;
  /** Current path of the original in the processing directory. */
  path: string;
}>;

/** Storage operations for a job whose original has already been claimed. */
export type WatchJobStorage = Readonly<{
  /** Renders to a staging path and returns the final path and dimensions after publication. */
  publish(
    job: ClaimedImage,
    render: (path: string) => Promise<ImageDimensions>,
  ): Promise<{
    path: string;
    dimensions: ImageDimensions;
  }>;
  /** Moves the original after publication and returns its archive path. */
  archive(job: ClaimedImage): Promise<string>;
  /** Retains the original and writes a diagnostic, then returns the retained original's path. */
  fail(job: ClaimedImage, error: unknown): Promise<string>;
}>;

/**
 * Publishes a WebP and archives the original. A conversion or publication error is recorded with
 * the retained original. An archive error after publication propagates to the watcher.
 *
 * @param job - Original claimed from input.
 * @param settings - Resize bounds and WebP quality.
 * @param convert - Image conversion adapter.
 * @param storage - Port for output publication and original retention.
 * @returns A completed result with the output and archive paths, or a failed result with the
 * retained original's path and the error that prevented publication.
 * @throws If archiving or persisting the failure fails.
 */
export async function processWatchJob(
  job: ClaimedImage,
  settings: Pick<WebpRequest, "width" | "height" | "quality">,
  convert: WebpConverter,
  storage: WatchJobStorage,
) {
  let output: Awaited<ReturnType<WatchJobStorage["publish"]>>;
  try {
    output = await storage.publish(job, (outputPath) =>
      processImage({ ...settings, inputPath: job.path, outputPath }, convert),
    );
  } catch (error) {
    const failedPath = await storage.fail(job, error);
    return { status: "failed", failedPath, error } as const;
  }

  const archivePath = await storage.archive(job);
  return { status: "completed", output, archivePath } as const;
}
