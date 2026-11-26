import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { jobStatuses } from "../domain/job.ts";
import { ensureRetryTable, openJournalDatabase, writeJournal } from "./sqlite-journal.ts";
import { readFileStamp } from "./watch-files.ts";

const jobFields = `
  jobs.id, jobs.name, jobs.scope, jobs.status, jobs.attempts, jobs.retry_at AS retryAt,
  jobs.last_error AS lastError, jobs.result_path AS resultPath, jobs.output_path AS outputPath,
  jobs.created_at AS createdAt, jobs.updated_at AS updatedAt`;

/**
 * Runs an operation against an existing journal and closes the connection afterward.
 * Read-only commands share one SQLite snapshot across their queries.
 */
async function withJournal<T>(
  directory: string,
  readOnly: boolean,
  run: (db: DatabaseSync) => T | Promise<T>,
): Promise<T> {
  const file = join(directory, "jobs.sqlite");
  if (!(await readFileStamp(file))) throw new Error(`Job journal not found at "${file}".`);
  const db = openJournalDatabase(directory, readOnly);
  try {
    if (readOnly) db.exec("BEGIN");
    return await run(db);
  } finally {
    db.close();
  }
}

function hasRetryTable(db: DatabaseSync): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'manual_retries'")
    .get();
}

function retryParent(hasRetries: boolean): string {
  return hasRetries
    ? "(SELECT source_job_id FROM manual_retries WHERE job_id = jobs.id) AS retryOf"
    : "NULL AS retryOf";
}

/**
 * Reads a page of jobs in descending creation order from the watcher's journal.
 *
 * @param directory - Directory containing `jobs.sqlite`.
 * @param limit - Maximum number of jobs to return.
 * @param offset - Number of matching jobs to skip.
 * @param status - Optional exact job status filter, applied before pagination.
 * @returns Job summaries, including the source ID for manual retries when available.
 */
export function listJobs(directory: string, limit: number, offset: number, status?: string) {
  return withJournal(directory, true, (db) =>
    db
      .prepare(`
    SELECT ${jobFields}, ${retryParent(hasRetryTable(db))}
    FROM jobs WHERE (? IS NULL OR jobs.status = ?)
    ORDER BY jobs.created_at DESC, jobs.id DESC LIMIT ? OFFSET ?
  `)
      .all(status ?? null, status ?? null, limit, offset),
  );
}

/**
 * Reads a job's latest checkpoint, retained paths, attempt history and manual retry links.
 *
 * @param directory - Directory containing `jobs.sqlite`.
 * @param id - Exact job ID to look up.
 * @returns Job details with attempts in ascending attempt order.
 * @throws If the journal cannot be read or the job ID is unknown.
 */
export function inspectJob(directory: string, id: string) {
  return withJournal(directory, true, (db) => {
    const hasRetries = hasRetryTable(db);
    const job = db
      .prepare(`SELECT ${jobFields}, ${retryParent(hasRetries)}
      FROM jobs WHERE jobs.id = ?`)
      .get(id);
    if (!job) throw new Error(`Job "${id}" was not found.`);
    const attemptHistory = db
      .prepare(`
      SELECT number, started_at AS startedAt, finished_at AS finishedAt, outcome, error
      FROM job_attempts WHERE job_id = ? ORDER BY number
    `)
      .all(id);
    const retryJobId = hasRetries ? findRetry(db, id) : undefined;
    return { ...job, retryJobId: retryJobId ?? null, attemptHistory };
  });
}

function findRetry(db: DatabaseSync, sourceId: string): string | undefined {
  const retry = db
    .prepare("SELECT job_id FROM manual_retries WHERE source_job_id = ?")
    .get(sourceId);
  return typeof retry?.job_id === "string" ? retry.job_id : undefined;
}

/**
 * Queues a manual retry by inserting the new job and its source link in one transaction.
 * The watcher restores a working copy on reconciliation. Concurrent requests for the same
 * source return the same retry job.
 *
 * @param directory - Directory containing `jobs.sqlite`.
 * @param id - ID of the failed job whose original is retained.
 * @param layouts - Optional current directory layouts keyed by input directory.
 * @returns The retry ID, the source ID and whether this call inserted the retry.
 * @throws If the job is missing, is ineligible, or a new retry cannot locate the retained original.
 */
export function queueManualRetry(
  directory: string,
  id: string,
  layouts?: ReadonlyMap<string, string>,
) {
  return withJournal(directory, false, async (db) => {
    const source = db
      .prepare("SELECT scope, name, layout, status, result_path FROM jobs WHERE id = ?")
      .get(id);
    if (!source) throw new Error(`Job "${id}" was not found.`);
    if (source.status !== "failed") throw new Error(`Job "${id}" must be failed to retry it.`);
    const { scope, name, layout, result_path: original } = source;
    if (
      typeof scope !== "string" ||
      typeof name !== "string" ||
      typeof layout !== "string" ||
      typeof original !== "string"
    )
      throw new Error(`Job "${id}" has an incomplete failure record.`);
    if (layouts && layouts.get(scope) !== layout) {
      throw new Error(
        `The current configuration has a different directory layout for job "${id}".`,
      );
    }
    const previous = hasRetryTable(db) ? findRetry(db, id) : undefined;
    if (previous) return { id: previous, retryOf: id, queued: false };
    if (!(await readFileStamp(original)))
      throw new Error(`Retained original not found at "${original}".`);

    return writeJournal(db, () => {
      ensureRetryTable(db);
      const existing = findRetry(db, id);
      if (existing) return { id: existing, retryOf: id, queued: false };
      const retry = randomUUID();
      const now = Date.now();
      db.prepare(`INSERT INTO jobs (id, scope, name, layout, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(retry, scope, name, layout, now, now);
      db.prepare("INSERT INTO manual_retries (job_id, source_job_id) VALUES (?, ?)").run(retry, id);
      return { id: retry, retryOf: id, queued: true };
    });
  });
}

/**
 * Aggregates job statuses, attempt outcomes, retry counts and publication timings from one
 * read-only snapshot. Attempts without a recorded outcome count as running.
 *
 * @param directory - Directory containing `jobs.sqlite`.
 * @returns Counts and timing statistics. Timings are measured in milliseconds between the
 * start and finish checkpoints of published attempts. The p50 and p95 use the nearest rank.
 * With zero samples, the mean and percentiles are null.
 */
export function readJobMetrics(directory: string) {
  return withJournal(directory, true, (db) => {
    const jobsByStatus = Object.fromEntries(jobStatuses.map((status) => [status, 0]));
    for (const row of db
      .prepare("SELECT status, count(*) AS count FROM jobs GROUP BY status")
      .all()) {
      if (typeof row.status === "string" && typeof row.count === "number")
        jobsByStatus[row.status] = row.count;
    }
    const attemptsByOutcome: Record<string, number> = {
      running: 0,
      published: 0,
      error: 0,
      interrupted: 0,
    };
    for (const row of db
      .prepare("SELECT outcome, count(*) AS count FROM job_attempts GROUP BY outcome")
      .all()) {
      if (typeof row.count === "number")
        attemptsByOutcome[String(row.outcome ?? "running")] = row.count;
    }
    const duration = db
      .prepare(`
      WITH measured AS (
        SELECT max(0, finished_at - started_at) AS ms
        FROM job_attempts WHERE outcome = 'published' AND finished_at IS NOT NULL
      ), ranked AS (
        SELECT ms, row_number() OVER (ORDER BY ms) AS position, count(*) OVER () AS total
        FROM measured
      )
      SELECT count(*) AS samples, round(avg(ms), 1) AS mean,
        max(CASE WHEN position = (total * 50 + 99) / 100 THEN ms END) AS p50,
        max(CASE WHEN position = (total * 95 + 99) / 100 THEN ms END) AS p95
      FROM ranked
    `)
      .get();
    const automaticRetries = db
      .prepare("SELECT count(*) AS count FROM job_attempts WHERE number > 1")
      .get()?.count;
    const manualRetries = hasRetryTable(db)
      ? db.prepare("SELECT count(*) AS count FROM manual_retries").get()?.count
      : 0;
    return {
      jobs: {
        total: Object.values(jobsByStatus).reduce((a, b) => a + b, 0),
        byStatus: jobsByStatus,
      },
      attempts: {
        total: Object.values(attemptsByOutcome).reduce((a, b) => a + b, 0),
        byOutcome: attemptsByOutcome,
      },
      automaticRetries,
      manualRetries,
      publishedAttemptDurationMs: duration,
    };
  });
}
