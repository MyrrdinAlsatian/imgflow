import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createSharpWebpConverter } from "../src/infrastructure/sharp-webp.ts";

const entryPoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pixelflow-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function run(input: string, output: string, ...options: string[]) {
  const result = spawnSync(process.execPath, [entryPoint, "process", input, output, ...options], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

test("orients and resizes the JPEG, strips metadata and preserves the original", async () => {
  const input = join(directory, "photo originale.jpg");
  await copyFile(join(fixtures, "oriented.jpg"), input);
  const original = await readFile(input);
  const originalMetadata = await sharp(original).metadata();
  expect(originalMetadata.orientation).toBe(6);
  expect(originalMetadata.exif).toBeDefined();
  expect(originalMetadata.icc).toBeDefined();
  expect(originalMetadata.xmp).toBeDefined();

  const result = run("photo originale.jpg", "photo web.webp", "--width", "30", "--height", "40");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("20x40");
  expect(await readFile(input)).toEqual(original);

  const output = sharp(await readFile(join(directory, "photo web.webp")));
  const metadata = await output.metadata();
  expect(metadata).toMatchObject({ format: "webp", width: 20, height: 40 });
  expect(metadata.orientation).toBeUndefined();
  expect(metadata.exif).toBeUndefined();
  expect(metadata.icc).toBeUndefined();
  expect(metadata.xmp).toBeUndefined();

  const { data, info } = await output.raw().toBuffer({ resolveWithObject: true });
  const pixelAt = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    return data.subarray(offset, offset + 3);
  };
  const quadrants = [
    { x: 4, y: 8, bright: [2], dark: [0, 1] },
    { x: 15, y: 8, bright: [0], dark: [1, 2] },
    { x: 4, y: 31, bright: [0, 1], dark: [2] },
    { x: 15, y: 31, bright: [1], dark: [0, 2] },
  ];
  for (const { x, y, bright, dark } of quadrants) {
    const pixel = pixelAt(x, y);
    for (const channel of bright) expect(pixel[channel]).toBeGreaterThan(175);
    for (const channel of dark) expect(pixel[channel]).toBeLessThan(75);
  }
});

test("preserves PNG transparency without enlarging the image", async () => {
  const result = run(join(fixtures, "transparent.png"), "small.webp", "--quality", "90");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);

  const { data, info } = await sharp(await readFile(join(directory, "small.webp")))
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 9, height: 6, channels: 4 });
  expect(data[3]).toBe(128);
});

test("combines a soft foreground mask with existing transparency", async () => {
  const inputPath = join(fixtures, "transparent.png");
  const outputPath = join(directory, "foreground.webp");
  const convert = createSharpWebpConverter(async ({ width, height, pixels }) => {
    expect([width, height, pixels.length]).toEqual([9, 6, 9 * 6 * 3]);
    const mask = new Uint8Array(width * height).fill(255);
    mask.set([0, 128]);
    return mask;
  });

  await convert({ inputPath, outputPath, width: 1600, height: 1600, quality: 90 });

  const rgba = await sharp(await readFile(outputPath))
    .raw()
    .toBuffer();
  expect([rgba[3], rgba[7], rgba[11]]).toEqual([0, 64, 128]);
});

test("resizes the model mask to the output dimensions without changing the framing", async () => {
  const inputPath = join(directory, "wide.png");
  const outputPath = join(directory, "foreground.webp");
  await sharp({
    create: { width: 1040, height: 32, channels: 3, background: "orange" },
  })
    .png()
    .toFile(inputPath);
  const convert = createSharpWebpConverter(async ({ width, height }) => {
    expect(width).toBe(1024);
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) mask.fill(255, y * width + width / 2, (y + 1) * width);
    return mask;
  });

  await convert({ inputPath, outputPath, width: 1200, height: 100, quality: 85 });

  const { data, info } = await sharp(await readFile(outputPath))
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 1040, height: 32, channels: 4 });
  expect([data[3], data[1039 * 4 + 3]]).toEqual([0, 255]);
});

test("reports a missing BEN2 cache without modifying the source or publishing a file", async () => {
  const inputPath = join(directory, "original.jpg");
  await copyFile(join(fixtures, "oriented.jpg"), inputPath);
  const result = run(
    inputPath,
    "foreground.webp",
    "--remove-background",
    "--model-cache",
    join(directory, "models"),
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("BEN2 model file is unavailable");
  expect(await readdir(directory)).toEqual(["original.jpg"]);
  expect(await readFile(inputPath)).toEqual(await readFile(join(fixtures, "oriented.jpg")));
});

test("rejects a truncated JPEG and removes its staged output", async () => {
  const input = join(directory, "truncated.jpg");
  await copyFile(join(fixtures, "truncated.jpg"), input);
  const original = await readFile(input);
  expect((await sharp(original).metadata()).format).toBe("jpeg");

  const result = run("truncated.jpg", "output.webp");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Could not convert image");
  expect(await readdir(directory)).toEqual(["truncated.jpg"]);
  expect(await readFile(input)).toEqual(original);
});

test("preserves an existing WebP even when it is both the input and output", async () => {
  expect(run(join(fixtures, "transparent.png"), "image.webp").status).toBe(0);
  const original = await readFile(join(directory, "image.webp"));

  const result = run("image.webp", "image.webp");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Output already exists");
  expect(await readdir(directory)).toEqual(["image.webp"]);
  expect(await readFile(join(directory, "image.webp"))).toEqual(original);
});

test("rejects invalid dimensions before publishing an output", async () => {
  const result = run(join(fixtures, "oriented.jpg"), "output.webp", "--height", "0");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("height must be an integer");
  expect(await readdir(directory)).toEqual([]);
});
