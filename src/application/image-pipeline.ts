/**
 * Encoder settings for a variant of the transformed image.
 * The name is a portable filename stem. JPEG uses its background color to flatten transparency.
 */
export type ImageVariant =
  | Readonly<{ format: "webp" | "avif"; name: string; quality: number }>
  | Readonly<{ format: "png"; name: string; compressionLevel: number }>
  | Readonly<{ format: "jpeg"; name: string; quality: number; background: string }>;

/**
 * A validated step in a pipeline's execution order, discriminated by `type`.
 * Normalization, when present, comes first. The final export encodes every variant from the
 * same transformed image. Trim padding is a fraction of the foreground bounds on each axis.
 */
export type PipelineStep =
  | Readonly<{ type: "normalize" }>
  | Readonly<{ type: "remove-background"; model: "ben2" }>
  | Readonly<{ type: "trim"; padding: number }>
  | Readonly<{
      type: "resize";
      width: number;
      height: number;
      fit: "inside" | "contain" | "cover";
      background: string;
    }>
  | Readonly<{ type: "export"; variants: readonly ImageVariant[] }>;

/** Returns the filename used for both collision detection and encoding, including `.jpg` for JPEG. */
export function variantFileName(variant: ImageVariant): string {
  return `${variant.name}.${variant.format === "jpeg" ? "jpg" : variant.format}`;
}
