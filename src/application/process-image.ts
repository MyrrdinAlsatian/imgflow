/** Parameters for converting a local image to WebP. */
export type WebpRequest = Readonly<{
  /** Source path. The converter must preserve the original bytes. */
  inputPath: string;
  /** Final destination. The converter must reject an existing file at this path. */
  outputPath: string;
  /** Maximum width in pixels after applying EXIF orientation, from 1 to 16,383. */
  width: number;
  /** Maximum height in pixels after applying EXIF orientation, from 1 to 16,383. */
  height: number;
  /** WebP encoder quality, from 1 to 100. */
  quality: number;
}>;

/** Actual dimensions of the published WebP in pixels. */
export type ImageDimensions = Readonly<{ width: number; height: number }>;

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

/** Checks the numerical options shared by single conversions and watch folders. */
export function validateWebpSettings(
  settings: Pick<WebpRequest, "width" | "height" | "quality">,
): void {
  for (const [name, value, max] of [
    ["width", settings.width, 16_383],
    ["height", settings.height, 16_383],
    ["quality", settings.quality, 100],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`${name} must be an integer from 1 to ${max}.`);
    }
  }
}
