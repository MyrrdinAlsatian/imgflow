import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { BackgroundRemover } from "../src/application/background-remover.ts";
import { readRgba } from "../src/infrastructure/sharp-image.ts";
import { createPipelineRenderer } from "../src/infrastructure/sharp-pipeline.ts";
import { loadWatchConfig } from "../src/infrastructure/watch-config.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelflow-auto-crop-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function writeConfig(steps: string) {
  const path = join(root, "pipeline.yaml");
  await writeFile(
    path,
    `version: 1
pipelines:
  photos:
    watch: input
    output: output
    archive: archive
    failed: failed
    steps:
${steps}
      - type: export
        variants:
          - format: png
`,
  );
  return path;
}

async function renderCrop(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
  steps: string,
  remover?: BackgroundRemover,
) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  const source = join(root, "source.png");
  await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(source);
  const config = await loadWatchConfig(await writeConfig(steps));
  const staging = join(root, "staging");
  await mkdir(staging);
  await createPipelineRenderer(config.pipelines[0]!.steps, remover)(source, staging);
  const result = await readRgba(sharp(join(staging, "image.png")));
  return {
    width: result.raw.width,
    height: result.raw.height,
    pixel: (x: number, y: number) => {
      const offset = (y * result.raw.width + x) * 4;
      return Array.from(result.data.subarray(offset, offset + 4));
    },
  };
}

const defaultStep = "      - type: auto-crop";

test("centers a white subject at the edge, preserves its alpha and ignores a distant speck", async () => {
  const result = await renderCrop(
    50,
    40,
    (x, y) => {
      if ((x < 12 && y < 20) || (x === 49 && y === 39)) return [255, 255, 255, 255];
      if (x === 12 && y === 5) return [255, 255, 255, 96];
      if (x === 13 && y === 5) return [255, 255, 255, 8];
      return [0, 0, 0, 0];
    },
    defaultStep,
  );
  expect([result.width, result.height]).toEqual([27, 27]);
  expect(result.pixel(0, 0)[3]).toBe(0);
  expect(result.pixel(6, 3)).toEqual([255, 255, 255, 255]);
  expect(result.pixel(17, 22)).toEqual([255, 255, 255, 255]);
  expect(result.pixel(18, 8)).toEqual([255, 255, 255, 96]);
  expect(result.pixel(19, 8)).toEqual([255, 255, 255, 8]);
});

test("uses white detection when alpha cannot delimit the subject and extends with the configured color", async () => {
  const result = await renderCrop(
    24,
    24,
    (x, y) => {
      if (x >= 6 && x < 15 && y < 4) return [30, 60, 90, 255];
      if (x === 23 && y === 23) return [245, 245, 245, 255];
      if (x === 0 && y === 23) return [255, 255, 255, 254];
      return [255, 255, 255, 255];
    },
    `${defaultStep}
        aspectRatio: "4:5"
        padding: 0
        alignment: bottom
        background: "#224466"`,
  );
  expect([result.width, result.height]).toEqual([12, 15]);
  expect(result.pixel(0, 0)).toEqual([34, 68, 102, 255]);
  expect(result.pixel(1, 10)).toEqual([30, 60, 90, 255]);
  expect(result.pixel(0, 10)).toEqual([255, 255, 255, 255]);
});

test("applies per-side padding with default margins for omitted sides", async () => {
  const result = await renderCrop(
    50,
    40,
    (x, y) => (x >= 20 && x < 30 && y >= 11 && y < 21 ? [255, 255, 255, 255] : [0, 0, 0, 0]),
    `${defaultStep}
        alignment: bottom
        padding:
          left: 0.25
          right: 0.5
          bottom: 0`,
  );
  expect([result.width, result.height]).toEqual([21, 21]);
  expect(result.pixel(4, 10)[3]).toBe(255);
  expect(result.pixel(13, 19)[3]).toBe(255);
  expect(result.pixel(13, 20)[3]).toBe(0);

  const { pipelines } = await loadWatchConfig(join(root, "pipeline.yaml"));
  expect(pipelines[0]?.steps[0]).toMatchObject({
    padding: { top: 0.1, right: 0.5, bottom: 0, left: 0.25 },
  });
});

test.each([
  { label: "transparent frame", steps: defaultStep, pixel: [0, 0, 0, 0] },
  { label: "opaque white frame", steps: defaultStep, pixel: [255, 255, 255, 255] },
  {
    label: "disabled step",
    steps: `${defaultStep}\n        enabled: false`,
    pixel: [0, 0, 0, 255],
  },
] as const)("preserves the dimensions and pixels for $label", async ({ steps, pixel }) => {
  const result = await renderCrop(12, 8, () => pixel, steps);
  expect([result.width, result.height]).toEqual([12, 8]);
  expect(result.pixel(0, 0)).toEqual(pixel);
});

test("uses the preceding background-removal mask and passes the crop to the next resize", async () => {
  const result = await renderCrop(
    60,
    40,
    () => [255, 255, 255, 255],
    `      - type: normalize
      - type: remove-background
        model: ben2
${defaultStep}
      - type: resize
        width: 20
        height: 20`,
    async ({ width, height }) => {
      const mask = new Uint8Array(width * height);
      for (let y = 5; y < 23; y++) mask.fill(255, y * width + 35, y * width + 59);
      return mask;
    },
  );
  expect([result.width, result.height]).toEqual([20, 20]);
  expect(result.pixel(10, 10)).toEqual([255, 255, 255, 255]);
  expect(result.pixel(0, 0)[3]).toBe(0);
});

test.each([
  ["aspectRatio", '"4:0"'],
  ["aspectRatio", '"16383:16382"'],
  ["analysisResolution", "2049"],
  ["alphaThreshold", "0"],
  ["minComponentAreaRatio", "1.1"],
  ["padding", "{ bottom: -0.1 }"],
  ["padding", "{ middle: 0 }"],
])("rejects an invalid YAML value for %s", async (field, value) => {
  const path = await writeConfig(`${defaultStep}\n        ${field}: ${value}`);
  await expect(loadWatchConfig(path)).rejects.toThrow(`pipelines.photos.steps[0].${field}`);
});
