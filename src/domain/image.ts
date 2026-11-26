/** Largest width or height accepted by the WebP and AVIF encoders. */
export const maxImageDimension = 16_383;
/** Largest encoder quality for lossy formats. */
export const maxImageQuality = 100;
/** Largest decoded input or generated resize canvas, in pixels. */
export const maxImagePixels = 64_000_000;

/** Bounds for the Gaussian blur effect sigma. */
export const blurSigmaRange = Object.freeze({ min: 0.3, max: 100 });
/** Bounds for the pixelation block size, in pixels. */
export const pixelBlockSizeRange = Object.freeze({ min: 2, max: 512 });

/** Actual dimensions of an image in pixels. */
export type ImageDimensions = Readonly<{ width: number; height: number }>;

/** Maximum output dimensions and encoder quality for a WebP conversion. */
export type WebpSettings = Readonly<{
  /** Maximum width in pixels after applying EXIF orientation, from 1 to 16,383. */
  width: number;
  /** Maximum height in pixels after applying EXIF orientation, from 1 to 16,383. */
  height: number;
  /** WebP encoder quality, from 1 to 100. */
  quality: number;
}>;

/**
 * Checks the numerical options shared by single conversions and watch folders.
 *
 * @throws If a value is not an integer within its bounds.
 */
export function validateWebpSettings(settings: WebpSettings): void {
  for (const [name, value, max] of [
    ["width", settings.width, maxImageDimension],
    ["height", settings.height, maxImageDimension],
    ["quality", settings.quality, maxImageQuality],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`${name} must be an integer from 1 to ${max}.`);
    }
  }
}
