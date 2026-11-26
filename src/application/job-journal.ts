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

/** Durable transitions for a job and its individual render attempts. */
export type JobJournal = Readonly<{
  /** Records a claim before moving an input, or adopts an already claimed original without a signature. */
  add(job: JobIdentity, layout: string, signature: string | null): JobRecord;
  /** Reads the latest checkpoint for a job, including terminal states. */
  find(id: string): JobRecord | undefined;
  /** Returns the source job for a manual retry, or undefined for an ordinary deposit. */
  retrySource(id: string): JobIdentity | undefined;
  /** Finds the outstanding claim for a filename in this input directory. */
  claiming(scope: string, name: string): JobRecord | undefined;
  /** Lists jobs for this input directory that can still require work. */
  unfinished(scope: string): readonly JobRecord[];
  /** Rejects startup if an unfinished job's recorded directory layout has changed. */
  assertLayouts(layouts: ReadonlyMap<string, string>): void;
  /** Records a storage checkpoint. The result path is the published batch or retained original. */
  set(job: JobIdentity, status: JobStatus, error?: string, resultPath?: string): void;
  /** Increments the attempt count and records the start before rendering begins. */
  startAttempt(job: JobRecord): JobRecord;
  /** Records the outcome and the next job state together, including any retry deadline. */
  finishAttempt(
    job: JobRecord,
    outcome: JobOutcome,
    status: JobStatus,
    error?: string,
    retryAt?: number,
  ): void;
}>;
