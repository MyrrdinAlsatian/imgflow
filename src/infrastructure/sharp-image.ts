import { stat } from "node:fs/promises";
import sharp from "sharp";
import type { Sharp } from "sharp";
import type { BackgroundRemover } from "../application/background-remover.ts";
import { maxImagePixels } from "../domain/image.ts";

const supportedFormats = new Set(["jpeg", "png", "webp"]);
const inputPixelLimit = maxImagePixels;
const maskSize = 1024;

type ImageReadFailure = { message: string; cause: unknown };

function parseImageReadFailure(error: unknown): ImageReadFailure {
  return { message: error instanceof Error ? error.message : String(error), cause: error };
}

function imageReadError(source: string, failure: ImageReadFailure): Error {
  return new Error(`Could not read image ${source}: ${failure.message}`, { cause: failure.cause });
}

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

  return openImage(inputPath);
}

async function openImage(input: string | Buffer, expectedFormat?: string): Promise<Sharp> {
  const image = sharp(input, { failOn: "warning", limitInputPixels: inputPixelLimit });
  const source = Buffer.isBuffer(input) ? "upload" : `"${input}"`;

  const metadata = await image.metadata().catch((error: unknown) => {
    throw imageReadError(source, parseImageReadFailure(error));
  });

  if (!supportedFormats.has(metadata.format) || (metadata.pages ?? 1) !== 1) {
    throw new Error(`Input must be a single-frame JPEG, PNG or WebP: ${source}.`);
  }

  if (expectedFormat && metadata.format !== expectedFormat) {
    throw new Error("The image format does not match the declared media type.");
  }

  return image;
}

/** Verifies the declared format and decodes all pixels before an upload is admitted. */
export async function validateImageUpload(data: Buffer, format: string): Promise<void> {
  const image = await openImage(data, format);
  await image.stats();
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

/** Completes pending operations so Sharp cannot reorder two configured steps. */
export async function materialize(image: Sharp): Promise<Sharp> {
  const { data, raw } = await readRgba(image);

  return sharp(data, { raw });
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
