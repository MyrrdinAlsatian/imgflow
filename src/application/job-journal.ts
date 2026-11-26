import type { JobIdentity, JobOutcome, JobRecord, JobStatus } from "../domain/job.ts";

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
