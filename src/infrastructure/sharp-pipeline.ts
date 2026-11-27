import { join } from "node:path";
import sharp from "sharp";
import type { Sharp } from "sharp";
import type { BackgroundRemover } from "../application/background-remover.ts";
import { variantFileName } from "../domain/image-pipeline.ts";
import type { ImageVariant, PipelineStep } from "../domain/image-pipeline.ts";
import type { JobRenderer, RenderedVariant } from "../application/process-watch-job.ts";
import { autoCrop } from "./sharp-auto-crop.ts";
import { applyForeground, materialize, openSharpImage, readRgba } from "./sharp-image.ts";

type Transform = Exclude<PipelineStep, { type: "export" | "copyright" }>;
type StepByType = { [Step in Transform as Step["type"]]: Step };
/** Maps each transformation kind to a handler with the corresponding validated options. */
type StepRegistry = {
  [Name in keyof StepByType]: (image: Sharp, step: StepByType[Name]) => Promise<Sharp>;
};

async function pixelate(image: Sharp, blockSize: number): Promise<Sharp> {
  const { data, raw } = await readRgba(image);
  const width = Math.max(1, Math.ceil(raw.width / blockSize));
  const height = Math.max(1, Math.ceil(raw.height / blockSize));
  const reduced = await materialize(sharp(data, { raw }).resize(width, height, { fit: "fill" }));
  return materialize(reduced.resize(raw.width, raw.height, { fit: "fill", kernel: "nearest" }));
}

async function transformVariant(image: Sharp, variant: ImageVariant): Promise<Sharp> {
  let transformed = image.clone();
  if (variant.resize) {
    transformed = await materialize(
      transformed.resize(variant.resize.width, variant.resize.height, {
        fit: "inside",
        withoutEnlargement: true,
      }),
    );
  }
  if (variant.effects?.blurSigma !== undefined) {
    transformed = await materialize(transformed.blur(variant.effects.blurSigma));
  }
  if (variant.effects?.pixelBlockSize !== undefined) {
    transformed = await pixelate(transformed, variant.effects.pixelBlockSize);
  }
  return transformed;
}

/**
 * Crops around pixels whose alpha is at least 16 out of 255, with a proportional margin
 * clipped to the original bounds. Keeps the frame dimensions if no pixel meets the threshold.
 *
 * @param image - Frame at this step of the pipeline.
 * @param padding - Fraction of the foreground width and height added on each side.
 */
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

/** Encodes a UTF-8 copyright notice without carrying over the source image's metadata. */
function copyrightXmp(text: string): string {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${escaped}</rdf:li></rdf:Alt></dc:rights></rdf:Description></rdf:RDF></x:xmpmeta>`;
}

/** Blends a proportionally sized logo into the current frame using its existing alpha. */
async function watermark(image: Sharp, step: StepByType["watermark"]): Promise<Sharp> {
  if (step.opacity === 0) return image;

  const frame = await readRgba(image);
  const { width, height } = frame.raw;
  const margin = Math.min(step.margin, Math.floor((Math.min(width, height) - 1) / 2));
  const logo = await openSharpImage(step.image);

  const overlay = await readRgba(
    logo
      .autoOrient()
      .resize(
        Math.min(width - 2 * margin, Math.max(1, Math.round(width * step.widthRatio))),
        height - 2 * margin,
        { fit: "inside" },
      ),
  );

  for (let offset = 3; offset < overlay.data.length; offset += 4) {
    overlay.data.writeUInt8(Math.round(overlay.data.readUInt8(offset) * step.opacity), offset);
  }

  const remainingWidth = width - overlay.raw.width;
  const remainingHeight = height - overlay.raw.height;
  const centered = step.position === "center";

  const left = centered
    ? Math.floor(remainingWidth / 2)
    : step.position.endsWith("left")
      ? margin
      : remainingWidth - margin;

  const top = centered
    ? Math.floor(remainingHeight / 2)
    : step.position.startsWith("top")
      ? margin
      : remainingHeight - margin;

  return materialize(
    sharp(frame.data, { raw: frame.raw }).composite([
      { input: overlay.data, raw: overlay.raw, left, top },
    ]),
  );
}

function applyStep<Name extends keyof StepByType>(
  registry: StepRegistry,
  image: Sharp,
  step: StepByType[Name] & { type: Name },
): Promise<Sharp> {
  return registry[step.type](image, step);
}

/**
 * Builds a renderer that completes each transformation in order, then encodes the variants
 * independently from the final frame.
 *
 * @param steps - Validated sequence ending with one export step.
 * @param remover - Foreground estimator used by a background removal step.
 * @returns A renderer that reports every staged file and its encoded dimensions.
 * Source, transformation and encoder failures reject the render. Step errors include the step position.
 */
export function createPipelineRenderer(
  steps: readonly PipelineStep[],
  remover?: BackgroundRemover,
): JobRenderer {
  const registry: StepRegistry = {
    watermark,
    normalize: (image) => materialize(image.autoOrient()),
    "remove-background": (image) => {
      if (!remover) throw new Error("The BEN2 session is not available.");
      return applyForeground(image, remover);
    },
    "auto-crop": autoCrop,
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
    let xmp: string | undefined;

    for (const [index, step] of steps.entries()) {
      try {
        if (step.type === "copyright") {
          xmp = copyrightXmp(step.text);
          continue;
        }

        if (step.type !== "export") {
          image = await applyStep(registry, image, step);
          continue;
        }
        const rendered: RenderedVariant[] = [];
        for (const variant of step.variants) {
          const name = variantFileName(variant);
          let transformed: Sharp;
          try {
            transformed = await transformVariant(image, variant);
          } catch (error) {
            throw new Error(
              `Could not transform "${name}": ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
          try {
            if (xmp !== undefined) transformed.withXmp(xmp);

            const { width, height } = await encode(transformed, variant).toFile(
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
