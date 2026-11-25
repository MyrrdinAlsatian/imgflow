import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pino from "pino";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WebpConverter } from "../src/application/process-image.ts";
import { convertWithSharp, createSharpWebpConverter } from "../src/infrastructure/sharp-webp.ts";
import { moveOriginal, readFileStamp } from "../src/infrastructure/watch-files.ts";
import { runWatchFolder } from "../src/infrastructure/watch-folder.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const stabilityMs = 250;
let root: string;
let shutdown: AbortController;
let service: Promise<void> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelflow-watch-"));
  await mkdir(join(root, "input"));
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

async function start(convert: WebpConverter = convertWithSharp) {
  const messages: string[] = [];
  const logger = pino(
    { level: "info" },
    {
      write: (line) => {
        messages.push(line);
      },
    },
  );
  service = runWatchFolder(
    { root, stabilityMs, width: 30, height: 40, quality: 85 },
    convert,
    logger,
    shutdown.signal,
  );
  await vi.waitFor(
    () => {
      expect(messages.some((line) => line.includes("Watch folder ready"))).toBe(true);
    },
    { timeout: 4_000 },
  );
  return messages;
}

async function waitForEntries(directory: string, count: number) {
  return vi.waitFor(
    async () => {
      const path = join(root, directory);
      const entries = await readdir(path);
      expect(entries.filter((entry) => !entry.startsWith("."))).toHaveLength(count);
      return entries;
    },
    { timeout: 4_000 },
  );
}

test("processes existing and new deposits, waits for ongoing writes and keeps same-name originals", async () => {
  const source = join(root, "input", "photo.jpg");
  const firstBytes = await readFile(join(fixtures, "transparent.png"));
  await writeFile(source, firstBytes);
  const messages = await start();
  const [firstJob] = await waitForEntries("archive", 1);
  if (!firstJob) throw new Error("First archived job is missing.");
  await vi.waitFor(async () => {
    expect(await readFile(join(root, "archive", firstJob, "photo.jpg"))).toEqual(firstBytes);
  });

  const secondBytes = await readFile(join(fixtures, "oriented.jpg"));
  // Regular change notifications from one slow copy represent a single new deposit.
  await writeFile(source, secondBytes.subarray(0, 100));
  for (let offset = 100; offset < secondBytes.length; offset += 120) {
    await setTimeout(40);
    expect(messages.filter((line) => line.includes("Image claimed"))).toHaveLength(1);
    await appendFile(source, secondBytes.subarray(offset, offset + 120));
  }

  const jobs = await waitForEntries("archive", 2);
  const secondJob = jobs.find((job) => job !== firstJob);
  if (!secondJob) throw new Error("Second archived job is missing.");
  await vi.waitFor(async () => {
    expect(await readFile(join(root, "archive", secondJob, "photo.jpg"))).toEqual(secondBytes);
    expect(await readdir(join(root, "processing"))).toEqual([]);
  });
  expect(await readFile(join(root, "archive", firstJob, "photo.jpg"))).toEqual(firstBytes);
  for (const job of jobs) {
    const result = await sharp(await readFile(join(root, "output", job, "image.webp"))).metadata();
    expect(result.format).toBe("webp");
  }
  expect(messages.filter((line) => line.includes("Image claimed"))).toHaveLength(2);
  expect(await readdir(join(root, "input"))).toEqual([]);
  expect(await readdir(join(root, "processing"))).toEqual([]);
});

test("ignores temporary files and keeps a corrupt image and its diagnostic after a final rename", async () => {
  const partialPath = join(root, "input", "upload.part");
  await copyFile(join(fixtures, "truncated.jpg"), partialPath);
  await start();
  await setTimeout(stabilityMs * 2);
  expect(await readdir(join(root, "input"))).toEqual(["upload.part"]);
  await rename(partialPath, join(root, "input", "upload.jpg"));

  const [job] = await waitForEntries("failed", 1);
  if (!job) throw new Error("Failed job directory is missing.");
  await vi.waitFor(async () => {
    expect(await readFile(join(root, "failed", job, "original", "upload.jpg"))).toEqual(
      await readFile(join(fixtures, "truncated.jpg")),
    );
  });
  expect(await readFile(join(root, "failed", job, "error.json"), "utf8")).toContain(
    "Could not convert image",
  );
  expect(await readdir(join(root, "output"))).toEqual([]);
});

test("drains the active conversion and processes the pending deposit on the next startup", async () => {
  let conversionStarted = false;
  const release = Promise.withResolvers<void>();
  await start(async (request) => {
    conversionStarted = true;
    await release.promise;
    return convertWithSharp(request);
  });
  try {
    await copyFile(join(fixtures, "oriented.jpg"), join(root, "input", "active.jpg"));
    await vi.waitFor(() => expect(conversionStarted).toBe(true), { timeout: 3_000 });
    await copyFile(join(fixtures, "oriented.jpg"), join(root, "input", "next.jpg"));
    await setTimeout(stabilityMs * 2);
    shutdown.abort();
  } finally {
    release.resolve();
  }
  await service;

  expect(await readdir(join(root, "input"))).toEqual(["next.jpg"]);
  expect(await readdir(join(root, "archive"))).toHaveLength(1);
  expect(await readdir(join(root, "processing"))).toEqual([]);

  shutdown = new AbortController();
  const messages = await start();
  await vi.waitFor(() =>
    expect(messages.some((line) => line.includes("Image completed"))).toBe(true),
  );
  expect(await readdir(join(root, "input"))).toEqual([]);
  expect(await readdir(join(root, "archive"))).toHaveLength(2);
});

test("retains the original and publishes no output when inference fails", async () => {
  const source = join(fixtures, "oriented.jpg");
  await copyFile(source, join(root, "input", "photo.jpg"));
  const messages = await start(
    createSharpWebpConverter(async () => {
      throw new Error("Inference failed");
    }),
  );
  await vi.waitFor(() => expect(messages.some((line) => line.includes("Image failed"))).toBe(true));

  const [job] = await waitForEntries("failed", 1);
  if (!job) throw new Error("Failed job directory is missing.");
  expect(await readFile(join(root, "failed", job, "original", "photo.jpg"))).toEqual(
    await readFile(source),
  );
  expect(await readFile(join(root, "failed", job, "error.json"), "utf8")).toContain(
    "Inference failed",
  );
  expect(await readdir(join(root, "output"))).toEqual([]);
});

test("on EXDEV, publishes a verified copy before removing the source", async () => {
  const original = Buffer.from("original bytes");
  const source = join(root, "input", "test.jpg");
  const targetDir = await mkdtemp(join(root, "target-"));
  const target = join(targetDir, "test.jpg");
  await writeFile(source, original);
  const expected = await readFileStamp(source);
  if (!expected) throw new Error("Source is missing.");

  const crossDeviceRename = async () => {
    throw Object.assign(new Error("Cross-device rename"), { code: "EXDEV" });
  };
  expect(await moveOriginal(source, target, expected, crossDeviceRename)).toBe(true);
  await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(target)).toEqual(original);
  expect(await readdir(targetDir)).toEqual(["test.jpg"]);
});
