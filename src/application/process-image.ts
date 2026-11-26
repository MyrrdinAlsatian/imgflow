import { validateWebpSettings } from "../domain/image.ts";
import type { ImageDimensions, WebpSettings } from "../domain/image.ts";

/** Parameters for converting a local image to WebP. */
export type WebpRequest = WebpSettings &
  Readonly<{
    /** Source path. The converter must preserve the original bytes. */
    inputPath: string;
    /** Final destination. The converter must reject an existing file at this path. */
    outputPath: string;
  }>;

/**
 * Port for reading an input image and publishing its WebP conversion.
 * Resolves with the actual dimensions after publication and rejects on conversion or I/O failure.
 */
export type WebpConverter = (request: WebpRequest) => Promise<ImageDimensions>;

/**
 * Validates conversion settings before passing the request to the injected converter.
 *
 * @param request - Source and destination paths with resize limits and encoder quality.
 * @param convert - Adapter responsible for reading, encoding and publishing the image.
 * @returns The actual dimensions of the published WebP.
 * @throws If a numeric option is invalid or the converter rejects.
 */
export async function processImage(
  request: WebpRequest,
  convert: WebpConverter,
): Promise<ImageDimensions> {
  validateWebpSettings(request);
  return convert(request);
}
