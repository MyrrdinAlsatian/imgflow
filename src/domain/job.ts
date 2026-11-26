/** Default number of extra attempts after the initial render. */
export const defaultMaxRetries = 3;
/** Default interval between input and journal reconciliation scans, in seconds. */
export const defaultScanIntervalSeconds = 60;

/**
 * Durable checkpoint for a watch job. `claiming` records intent before the input moves.
 * `published` and `failing` leave the corresponding archive or quarantine move to finish.
 * Completed, failed and cancelled jobs are terminal.
 */
export const jobStatuses = [
  "claiming",
  "pending",
  "running",
  "retry",
  "published",
  "failing",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

/** Stable job ID, original filename and absolute input directory used to scope recovery. */
export type JobIdentity = Readonly<{ id: string; name: string; scope: string }>;

/** Current journal snapshot used to decide how to advance a job. */
export type JobRecord = JobIdentity &
  Readonly<{
    /** Input metadata fingerprint, or null for a job discovered directly in processing. */
    signature: string | null;
    status: JobStatus;
    /** Number of attempts started, including interrupted ones. */
    attempts: number;
    /** Earliest retry time in epoch milliseconds, or null when no delay is scheduled. */
    retryAt: number | null;
    /** Last error stored for this job, if any. */
    error: string | null;
  }>;

/** Result of an individual render attempt. Publication can precede archival. */
export type JobOutcome = "published" | "error" | "interrupted";

const maxRetryDelayMs = 30_000;

/** Whether a job that has started `attempts` renders may try again. Interrupted attempts count. */
export function canRetry(attempts: number, maxRetries: number): boolean {
  return attempts <= maxRetries;
}

/** Exponential backoff after the given attempt: 100 ms, doubling, capped at 30 seconds. */
export function retryDelayMs(attempts: number): number {
  return Math.min(maxRetryDelayMs, 100 * 2 ** (attempts - 1));
}
