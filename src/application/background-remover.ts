/** A tightly packed RGB image in row-major order, with three bytes per pixel. */
export type RgbImage = Readonly<{
  width: number;
  height: number;
  pixels: Uint8Array;
}>;

/**
 * Estimates foreground opacity for each pixel of an oriented image.
 * Returns one byte per input pixel in row-major order. Zero is transparent, 255 is opaque.
 */
export type BackgroundRemover = (image: RgbImage) => Promise<Uint8Array>;
