import sharp from "sharp";
import type { Sharp } from "sharp";
import { planAutoCrop } from "../domain/auto-crop.ts";
import type { AutoCropOptions } from "../domain/auto-crop.ts";
import { detectForegroundBounds } from "../domain/foreground-bounds.ts";
import { materialize, readRgba } from "./sharp-image.ts";

/** Reframes the original pixels around the detected subject. */
export async function autoCrop(image: Sharp, options: AutoCropOptions): Promise<Sharp> {
  if (!options.enabled) return image;

  const { data, raw } = await readRgba(image);
  const decoded = sharp(data, { raw });
  const subject = detectForegroundBounds(data, raw, options);
  if (!subject) return decoded;

  const { extract, extend } = planAutoCrop(raw, subject, options);
  const cropped = decoded.extract(extract);
  return materialize(cropped.extend({ ...extend, background: options.background }));
}
