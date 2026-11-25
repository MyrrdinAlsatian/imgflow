import { link, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OutputInfo } from "sharp";
import type { BackgroundRemover } from "../application/background-remover.ts";
import type { WebpConverter } from "../application/process-image.ts";
import { applyForeground, openSharpImage } from "./sharp-image.ts";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    const image = await openSharpImage(inputPath);

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
