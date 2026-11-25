import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JobRenderer } from "../src/application/process-watch-job.ts";
import { openJobJournal } from "../src/infrastructure/sqlite-journal.ts";
import {
  fileSignature,
  readFileStamp,
  watchDirectories,
} from "../src/infrastructure/watch-files.ts";
import { runWatchFolders } from "../src/infrastructure/watch-folder.ts";

const fixture = fileURLToPath(new URL("./fixtures/oriented.jpg", import.meta.url));
let root: string;
let directories: ReturnType<typeof watchDirectories>;
let stateDirectory: string;
let stop: AbortController;
let service: Promise<void> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelflow-recovery-"));
  directories = watchDirectories(root);
  stateDirectory = join(root, "state");
  stop = new AbortController();
  service = undefined;
  for (const path of Object.values(directories)) await mkdir(path);
});

afterEach(async () => {
  stop.abort();
  try {
    await service;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

const render: JobRenderer = async (input, staging) => {
  await copyFile(input, join(staging, "image.webp"));
  return [{ name: "image.webp", dimensions: { width: 30, height: 40 } }];
};

async function start(renderer: JobRenderer = render) {
  let ready = false;
  const logger = pino(
    {},
    {
      write: (line) => {
        if (line.includes("Watch folder ready")) ready = true;
      },
    },
  );
  service = runWatchFolders(
    [{ directories, stabilityMs: 25, render: renderer }],
    1,
    logger,
    stop.signal,
    { stateDirectory, maxRetries: 2, scanIntervalSeconds: 1 },
  );
  await vi.waitFor(() => expect(ready).toBe(true), { timeout: 3000 });
}

function query(sql: string) {
  const db = new DatabaseSync(join(stateDirectory, "jobs.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

async function completed(count: number) {
  return vi.waitFor(
    () => {
      const rows = query(
        "SELECT id, name, attempts FROM jobs WHERE status = 'completed' ORDER BY name",
      );
      expect(rows).toHaveLength(count);
      return rows;
    },
    { timeout: 4000 },
  );
}

test("retries failed renders and persists the result and all attempts for one job", async () => {
  await copyFile(fixture, join(directories.input, "retry.jpg"));
  let attempts = 0;
  await start(async (input, staging) => {
    if (++attempts < 3) throw new Error("Temporary encoder failure");
    return render(input, staging);
  });
  const [job] = await completed(1);
  expect(job).toMatchObject({ name: "retry.jpg", attempts: 3 });
  expect(query("SELECT number, outcome FROM job_attempts ORDER BY number")).toEqual([
    { number: 1, outcome: "error" },
    { number: 2, outcome: "error" },
    { number: 3, outcome: "published" },
  ]);
  expect(await readdir(directories.archive)).toHaveLength(1);
  expect(await readdir(directories.output)).toHaveLength(1);
});

test("reconciles claim, atomic publication and archive checkpoints without duplicating batches", async () => {
  const { journal, close } = await openJobJournal(stateDirectory);
  const layout = JSON.stringify(directories);
  const job = (name: string) => ({ id: randomUUID(), scope: directories.input, name });
  async function copyInto(parent: string, { id, name }: ReturnType<typeof job>) {
    await mkdir(join(parent, id));
    await copyFile(fixture, join(parent, id, name));
  }
  const before = job("claim-before.jpg");
  const duplicate = job("claim-cross-volume.jpg");
  const published = job("published.jpg");
  const archived = job("archived.jpg");
  try {
    for (const entry of [before, duplicate]) {
      const input = join(directories.input, entry.name);
      await copyFile(fixture, input);
      const stamp = await readFileStamp(input);
      if (!stamp) throw new Error("Input snapshot missing.");
      journal.add(entry, layout, fileSignature(stamp));
    }
    await copyInto(directories.processing, duplicate);

    await copyInto(directories.processing, published);
    const publishing = journal.startAttempt(journal.add(published, layout, null));
    expect(publishing.status).toBe("running");
    await copyInto(directories.output, { ...published, name: "image.webp" });

    const archiving = journal.startAttempt(journal.add(archived, layout, null));
    journal.finishAttempt(archiving, "published", "published");
    await copyInto(directories.output, { ...archived, name: "image.webp" });
    await copyInto(directories.archive, archived);
  } finally {
    close();
  }

  const rendered: string[] = [];
  await start(async (input, staging) => {
    rendered.push(basename(input));
    return render(input, staging);
  });
  expect((await completed(4)).map(({ attempts }) => attempts)).toEqual([1, 1, 1, 1]);
  expect(rendered.sort()).toEqual([before.name, duplicate.name].sort());
  expect(await readdir(directories.input)).toEqual([]);
  expect(await readdir(directories.processing)).toEqual([]);
  expect(await readdir(directories.output)).toHaveLength(4);
  for (const entry of [before, duplicate, published, archived]) {
    expect(await readFile(join(directories.archive, entry.id, entry.name))).toEqual(
      await readFile(fixture),
    );
  }
});

test("recovers a killed render, clears its staging directory and counts the interrupted attempt", async () => {
  await copyFile(fixture, join(directories.input, "interrupted.jpg"));
  const watchUrl = new URL("../src/infrastructure/watch-folder.ts", import.meta.url).href;
  const filesUrl = new URL("../src/infrastructure/watch-files.ts", import.meta.url).href;
  const worker = `
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import pino from "pino";
    import { runWatchFolders } from ${JSON.stringify(watchUrl)};
    import { watchDirectories } from ${JSON.stringify(filesUrl)};
    const root = process.argv[1];
    await runWatchFolders([{
      directories: watchDirectories(root), stabilityMs: 25,
      async render(input, staging) {
        await writeFile(join(staging, "incomplete.webp"), "incomplete");
        process.stdout.write("rendering");
        await new Promise(() => {});
      },
    }], 1, pino({ level: "silent" }), new AbortController().signal,
    { stateDirectory: join(root, "state"), maxRetries: 2, scanIntervalSeconds: 1 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", worker, root]);
  const exited = once(child, "exit");
  let output = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await vi.waitFor(() => expect(output, stderr).toContain("rendering"), { timeout: 3500 });
    expect(query("SELECT status, attempts FROM jobs")).toEqual([
      { status: "running", attempts: 1 },
    ]);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }

  await start();
  expect(await completed(1)).toEqual([
    expect.objectContaining({ name: "interrupted.jpg", attempts: 2 }),
  ]);
  expect(query("SELECT number, outcome FROM job_attempts ORDER BY number")).toEqual([
    { number: 1, outcome: "interrupted" },
    { number: 2, outcome: "published" },
  ]);
  const [jobId] = await readdir(directories.output);
  expect(jobId).toBeDefined();
  expect(await readdir(join(directories.output, jobId ?? ""))).toEqual(["image.webp"]);
});

test("reconciles a late Phase 4 job in processing through the periodic scan", async () => {
  await start();
  // Keep the initial scan distinct from the later deposit into the unwatched directory.
  await completed(0);
  const id = randomUUID();
  await mkdir(join(directories.processing, id));
  await copyFile(fixture, join(directories.processing, id, "legacy.jpg"));
  expect(await completed(1)).toEqual([{ id, name: "legacy.jpg", attempts: 1 }]);
  expect(await readFile(join(directories.archive, id, "legacy.jpg"))).toEqual(
    await readFile(fixture),
  );
});

test("excludes a second service from the same journal until the owner closes", async () => {
  const first = await openJobJournal(stateDirectory);
  try {
    await expect(openJobJournal(stateDirectory)).rejects.toThrow(
      "Cannot lock PixelFlow state directory",
    );
  } finally {
    first.close();
  }
  const reopened = await openJobJournal(stateDirectory);
  reopened.close();
});
