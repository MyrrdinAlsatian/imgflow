/** An oriented RGB frame with no alpha channel or row padding. */
export type RgbImage = Readonly<{
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
  /** Exactly `width * height * 3` bytes in RGB order, row by row from the top left. */
  pixels: Uint8Array;
}>;

/**
 * Estimates foreground opacity for each pixel of an oriented image.
 *
 * @param image - RGB frame at the resolution chosen for inference.
 * @returns A mask aligned to the input frame with one byte per pixel in row-major order.
 * Zero removes the pixel, 255 keeps its existing opacity, and intermediate values soften edges.
 * @throws If inference fails or the model cannot produce a usable mask.
 */
export type BackgroundRemover = (image: RgbImage) => Promise<Uint8Array>;
