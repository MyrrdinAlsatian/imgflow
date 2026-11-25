import { link, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import type { WebpConverter } from "../application/process-image.ts";

const supportedFormats = new Set(["jpeg", "png", "webp"]);
const inputPixelLimit = 64_000_000;

// Release input file handles before the watcher moves originals on Windows.
sharp.cache({ files: 0 });

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Encodes a single-frame JPEG, PNG or WebP within the requested bounds.
 * Applies EXIF orientation before resizing, preserves alpha and strips source metadata.
 *
 * @returns The encoded width and height after the complete WebP is published.
 * @throws If the input is unreadable, unsupported or corrupt, or if encoding or publication fails.
 */
export const convertWithSharp: WebpConverter = async ({
  inputPath,
  outputPath,
  width,
  height,
  quality,
}) => {
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
    const dimensions = await image
      .autoOrient()
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toFile(candidate)
      .catch((error: unknown) => {
        throw new Error(`Could not convert image "${inputPath}": ${describe(error)}`, {
          cause: error,
        });
      });

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
