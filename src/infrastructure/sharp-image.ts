import { stat } from "node:fs/promises";
import sharp from "sharp";
import type { Sharp } from "sharp";
import type { BackgroundRemover } from "../application/background-remover.ts";

const supportedFormats = new Set(["jpeg", "png", "webp"]);
const inputPixelLimit = 64_000_000;
const maskSize = 1024;

// Release input file handles before the watcher moves originals on Windows.
sharp.cache({ files: 0 });

/**
 * Checks that the source is a regular, single-frame JPEG, PNG or WebP within the input pixel limit.
 *
 * @param inputPath - Path to the source image.
 * @returns A Sharp pipeline that can still fail when an operation decodes the pixels.
 * @throws If the source is inaccessible or its headers are invalid or unsupported.
 */
export async function openSharpImage(inputPath: string): Promise<Sharp> {
  if (!(await stat(inputPath)).isFile()) {
    throw new Error(`Input must be a regular file: "${inputPath}".`);
  }
  const image = sharp(inputPath, { failOn: "warning", limitInputPixels: inputPixelLimit });
  const metadata = await image.metadata().catch((error: unknown) => {
    throw new Error(
      `Could not read image "${inputPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  if (!supportedFormats.has(metadata.format) || (metadata.pages ?? 1) !== 1) {
    throw new Error(`Input must be a single-frame JPEG, PNG or WebP: "${inputPath}".`);
  }
  return image;
}

/**
 * Executes pending Sharp operations and returns packed sRGB pixels and their actual dimensions.
 * The buffer has four bytes per pixel in RGBA order. Pixels without source alpha become opaque.
 */
export async function readRgba(image: Sharp) {
  const { data, info } = await image
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: 4 } as const;
  return { data, raw };
}

/**
 * Runs inference on a bounded RGB frame, scales the mask back, and multiplies it with the
 * image's alpha so inference never makes a pixel more opaque.
 *
 * @param image - Pipeline whose pending transformations determine the output frame.
 * @param remove - Estimator that returns one opacity byte per inference pixel.
 * @returns A Sharp pipeline over the masked pixels at the input frame's materialized dimensions.
 * @throws If decoding or inference fails, or the mask length differs from the pixel count.
 */
export async function applyForeground(image: Sharp, remove: BackgroundRemover): Promise<Sharp> {
  const { data: pixels, raw } = await readRgba(image);
  const { width, height } = raw;
  const rgb = await sharp(pixels, { raw })
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
  return sharp(pixels, { raw });
}
