import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPipelineRenderer } from "../src/infrastructure/sharp-pipeline.ts";
import { loadWatchConfig } from "../src/infrastructure/watch-config.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelflow-branding-"));
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
          - format: webp
            resize: { width: 20, height: 20 }
          - format: jpeg
          - format: avif
`,
  );

  return path;
}

test("embeds copyright in each export and composites the relative logo with opacity", async () => {
  const source = join(root, "source.png");
  await sharp({ create: { width: 40, height: 30, channels: 4, background: "transparent" } })
    .withXmp("Old metadata")
    .png()
    .toFile(source);
  const original = await readFile(source);
  await sharp({ create: { width: 6, height: 4, channels: 3, background: "red" } })
    .png()
    .toFile(join(root, "logo.png"));

  const file = await writeConfig(`      - type: copyright
        text: "© Atelier & <Éditions>"
      - type: resize
        width: 40
        height: 30
      - type: watermark
        image: ./logo.png
        position: bottom-right
        margin: 2
        widthRatio: 0.3
        opacity: 0.5`);

  const { pipelines } = await loadWatchConfig(file);
  const [pipeline] = pipelines;

  if (!pipeline) throw new Error("Missing pipeline.");
  const staging = join(root, "staging");
  await mkdir(staging);
  await createPipelineRenderer(pipeline.steps)(source, staging);

  for (const extension of ["png", "webp", "jpg", "avif"]) {
    const output = sharp(await readFile(join(staging, `image.${extension}`)));
    const metadata = await output.metadata();
    const xmp = metadata.xmp?.toString("utf8");
    expect(xmp).toContain("<dc:rights>");
    expect(xmp).toContain("© Atelier &amp; &lt;Éditions&gt;");
    expect(xmp).not.toContain("Old metadata");
    expect(metadata.width).toBe(extension === "webp" ? 20 : 40);

    if (extension === "png") {
      const pixels = await output.raw().toBuffer();
      expect(pixels[3]).toBe(0);
      const offset = (25 * 40 + 35) * 4;
      expect([...pixels.subarray(offset, offset + 4)]).toEqual([255, 0, 0, 128]);
      expect(pixels[(25 * 40 + 39) * 4 + 3]).toBe(0);
    }
  }

  expect(await readFile(source)).toEqual(original);
});

test("reports malformed copyright or watermark options at their YAML field", async () => {
  let file = await writeConfig(`      - type: copyright
        text: "   "`);

  await expect(loadWatchConfig(file)).rejects.toThrow("pipelines.photos.steps[0].text");
  file = await writeConfig(`      - type: watermark
        image: ./logo.png
        opacity: 2`);
  await expect(loadWatchConfig(file)).rejects.toThrow("pipelines.photos.steps[0].opacity");
});
