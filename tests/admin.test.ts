import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pino from "pino";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convertWithSharp } from "../src/infrastructure/sharp-webp.ts";
import { openJobJournal } from "../src/infrastructure/sqlite-journal.ts";
import { watchDirectories } from "../src/infrastructure/watch-files.ts";
import { runWatchFolders } from "../src/infrastructure/watch-folder.ts";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/oriented.jpg", import.meta.url));
let root: string;
let config: string;
let stateDirectory: string;
let directories: ReturnType<typeof watchDirectories>;
let shutdown: AbortController;
let service: Promise<void> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelflow-admin-"));
  config = join(root, "pipelines.yaml");
  stateDirectory = join(root, "data", "state");
  directories = watchDirectories(join(root, "data"));
  shutdown = new AbortController();
  service = undefined;
});

afterEach(async () => {
  shutdown.abort();
  try {
    await service;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

const example = `
version: 1
settings:
  stateDirectory: data/state
pipelines:
  web:
    watch: data/input
    processing: data/processing
    output: data/output
    archive: data/archive
    failed: data/failed
    steps:
      - type: export
        variants: [{ format: webp }]
`;

async function admin(...args: string[]) {
  const { stdout } = await exec(process.execPath, [entry, "admin", ...args], {
    cwd: root,
    timeout: 6000,
  });
  return JSON.parse(stdout) as unknown;
}

test("validates the actual YAML schema without creating watch directories or opening SQLite", async () => {
  await writeFile(config, example);
  expect(await admin("validate", config)).toEqual({
    valid: true,
    config,
    stateDirectory,
    pipelines: ["web"],
  });
  await writeFile(config, example.replace("format: webp", "format: gif"));
  await expect(admin("validate", config)).rejects.toThrow(
    "pipelines.web.steps[0].variants[0].format",
  );
  await expect(admin("jobs")).rejects.toThrow("Job journal not found");
  expect(await readdir(root)).toEqual(["pipelines.yaml"]);
});

test("inspects a live failure, queues one concurrent retry and reports the resulting metrics", async () => {
  await writeFile(config, example);
  await mkdir(directories.input, { recursive: true });
  await copyFile(fixture, join(directories.input, "photo.jpg"));
  let canRender = false;
  const messages: string[] = [];
  const logger = pino(
    {},
    {
      write: (line) => {
        messages.push(line);
      },
    },
  );
  service = runWatchFolders(
    [
      {
        directories,
        stabilityMs: 20,
        async render(inputPath, staging) {
          if (!canRender) throw new Error("Test encoder failure");
          const name = "image.webp";
          const dimensions = await convertWithSharp({
            inputPath,
            outputPath: join(staging, name),
            width: 30,
            height: 40,
            quality: 85,
          });
          return [{ name, dimensions }];
        },
      },
    ],
    1,
    logger,
    shutdown.signal,
    { stateDirectory, maxRetries: 0, scanIntervalSeconds: 1 },
  );
  await vi.waitFor(
    () => expect(messages.some((line) => line.includes("Image failed"))).toBe(true),
    { timeout: 3000 },
  );
  const records = (await admin(
    "jobs",
    "--status",
    "failed",
    "--limit",
    "1",
    "--config",
    config,
  )) as { id: string }[];
  const source = records[0]?.id;
  if (!source) throw new Error("Missing failed job.");
  const retained = join(directories.failed, source, "original", "photo.jpg");
  await chmod(retained, 0o444);
  expect(await admin("jobs", "--status", "failed", "--limit", "1", "--offset", "1")).toEqual([]);
  expect(await admin("job", source)).toMatchObject({
    id: source,
    status: "failed",
    lastError: "Test encoder failure",
    attempts: 1,
    retryOf: null,
    retryJobId: null,
    attemptHistory: [{ number: 1, outcome: "error", error: "Test encoder failure" }],
  });

  canRender = true;
  const requests = (await Promise.all([
    admin("retry", source, "--config", config),
    admin("retry", source, "--state-directory", stateDirectory),
  ])) as { id: string; queued: boolean; retryOf: string }[];
  expect(requests.map(({ queued }) => queued).sort()).toEqual([false, true]);
  expect(requests.map(({ retryOf }) => retryOf)).toEqual([source, source]);
  const retry = requests[0]?.id;
  if (!retry) throw new Error("Missing retry job.");
  expect(requests[1]?.id).toBe(retry);
  expect(retry).not.toBe(source);

  await vi.waitFor(
    () => expect(messages.some((line) => line.includes("Image completed"))).toBe(true),
    { timeout: 3500 },
  );
  expect(await admin("job", source)).toMatchObject({ status: "failed", retryJobId: retry });
  expect(await admin("job", retry)).toMatchObject({
    status: "completed",
    retryOf: source,
    attempts: 1,
    attemptHistory: [{ number: 1, outcome: "published" }],
  });
  const output = await readFile(join(directories.output, retry, "image.webp"));
  expect(await sharp(output).metadata()).toMatchObject({ format: "webp", width: 20, height: 40 });
  const original = await readFile(fixture);
  expect(await readFile(retained)).toEqual(original);
  expect((await stat(retained)).mode & 0o200).toBe(0);
  expect(await readFile(join(directories.archive, retry, "photo.jpg"))).toEqual(original);
  expect(await readdir(directories.output)).toEqual([retry]);
  expect(await admin("metrics", "--config", config)).toMatchObject({
    jobs: { total: 2, byStatus: { failed: 1, completed: 1, pending: 0 } },
    attempts: { total: 2, byOutcome: { published: 1, error: 1 } },
    manualRetries: 1,
    automaticRetries: 0,
    publishedAttemptDurationMs: { samples: 1, p50: expect.any(Number), p95: expect.any(Number) },
  });
  await expect(admin("retry", retry)).rejects.toThrow("must be failed");
}, 15_000);

test("opens a Phase 5 journal in read-only mode and migrates retry lineage when an original is available", async () => {
  const id = randomUUID();
  const original = join(directories.failed, id, "original", "photo.jpg");
  const { journal, close } = await openJobJournal(stateDirectory);
  try {
    const job = journal.add(
      { id, name: "photo.jpg", scope: directories.input },
      JSON.stringify(directories),
      null,
    );
    const attempt = journal.startAttempt(job);
    journal.finishAttempt(attempt, "error", "failing", "Legacy encoder failure");
    journal.set(job, "failed", "Legacy encoder failure", original);
  } finally {
    close();
  }
  const db = new DatabaseSync(join(stateDirectory, "jobs.sqlite"));
  try {
    db.exec("DROP TABLE manual_retries");
    expect(await admin("job", id)).toMatchObject({
      id,
      retryOf: null,
      retryJobId: null,
      lastError: "Legacy encoder failure",
    });
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'manual_retries'").get(),
    ).toBeUndefined();
    await expect(admin("retry", id)).rejects.toThrow("Retained original not found");
    await mkdir(join(directories.failed, id, "original"), { recursive: true });
    await copyFile(fixture, original);
    expect(await admin("retry", id)).toMatchObject({ retryOf: id, queued: true });
    expect(db.prepare("SELECT count(*) AS count FROM manual_retries").get()).toMatchObject({
      count: 1,
    });
    expect(await admin("jobs", "--status", "pending")).toMatchObject([
      { status: "pending", attempts: 0, retryOf: id },
    ]);
  } finally {
    db.close();
  }
}, 10_000);
