import type { AutoCropOptions, PixelBounds } from "./auto-crop.ts";
import type { ImageDimensions } from "./image.ts";

type DetectionOptions = Pick<
  AutoCropOptions,
  | "detectionMode"
  | "alphaThreshold"
  | "colorTolerance"
  | "analysisResolution"
  | "removeArtifacts"
  | "minComponentAreaRatio"
>;

function hasAlphaBackground(pixels: Uint8Array, threshold: number): boolean {
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if (pixels[offset]! < threshold) return true;
  }
  return false;
}

function union(first: PixelBounds | undefined, second: PixelBounds): PixelBounds {
  if (!first) return second;
  return {
    left: Math.min(first.left, second.left),
    top: Math.min(first.top, second.top),
    right: Math.max(first.right, second.right),
    bottom: Math.max(first.bottom, second.bottom),
  };
}

/** Labels 8-connected components with a reusable queue and retains all qualifying bounds. */
function significantBounds(
  mask: Uint8Array,
  { width, height }: ImageDimensions,
  minArea: number,
): PixelBounds | undefined {
  let retained: PixelBounds | undefined;
  let largest: PixelBounds | undefined;
  let largestArea = 0;
  const queue = new Uint32Array(mask.length);
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] === 0) continue;
    mask[index] = 0;
    queue[0] = index;
    let area = 1;
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;
    for (let cursor = 0; cursor < area; cursor++) {
      const pixel = queue[cursor]!;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
      for (let row = Math.max(0, y - 1); row <= Math.min(height - 1, y + 1); row++) {
        for (let col = Math.max(0, x - 1); col <= Math.min(width - 1, x + 1); col++) {
          const neighbour = row * width + col;
          if (mask[neighbour] === 0) continue;
          mask[neighbour] = 0;
          queue[area++] = neighbour;
        }
      }
    }
    const bounds = { left, top, right, bottom };
    if (area >= minArea) retained = union(retained, bounds);
    if (area > largestArea) {
      largest = bounds;
      largestArea = area;
    }
  }
  return retained ?? largest;
}

/** Detects subject bounds in packed 8-bit RGBA pixels using a bounded foreground mask. */
export function detectForegroundBounds(
  pixels: Uint8Array,
  image: ImageDimensions,
  options: DetectionOptions,
): PixelBounds | undefined {
  const useAlpha =
    options.detectionMode === "alpha" ||
    (options.detectionMode === "auto" && hasAlphaBackground(pixels, options.alphaThreshold));
  const whiteThreshold = 255 - options.colorTolerance;
  const scale = Math.min(1, options.analysisResolution / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const sourceX = (x: number) => Math.ceil((x * image.width) / width);
  const sourceY = (y: number) => Math.ceil((y * image.height) / height);
  const mask = new Uint8Array(width * height);
  let left = width;
  let right = 0;
  let top = height;
  let bottom = 0;

  // A single foreground pixel activates its cell, even when a thin feature would vanish on resize.
  for (let y = 0; y < height; y++) {
    const firstRow = sourceY(y);
    const endRow = sourceY(y + 1);
    for (let x = 0; x < width; x++) {
      const firstColumn = sourceX(x);
      const endColumn = sourceX(x + 1);
      cell: for (let row = firstRow; row < endRow; row++) {
        let offset = (row * image.width + firstColumn) * 4;
        for (let col = firstColumn; col < endColumn; col++, offset += 4) {
          const opacity = pixels[offset + 3]!;
          const foreground = useAlpha
            ? opacity >= options.alphaThreshold
            : opacity > 0 &&
              (pixels[offset]! < whiteThreshold ||
                pixels[offset + 1]! < whiteThreshold ||
                pixels[offset + 2]! < whiteThreshold);
          if (!foreground) continue;
          mask[y * width + x] = 1;
          left = Math.min(left, x);
          right = Math.max(right, x + 1);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
          break cell;
        }
      }
    }
  }
  if (right === 0) return undefined;
  const bounds =
    options.removeArtifacts && options.minComponentAreaRatio > 0
      ? significantBounds(mask, { width, height }, mask.length * options.minComponentAreaRatio)
      : { left, top, right, bottom };
  if (!bounds) return undefined;

  // Allow one analysis cell around the detected foreground for faint edges and quantization.
  return {
    left: sourceX(Math.max(0, bounds.left - 1)),
    top: sourceY(Math.max(0, bounds.top - 1)),
    right: sourceX(Math.min(width, bounds.right + 1)),
    bottom: sourceY(Math.min(height, bounds.bottom + 1)),
  };
}
