import { join } from "node:path";
import sharp from "sharp";
import type { Sharp } from "sharp";
import type { BackgroundRemover } from "../application/background-remover.ts";
import { variantFileName } from "../application/image-pipeline.ts";
import type { ImageVariant, PipelineStep } from "../application/image-pipeline.ts";
import type { JobRenderer, RenderedVariant } from "../application/process-watch-job.ts";
import { applyForeground, openSharpImage, readRgba } from "./sharp-image.ts";

type Transform = Exclude<PipelineStep, { type: "export" }>;
type StepByType = { [Step in Transform as Step["type"]]: Step };
type StepRegistry = {
  [Name in keyof StepByType]: (image: Sharp, step: StepByType[Name]) => Promise<Sharp>;
};

/** Completes an operation before the next step so Sharp cannot reorder two configured steps. */
async function materialize(image: Sharp): Promise<Sharp> {
  const { data, raw } = await readRgba(image);
  return sharp(data, { raw });
}

/** Crops to the foreground bounds, retaining the configured margin within the image. */
async function trimForeground(image: Sharp, padding: number): Promise<Sharp> {
  const { data, raw } = await readRgba(image);
  const { width, height } = raw;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data.readUInt8((y * width + x) * 4 + 3) < 16) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = y;
    }
  }
  const decoded = sharp(data, { raw });
  if (right < 0) return decoded;
  const padX = Math.ceil((right - left + 1) * padding);
  const padY = Math.ceil((bottom - top + 1) * padding);
  left = Math.max(0, left - padX);
  top = Math.max(0, top - padY);
  right = Math.min(width - 1, right + padX);
  bottom = Math.min(height - 1, bottom + padY);
  if (left === 0 && top === 0 && right === width - 1 && bottom === height - 1) return decoded;
  return materialize(
    decoded.extract({ left, top, width: right - left + 1, height: bottom - top + 1 }),
  );
}

function encode(image: Sharp, variant: ImageVariant): Sharp {
  switch (variant.format) {
    case "webp":
      return image.webp({ quality: variant.quality });
    case "avif":
      return image.avif({ quality: variant.quality });
    case "png":
      return image.png({ compressionLevel: variant.compressionLevel });
    case "jpeg":
      return image.flatten({ background: variant.background }).jpeg({ quality: variant.quality });
  }
}

function applyStep<Name extends keyof StepByType>(
  registry: StepRegistry,
  image: Sharp,
  step: StepByType[Name] & { type: Name },
): Promise<Sharp> {
  return registry[step.type](image, step);
}

/** Compiles a validated pipeline into a renderer that writes only to its staging directory. */
export function createPipelineRenderer(
  steps: readonly PipelineStep[],
  remover?: BackgroundRemover,
): JobRenderer {
  const registry: StepRegistry = {
    normalize: (image) => materialize(image.autoOrient()),
    "remove-background": (image) => {
      if (!remover) throw new Error("The BEN2 session is not available.");
      return applyForeground(image, remover);
    },
    trim: (image, { padding }) => trimForeground(image, padding),
    resize: (image, { width, height, fit, background }) =>
      materialize(
        image.resize(width, height, {
          fit,
          background,
          withoutEnlargement: fit === "inside",
        }),
      ),
  };

  return async (inputPath, staging) => {
    let image = await openSharpImage(inputPath);
    for (const [index, step] of steps.entries()) {
      try {
        if (step.type !== "export") {
          image = await applyStep(registry, image, step);
          continue;
        }
        const rendered: RenderedVariant[] = [];
        for (const variant of step.variants) {
          const name = variantFileName(variant);
          try {
            const { width, height } = await encode(image.clone(), variant).toFile(
              join(staging, name),
            );
            rendered.push({ name, dimensions: { width, height } });
          } catch (error) {
            throw new Error(
              `Could not encode "${name}": ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
        }
        return rendered;
      } catch (error) {
        throw new Error(
          `Step ${index + 1} (${step.type}) failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    throw new Error("Pipeline did not export any variants.");
  };
}
