import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runConfiguredWatch } from "../src/infrastructure/configured-watch.ts";
import { createPipelineRenderer } from "../src/infrastructure/sharp-pipeline.ts";
import { loadWatchConfig } from "../src/infrastructure/watch-config.ts";
import { watchDirectories } from "../src/infrastructure/watch-files.ts";
import { runWatchFolders } from "../src/infrastructure/watch-folder.ts";

const fixture = fileURLToPath(new URL("./fixtures/oriented.jpg", import.meta.url));
let root: string;
let config: string;
let shutdown: AbortController;
let service: Promise<void> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelflow-config-"));
  config = join(root, "pipelines.yaml");
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

test("processes two YAML folders with different steps and publishes all four codecs", async () => {
  await writeFile(
    config,
    `
version: 1
settings:
  stabilityMs: 30
  logLevel: silent
pipelines:
  portrait:
    watch: in/portrait
    output: out/portrait
    archive: archive/portrait
    failed: failed/portrait
    steps:
      - type: normalize
      - type: resize
        width: 30
        height: 40
      - type: export
        variants:
          - format: webp
          - format: avif
          - format: jpeg
            name: preview
  icon:
    watch: in/icon
    output: out/icon
    archive: archive/icon
    failed: failed/icon
    steps:
      - type: trim
      - type: resize
        width: 16
        height: 16
        fit: contain
      - type: export
        variants:
          - format: png
          - format: jpeg
            name: matte
            background: '#112233'
`,
  );
  const portrait = join(root, "in", "portrait");
  const icon = join(root, "in", "icon");
  await mkdir(portrait, { recursive: true });
  await mkdir(icon, { recursive: true });
  await copyFile(fixture, join(portrait, "photo"));
  const pixels = Buffer.alloc(12 * 8 * 4);
  for (let y = 3; y < 5; y++) {
    for (let x = 4; x < 8; x++) pixels.set([255, 0, 0, 255], (y * 12 + x) * 4);
  }
  const originalIcon = await sharp(pixels, { raw: { width: 12, height: 8, channels: 4 } })
    .png()
    .toBuffer();
  await writeFile(join(icon, "photo"), originalIcon);
  service = runConfiguredWatch(config, shutdown.signal);

  const job = (id: string) =>
    vi.waitFor(
      async () => {
        const archive = join(root, "archive", id);
        const [key] = await readdir(archive);
        if (!key) throw new Error(`Waiting for ${id}.`);
        await stat(join(archive, key, "photo"));
        return key;
      },
      { timeout: 4000 },
    );
  const [portraitId, iconId] = await Promise.all([job("portrait"), job("icon")]);
  expect(await readFile(join(root, "archive", "portrait", portraitId, "photo"))).toEqual(
    await readFile(fixture),
  );
  expect(await readFile(join(root, "archive", "icon", iconId, "photo"))).toEqual(originalIcon);

  const portraitOutput = join(root, "out", "portrait", portraitId);
  expect((await readdir(portraitOutput)).sort()).toEqual([
    "image.avif",
    "image.webp",
    "preview.jpg",
  ]);
  for (const [name, format] of [
    ["image.avif", "heif"],
    ["image.webp", "webp"],
    ["preview.jpg", "jpeg"],
  ] as const) {
    const image = sharp(await readFile(join(portraitOutput, name)));
    const meta = await image.metadata();
    expect(meta).toMatchObject({ format, width: 20, height: 40 });
    if (format === "heif") expect(meta.compression).toBe("av1");
    expect(meta.exif).toBeUndefined();
    expect((await image.raw().toBuffer()).length).toBeGreaterThan(0);
  }
  const png = sharp(await readFile(join(root, "out", "icon", iconId, "image.png")));
  expect(await png.metadata()).toMatchObject({
    format: "png",
    width: 16,
    height: 16,
    hasAlpha: true,
  });
  const data = await png.raw().toBuffer();
  expect(data[(2 * 16 + 8) * 4 + 3]).toBe(0);
  expect(data[(5 * 16 + 8) * 4 + 3]).toBe(255);
  const jpeg = sharp(await readFile(join(root, "out", "icon", iconId, "matte.jpg")));
  expect(await jpeg.metadata()).toMatchObject({
    format: "jpeg",
    width: 16,
    height: 16,
    hasAlpha: false,
  });
  const mattePixels = await jpeg.raw().toBuffer();
  for (const [channel, value] of [17, 34, 51].entries()) {
    expect(Math.abs(mattePixels.readUInt8(channel) - value)).toBeLessThan(12);
  }
});

test("rejects an invalid field from the normal CLI before creating watcher directories", async () => {
  await writeFile(
    config,
    `
version: 1
pipelines:
  gallery:
    watch: input
    output: output
    archive: archive
    failed: failed
    steps:
      - type: resize
        width: 0
        height: 800
      - type: export
        variants: [{ format: webp }]
`,
  );
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const result = spawnSync(process.execPath, [entry, "watch", "--config", config], {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("pipelines.gallery.steps[0].width");
  expect(await readdir(root)).toEqual(["pipelines.yaml"]);
});

test("rejects colliding variant names, overlapping paths and misplaced export", async () => {
  const base = `
version: 1
pipelines:
  gallery:
    watch: input
    output: output
    archive: archive
    failed: failed
    steps:
      - type: export
        variants:
          - { format: webp, name: hero }
`;
  await writeFile(config, base + "          - { format: webp, name: Hero }\n");
  await expect(loadWatchConfig(config)).rejects.toThrow(
    "pipelines.gallery.steps[0].variants[1].name",
  );
  await writeFile(config, base.replace("output: output", "output: input/nested"));
  await expect(loadWatchConfig(config)).rejects.toThrow("pipelines.gallery.output");
  await writeFile(config, base + "      - type: normalize\n");
  await expect(loadWatchConfig(config)).rejects.toThrow("pipelines.gallery.steps[0].type");
});

test("cleans the whole staging batch when the second encoder fails", async () => {
  const directories = watchDirectories(root);
  await mkdir(directories.input);
  await copyFile(fixture, join(directories.input, "photo.jpg"));
  const render = createPipelineRenderer([
    {
      type: "export",
      variants: [
        { name: "image", format: "webp", quality: 85 },
        { name: "image", format: "jpeg", quality: 85, background: "#ffffff" },
      ],
    },
  ]);
  let firstEncoded = false;
  service = runWatchFolders(
    [
      {
        directories,
        stabilityMs: 25,
        async render(original, staging) {
          await mkdir(join(staging, "image.jpg"));
          try {
            return await render(original, staging);
          } catch (error) {
            firstEncoded = (await stat(join(staging, "image.webp"))).isFile();
            throw error;
          }
        },
      },
    ],
    1,
    pino({ level: "silent" }),
    shutdown.signal,
    { stateDirectory: join(root, "state"), maxRetries: 0, scanIntervalSeconds: 60 },
  );

  await vi.waitFor(
    async () => {
      const [id] = await readdir(directories.failed);
      if (!id) throw new Error("Waiting for failed original.");
      expect(await readFile(join(directories.failed, id, "original", "photo.jpg"))).toEqual(
        await readFile(fixture),
      );
      expect(await readFile(join(directories.failed, id, "error.json"), "utf8")).toContain(
        "image.jpg",
      );
    },
    { timeout: 4000 },
  );
  expect(firstEncoded).toBe(true);
  expect(await readdir(directories.output)).toEqual([]);
  expect(await readdir(directories.archive)).toEqual([]);
});
