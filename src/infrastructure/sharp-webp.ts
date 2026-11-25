import { link, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import type { OutputInfo, Sharp } from "sharp";
import type { BackgroundRemover } from "../application/background-remover.ts";
import type { WebpConverter } from "../application/process-image.ts";

const supportedFormats = new Set(["jpeg", "png", "webp"]);
const inputPixelLimit = 64_000_000;
const maskSize = 1024;

// Release input file handles before the watcher moves originals on Windows.
sharp.cache({ files: 0 });

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs inference on a bounded RGB frame, then scales the mask to the output dimensions.
 * Multiplies both alpha values so inference never makes a transparent pixel more opaque.
 *
 * @param image - Sharp pipeline with orientation and output resizing already configured.
 * @param remove - Estimator that returns one opacity byte per inference pixel.
 * @returns A Sharp pipeline for the masked RGBA pixels at the resized image dimensions.
 * @throws If inference fails or the returned mask has the wrong number of pixels.
 */
async function applyForeground(image: Sharp, remove: BackgroundRemover): Promise<Sharp> {
  const { data: pixels, info } = await image
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rgba = { width, height, channels: 4 } as const;
  const rgb = await sharp(pixels, { raw: rgba })
    .resize(maskSize, maskSize, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = await remove({ width: rgb.info.width, height: rgb.info.height, pixels: rgb.data });
  if (mask.length !== rgb.info.width * rgb.info.height) {
    throw new Error("Background remover returned an invalid foreground mask.");
  }
  const opacity =
    rgb.info.width === width && rgb.info.height === height
      ? mask
      : await sharp(mask, { raw: { width: rgb.info.width, height: rgb.info.height, channels: 1 } })
          .resize(width, height, { fit: "fill" })
          .toColourspace("b-w")
          .raw()
          .toBuffer();
  let offset = 3;
  for (const alpha of opacity) {
    pixels[offset] = Math.round((pixels.readUInt8(offset) * alpha) / 255);
    offset += 4;
  }
  return sharp(pixels, { raw: rgba });
}

/**
 * Creates a WebP converter for single-frame JPEG, PNG or WebP files.
 * Applies EXIF orientation before resizing, preserves alpha and strips source metadata.
 *
 * @param remover - Optional alpha estimator invoked after orientation and resizing, before encoding.
 * @returns A converter that reports dimensions after the complete WebP is published.
 */
export const createSharpWebpConverter =
  (remover?: BackgroundRemover): WebpConverter =>
  async ({ inputPath, outputPath, width, height, quality }) => {
    if (!(await stat(inputPath)).isFile()) {
      throw new Error(`Input must be a regular file: "${inputPath}".`);
    }

    const image = sharp(inputPath, { failOn: "warning", limitInputPixels: inputPixelLimit });
    const metadata = await image.metadata().catch((error: unknown) => {
      throw new Error(`Could not read image "${inputPath}": ${describe(error)}`, { cause: error });
    });
    if (!supportedFormats.has(metadata.format) || (metadata.pages ?? 1) !== 1) {
      throw new Error(`Input must be a single-frame JPEG, PNG or WebP: "${inputPath}".`);
    }

    // Stage beside the destination so both paths are on the same filesystem.
    const staging = await mkdtemp(join(dirname(outputPath), ".pixelflow-"));
    const candidate = join(staging, "image.webp");
    try {
      // Inspecting metadata reads headers. Encoding also catches errors in the pixel data.
      let dimensions: OutputInfo;
      try {
        const oriented = image
          .autoOrient()
          .resize(width, height, { fit: "inside", withoutEnlargement: true });
        const rendered = remover ? await applyForeground(oriented, remover) : oriented;
        dimensions = await rendered.webp({ quality }).toFile(candidate);
      } catch (error) {
        throw new Error(`Could not convert image "${inputPath}": ${describe(error)}`, {
          cause: error,
        });
      }

      try {
        // A hard link publishes the completed file and atomically rejects an existing destination.
        await link(candidate, outputPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new Error(`Output already exists: "${outputPath}".`, { cause: error });
        }
        throw error;
      }
      return { width: dimensions.width, height: dimensions.height };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };

/** Runs the WebP pipeline with the original alpha and without model inference. */
export const convertWithSharp = createSharpWebpConverter();
