import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JobJournal } from "../application/job-journal.ts";
import type { JobRecord } from "../domain/job.ts";

const active = "status NOT IN ('completed', 'failed', 'cancelled')";
const fields =
  "id, name, scope, signature, status, attempts, retry_at AS retryAt, last_error AS error";

/**
 * Opens the history database and reserves the state directory for one running service.
 * The exclusive lock uses a separate SQLite file so history readers can still open the journal.
 *
 * @param directory - Local directory for the history and service-lock databases.
 * @returns The journal and its close operation. Close it after the watchers and jobs have drained.
 * @throws If the directory, database or service lock cannot be opened.
 */
export async function openJobJournal(directory: string) {
  await mkdir(directory, { recursive: true });
  // A separate SQLite file provides an OS-released service lock without blocking history readers.
  const lock = new DatabaseSync(join(directory, "service-lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    throw new Error(`Cannot lock PixelFlow state directory "${directory}".`, { cause: error });
  }
  try {
    const db = openJournalDatabase(directory, false);
    try {
      return {
        journal: createJournal(db),
        /** Tests the live connection's ability to acquire a write transaction. */
        checkWritable: () => db.exec("BEGIN IMMEDIATE; ROLLBACK"),
        close: () => {
          try {
            db.close();
          } finally {
            lock.close();
          }
        },
      };
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    lock.close();
    throw error;
  }
}

/**
 * Opens a connection independently of the service lock so administration can run online.
 *
 * @param directory - State directory containing `jobs.sqlite`.
 * @param readOnly - Whether the connection must reject writes.
 * @returns A connection with a configured busy timeout. The caller closes it after use.
 */
export function openJournalDatabase(directory: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(join(directory, "jobs.sqlite"), { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Creates retry lineage when absent and enforces one manual retry per failed source job. */
export function ensureRetryTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manual_retries (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id),
      source_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id)
    ) STRICT;
  `);
}

/**
 * Acquires the SQLite write lock before invoking a synchronous operation.
 *
 * @param db - Connection that owns the transaction.
 * @param run - Synchronous callback whose reads and writes share the transaction.
 * @returns The callback result after a successful commit.
 * @throws If the lock, callback or commit fails.
 */
export function writeJournal<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** Initializes the schema and binds durable operations to the service's database connection. */
function createJournal(db: DatabaseSync): JobJournal {
  db.exec(`
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, layout TEXT NOT NULL,
      signature TEXT, status TEXT NOT NULL CHECK (status IN
        ('claiming','pending','running','retry','published','failing','completed','failed','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, last_error TEXT, result_path TEXT, output_path TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS job_scope ON jobs(scope, status);
    CREATE UNIQUE INDEX IF NOT EXISTS active_claim ON jobs(scope, name) WHERE status = 'claiming';
    CREATE TABLE IF NOT EXISTS job_attempts (
      job_id TEXT NOT NULL REFERENCES jobs(id), number INTEGER NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, error TEXT,
      PRIMARY KEY (job_id, number)
    ) STRICT;
  `);
  ensureRetryTable(db);
  const insert = db.prepare(`INSERT INTO jobs
    (id, scope, name, layout, signature, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const find = db.prepare(`SELECT ${fields} FROM jobs WHERE id = ?`);
  const retrySource = db.prepare(`
    SELECT source.id, source.name, source.scope
    FROM manual_retries AS retry JOIN jobs AS source ON source.id = retry.source_job_id
    WHERE retry.job_id = ?
  `);
  const findClaim = db.prepare(
    `SELECT ${fields} FROM jobs WHERE scope = ? AND name = ? AND status = 'claiming'`,
  );
  const unfinished = db.prepare(
    `SELECT ${fields} FROM jobs WHERE scope = ? AND ${active} ORDER BY created_at, id`,
  );
  const layouts = db.prepare(`SELECT DISTINCT scope, layout FROM jobs WHERE ${active}`);
  const set =
    db.prepare(`UPDATE jobs SET status = ?, retry_at = NULL, last_error = ?, result_path = ?,
    output_path = COALESCE(?, output_path), updated_at = ? WHERE id = ?`);
  const start = db.prepare(
    `UPDATE jobs SET status = 'running', attempts = ?, retry_at = NULL, updated_at = ? WHERE id = ?`,
  );
  const addAttempt = db.prepare(
    `INSERT INTO job_attempts (job_id, number, started_at) VALUES (?, ?, ?)`,
  );
  const endAttempt = db.prepare(
    `UPDATE job_attempts SET outcome = ?, error = ?, finished_at = ? WHERE job_id = ? AND number = ?`,
  );
  const end = db.prepare(
    `UPDATE jobs SET status = ?, last_error = ?, retry_at = ?, updated_at = ? WHERE id = ?`,
  );

  // The strict table and the shared SELECT projection define the record shape.
  const read = (id: string) => find.get(id) as JobRecord | undefined;
  return {
    add(job, layout, signature) {
      const status = signature === null ? "pending" : "claiming";
      const now = Date.now();
      insert.run(job.id, job.scope, job.name, layout, signature, status, now, now);
      return { ...job, signature, status, attempts: 0, retryAt: null, error: null };
    },
    find: read,
    retrySource: (id) => retrySource.get(id) as ReturnType<JobJournal["retrySource"]>,
    claiming: (scope, name) => findClaim.get(scope, name) as JobRecord | undefined,
    unfinished: (scope) => unfinished.all(scope) as JobRecord[],
    assertLayouts(available) {
      for (const row of layouts.all()) {
        if (typeof row.scope !== "string" || available.get(row.scope) !== row.layout) {
          throw new Error(
            `Unfinished jobs use a different directory layout for "${row.scope}". Restore that layout to resume them.`,
          );
        }
      }
    },
    set(job, status, error, resultPath) {
      set.run(
        status,
        error ?? null,
        resultPath ?? null,
        status === "published" ? (resultPath ?? null) : null,
        Date.now(),
        job.id,
      );
    },
    startAttempt(job) {
      const attempts = job.attempts + 1;
      writeJournal(db, () => {
        const now = Date.now();
        start.run(attempts, now, job.id);
        addAttempt.run(job.id, attempts, now);
      });
      return { ...job, attempts, status: "running", retryAt: null };
    },
    finishAttempt(job, outcome, status, error, retryAt) {
      writeJournal(db, () => {
        const now = Date.now();
        endAttempt.run(outcome, error ?? null, now, job.id, job.attempts);
        end.run(status, error ?? null, retryAt ?? null, now, job.id);
      });
    },
  };
}
