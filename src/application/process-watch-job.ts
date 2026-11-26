import type { ImageDimensions } from "../domain/image.ts";
import { canRetry, retryDelayMs } from "../domain/job.ts";
import type { JobOutcome, JobRecord } from "../domain/job.ts";
import type { JobJournal } from "./job-journal.ts";

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
  /** Returns the final batch path when publication has already committed on disk. */
  published(job: ClaimedImage): Promise<string | undefined>;
  /** Finds an original already moved to the failure directory. */
  failed(job: ClaimedImage): Promise<string | undefined>;
  /** Removes the job's private staging directory before a render or retry. */
  discardStaging(job: ClaimedImage): Promise<void>;
  /** Publishes the complete staging directory in one operation and returns the final variant paths. */
  publish(job: ClaimedImage, render: JobRenderer): Promise<readonly PublishedVariant[]>;
  /** Moves the original after publication and returns its archive path. */
  archive(job: ClaimedImage): Promise<string>;
  /** Retains the original and writes a diagnostic, then returns the retained original's path. */
  fail(job: ClaimedImage, error: unknown): Promise<string>;
}>;

/**
 * Advances a claimed job by one render attempt or finishes a publication or quarantine already
 * begun on disk. A batch found at its final path goes straight to archival.
 *
 * @param record - Latest journal checkpoint for the job.
 * @param job - Original's identity and expected path in the processing directory.
 * @param render - Encoder for the complete batch of variants.
 * @param storage - Operations to inspect disk checkpoints and publish or retain files.
 * @param journal - Durable record of attempts, deadlines and job transitions.
 * @param maxRetries - Extra attempts allowed after the first render. Interrupted attempts count.
 * @returns A completed job, a quarantined original, or the persisted deadline for another attempt.
 * When recovering a published batch, its directory is returned without individual variant metadata.
 * @throws If the journal or a storage operation needed to reconcile or finalize the job fails.
 */
export async function processWatchJob(
  record: JobRecord,
  job: ClaimedImage,
  render: JobRenderer,
  storage: WatchJobStorage,
  journal: JobJournal,
  maxRetries: number,
) {
  async function archive(outputPath: string, output: readonly PublishedVariant[] = []) {
    journal.set(jobRecord, "published", undefined, outputPath);
    const archivePath = await storage.archive(job);
    journal.set(jobRecord, "completed", undefined, archivePath);
    return { status: "completed", output, outputPath, archivePath } as const;
  }
  async function quarantine(message: string) {
    journal.set(jobRecord, "failing", message);
    const failedPath = await storage.fail(job, message);
    journal.set(jobRecord, "failed", message, failedPath);
    return { status: "failed", failedPath, error: message } as const;
  }
  async function attemptFailed(outcome: Exclude<JobOutcome, "published">, error: string) {
    if (canRetry(jobRecord.attempts, maxRetries)) {
      const retryAt = Date.now() + retryDelayMs(jobRecord.attempts);
      journal.finishAttempt(jobRecord, outcome, "retry", error, retryAt);
      return { status: "retry", error, retryAt } as const;
    }
    journal.finishAttempt(jobRecord, outcome, "failing", error);
    return quarantine(error);
  }

  let jobRecord = record;
  const published = await storage.published(job);
  if (published) {
    if (record.status === "running") journal.finishAttempt(record, "published", "published");
    return archive(published);
  }
  if (record.status === "published") {
    throw new Error(`Published batch for job "${job.id}" is missing.`);
  }
  if (
    record.status === "failing" ||
    (record.status === "retry" && !canRetry(record.attempts, maxRetries)) ||
    (await storage.failed(job))
  ) {
    return quarantine(record.error ?? "The original was retained after a failed render.");
  }
  await storage.discardStaging(job);
  if (record.status === "running") {
    return attemptFailed("interrupted", "The previous render was interrupted before publication.");
  }

  jobRecord = journal.startAttempt(record);
  let output: readonly PublishedVariant[];
  try {
    output = await storage.publish(job, render);
  } catch (error) {
    const publishedAfterError = await storage.published(job);
    if (publishedAfterError) {
      journal.finishAttempt(jobRecord, "published", "published");
      return archive(publishedAfterError);
    }
    return attemptFailed("error", error instanceof Error ? error.message : String(error));
  }
  const outputPath = await storage.published(job);
  if (!outputPath) throw new Error(`Published batch for job "${job.id}" is missing.`);
  journal.finishAttempt(jobRecord, "published", "published");
  return archive(outputPath, output);
}
