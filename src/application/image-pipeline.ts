/** An output configuration and its portable filename stem. */
export type ImageVariant =
  | Readonly<{ format: "webp" | "avif"; name: string; quality: number }>
  | Readonly<{ format: "png"; name: string; compressionLevel: number }>
  | Readonly<{ format: "jpeg"; name: string; quality: number; background: string }>;

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

/** Uses the same extension for collision detection and encoding. */
export function variantFileName(variant: ImageVariant): string {
  return `${variant.name}.${variant.format === "jpeg" ? "jpg" : variant.format}`;
}
