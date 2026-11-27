import { maxImageDimension, maxImagePixels } from "./image.ts";
import type { ImageDimensions } from "./image.ts";

type CropPadding = Readonly<{ top: number; right: number; bottom: number; left: number }>;

export type AutoCropOptions = Readonly<{
  enabled: boolean;
  detectionMode: "alpha" | "white" | "auto";
  alphaThreshold: number;
  colorTolerance: number;
  aspectRatio: ImageDimensions;
  padding: number | CropPadding;
  alignment: "center" | "top" | "bottom";
  background: string;
  analysisResolution: number;
  removeArtifacts: boolean;
  minComponentAreaRatio: number;
}>;

export const autoCropDefaults = Object.freeze({
  enabled: true,
  detectionMode: "auto",
  alphaThreshold: 15,
  colorTolerance: 20,
  aspectRatio: "1:1",
  padding: 0.1,
  alignment: "center",
  background: "transparent",
  analysisResolution: 1024,
  removeArtifacts: true,
  minComponentAreaRatio: 0.001,
} as const);

export const maxAnalysisResolution = 2048;

/** Pixel bounds with exclusive right and bottom edges. */
export type PixelBounds = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/** Reduces a validated positive integer ratio to its smallest whole-pixel canvas. */
export function reduceAspectRatio(width: number, height: number): ImageDimensions {
  let divisor = width;
  let remainder = height;
  while (remainder !== 0) {
    [divisor, remainder] = [remainder, divisor % remainder];
  }
  return { width: width / divisor, height: height / divisor };
}

export function fitsImageCanvas({ width, height }: ImageDimensions): boolean {
  return (
    width <= maxImageDimension && height <= maxImageDimension && width * height <= maxImagePixels
  );
}

/** Fits the padded bounds in the smallest exact-ratio canvas without resampling. */
export function planAutoCrop(
  image: ImageDimensions,
  subject: PixelBounds,
  {
    aspectRatio,
    padding,
    alignment,
  }: Pick<AutoCropOptions, "aspectRatio" | "padding" | "alignment">,
) {
  const subjectWidth = subject.right - subject.left;
  const subjectHeight = subject.bottom - subject.top;
  const margins =
    typeof padding === "number"
      ? { top: padding, right: padding, bottom: padding, left: padding }
      : padding;
  const topPadding = Math.ceil(subjectHeight * margins.top);
  const leftPadding = Math.ceil(subjectWidth * margins.left);
  const paddedWidth = subjectWidth + leftPadding + Math.ceil(subjectWidth * margins.right);
  const paddedHeight = subjectHeight + topPadding + Math.ceil(subjectHeight * margins.bottom);
  const units = Math.ceil(
    Math.max(paddedWidth / aspectRatio.width, paddedHeight / aspectRatio.height),
  );
  const width = units * aspectRatio.width;
  const height = units * aspectRatio.height;
  if (!fitsImageCanvas({ width, height })) {
    throw new Error("The auto-crop canvas exceeds the image dimension or pixel limit.");
  }

  const horizontalSlack = width - paddedWidth;
  const verticalSlack = height - paddedHeight;
  const verticalOffset = { center: Math.floor(verticalSlack / 2), top: 0, bottom: verticalSlack };
  const left = subject.left - leftPadding - Math.floor(horizontalSlack / 2);
  const top = subject.top - topPadding - verticalOffset[alignment];
  const right = left + width;
  const bottom = top + height;
  const extractLeft = Math.max(0, left);
  const extractTop = Math.max(0, top);
  const extractRight = Math.min(image.width, right);
  const extractBottom = Math.min(image.height, bottom);
  return {
    extract: {
      left: extractLeft,
      top: extractTop,
      width: extractRight - extractLeft,
      height: extractBottom - extractTop,
    },
    extend: {
      left: extractLeft - left,
      top: extractTop - top,
      right: right - extractRight,
      bottom: bottom - extractBottom,
    },
  };
}
