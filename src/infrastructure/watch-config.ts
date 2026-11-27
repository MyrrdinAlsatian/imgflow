import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as v from "valibot";
import { parse } from "yaml";
import {
  autoCropDefaults,
  fitsImageCanvas,
  maxAnalysisResolution,
  reduceAspectRatio,
} from "../domain/auto-crop.ts";
import {
  blurSigmaRange,
  maxImageDimension,
  maxImagePixels,
  maxImageQuality,
  pixelBlockSizeRange,
} from "../domain/image.ts";
import { variantFileName } from "../domain/image-pipeline.ts";
import { defaultMaxRetries, defaultScanIntervalSeconds } from "../domain/job.ts";
import type { WatchDirectories } from "./watch-files.ts";

const pathSchema = v.pipe(
  v.string(),
  v.check((value) => value.trim().length > 0, "Expected a path."),
);
const nameSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "Expected a portable name."),
  v.check((value) => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value), "Name is reserved."),
);
const color = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/i, "Expected an opaque #RRGGBB color."));
const positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const dimension = v.pipe(positive, v.maxValue(maxImageDimension));
const quality = v.pipe(positive, v.maxValue(maxImageQuality));
const proportion = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));
const cropMargin = v.optional(proportion, autoCropDefaults.padding);
const cropPadding = v.union([
  proportion,
  v.strictObject({ top: cropMargin, right: cropMargin, bottom: cropMargin, left: cropMargin }),
]);
const byte = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255));
const backgroundColor = v.union([v.literal("transparent"), color]);
const aspectRatio = v.pipe(
  v.string(),
  v.regex(/^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$/, "Expected a positive integer ratio such as 4:5."),
  v.transform((value) => {
    const [width, height] = value.split(":").map(Number);
    return reduceAspectRatio(width!, height!);
  }),
  v.check(fitsImageCanvas, "The smallest canvas for this ratio exceeds the image limits."),
);
const name = v.optional(nameSchema, "image");
const variantResize = v.strictObject({ width: dimension, height: dimension });
const variantEffects = v.pipe(
  v.strictObject({
    blurSigma: v.optional(
      v.pipe(
        v.number(),
        v.finite(),
        v.minValue(blurSigmaRange.min),
        v.maxValue(blurSigmaRange.max),
      ),
    ),
    pixelBlockSize: v.optional(
      v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(pixelBlockSizeRange.min),
        v.maxValue(pixelBlockSizeRange.max),
      ),
    ),
  }),
  v.check(
    ({ blurSigma, pixelBlockSize }) => blurSigma !== undefined || pixelBlockSize !== undefined,
    "Configure at least one image effect.",
  ),
);
const variantOptions = {
  resize: v.optional(variantResize),
  effects: v.optional(variantEffects),
};

const variant = v.variant("format", [
  v.strictObject({
    format: v.literal("webp"),
    name,
    quality: v.optional(quality, 85),
    ...variantOptions,
  }),
  v.strictObject({
    format: v.literal("avif"),
    name,
    quality: v.optional(quality, 65),
    ...variantOptions,
  }),
  v.strictObject({
    format: v.literal("png"),
    name,
    compressionLevel: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9)), 6),
    ...variantOptions,
  }),
  v.strictObject({
    format: v.literal("jpeg"),
    name,
    quality: v.optional(quality, 85),
    background: v.optional(color, "#ffffff"),
    ...variantOptions,
  }),
]);

const step = v.variant("type", [
  v.strictObject({ type: v.literal("normalize") }),
  v.strictObject({
    type: v.literal("copyright"),
    text: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.check(
        (text) =>
          Array.from(text).every((character) => {
            const code = character.codePointAt(0) ?? 0;

            return (
              code === 9 ||
              code === 10 ||
              code === 13 ||
              (code >= 32 && code <= 0xd7ff) ||
              (code >= 0xe000 && code <= 0xfffd) ||
              code >= 0x10000
            );
          }),
        "Expected text that can be stored in XMP.",
      ),
    ),
  }),
  v.strictObject({
    type: v.literal("watermark"),
    image: pathSchema,
    position: v.optional(
      v.picklist(["top-left", "top-right", "bottom-left", "bottom-right", "center"]),
      "bottom-right",
    ),
    widthRatio: v.optional(
      v.pipe(
        proportion,
        v.check((value) => value > 0, "Expected a positive width ratio."),
      ),
      0.2,
    ),
    opacity: v.optional(proportion, 0.8),
    margin: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0)), 12),
  }),
  v.strictObject({ type: v.literal("remove-background"), model: v.literal("ben2") }),
  v.strictObject({
    type: v.literal("auto-crop"),
    enabled: v.optional(v.boolean(), autoCropDefaults.enabled),
    detectionMode: v.optional(
      v.picklist(["alpha", "white", "auto"]),
      autoCropDefaults.detectionMode,
    ),
    alphaThreshold: v.optional(v.pipe(byte, v.minValue(1)), autoCropDefaults.alphaThreshold),
    colorTolerance: v.optional(byte, autoCropDefaults.colorTolerance),
    aspectRatio: v.optional(aspectRatio, autoCropDefaults.aspectRatio),
    padding: v.optional(cropPadding, autoCropDefaults.padding),
    alignment: v.optional(v.picklist(["center", "top", "bottom"]), autoCropDefaults.alignment),
    background: v.optional(backgroundColor, autoCropDefaults.background),
    analysisResolution: v.optional(
      v.pipe(positive, v.maxValue(maxAnalysisResolution)),
      autoCropDefaults.analysisResolution,
    ),
    removeArtifacts: v.optional(v.boolean(), autoCropDefaults.removeArtifacts),
    minComponentAreaRatio: v.optional(proportion, autoCropDefaults.minComponentAreaRatio),
  }),
  v.strictObject({
    type: v.literal("trim"),
    padding: v.optional(proportion, 0),
  }),
  v.strictObject({
    type: v.literal("resize"),
    width: dimension,
    height: dimension,
    fit: v.optional(v.picklist(["inside", "contain", "cover"]), "inside"),
    background: v.optional(backgroundColor, "transparent"),
  }),
  v.strictObject({
    type: v.literal("export"),
    variants: v.pipe(v.array(variant), v.minLength(1)),
  }),
]);

const settings = v.strictObject({
  concurrency: v.optional(positive, 1),
  stabilityMs: v.optional(v.pipe(positive, v.maxValue(2_147_483_647)), 2000),
  modelCache: v.optional(pathSchema, "models"),
  stateDirectory: v.optional(pathSchema, join("data", "state")),
  logLevel: v.optional(
    v.picklist(["trace", "debug", "info", "warn", "error", "fatal", "silent"]),
    "info",
  ),
  maxRetries: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0)), defaultMaxRetries),
  scanIntervalSeconds: v.optional(
    v.pipe(positive, v.maxValue(2_147_483)),
    defaultScanIntervalSeconds,
  ),
});

const schema = v.strictObject({
  version: v.literal(1),
  settings: v.optional(settings, {}),
  pipelines: v.pipe(
    v.record(
      nameSchema,
      v.strictObject({
        watch: pathSchema,
        output: pathSchema,
        archive: pathSchema,
        failed: pathSchema,
        processing: v.optional(pathSchema),
        steps: v.pipe(v.array(step), v.minLength(1)),
      }),
    ),
    v.check((pipelines) => Object.keys(pipelines).length > 0, "Define at least one pipeline."),
  ),
});

/** Formats a schema issue path with dotted keys and bracketed array indexes. */
function issuePath(issue: v.BaseIssue<unknown>): string {
  const keys = issue.path ?? [];
  return (
    keys
      .map(({ key }, index) =>
        typeof key === "number"
          ? `[${key}]`
          : typeof key === "string"
            ? `${index === 0 ? "" : "."}${key}`
            : "",
      )
      .join("") || "configuration"
  );
}

/** Resolves existing ancestors too, so a symlink cannot hide overlapping directories. */
async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await physicalPath(parent), relative(parent, path));
  }
}

function includesPath(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent === "" ||
    (!isAbsolute(fromParent) && fromParent !== ".." && !fromParent.startsWith(`..${sep}`))
  );
}

/**
 * Parses YAML, applies defaults and validates step order, output names and directory overlaps.
 *
 * @param file - Configuration file. Relative directory and model paths use its parent as their base.
 * @returns Resolved settings and typed pipelines ready for watcher setup.
 * @throws If the file cannot be read, YAML parsing fails or a configuration rule is violated.
 * Validation errors identify the field where possible.
 */
export async function loadWatchConfig(file: string) {
  const path = resolve(file);
  const base = dirname(path);
  try {
    const yaml: unknown = parse(await readFile(path, "utf8"), { uniqueKeys: true });
    const result = v.safeParse(schema, yaml);
    if (!result.success) {
      throw new Error(
        result.issues.map((issue) => `${issuePath(issue)}: ${issue.message}`).join("\n"),
      );
    }

    const stateDirectory = resolve(base, result.output.settings.stateDirectory);
    const directoriesSeen = [
      {
        field: "settings.stateDirectory",
        path: await physicalPath(stateDirectory).catch((error: unknown) => {
          throw new Error(
            `settings.stateDirectory: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }),
      },
    ];
    const pipelines = [];
    for (const [id, pipeline] of Object.entries(result.output.pipelines)) {
      const prefix = `pipelines.${id}`;
      const steps = pipeline.steps;
      for (const [index, current] of steps.entries()) {
        const field = `${prefix}.steps[${index}]`;
        const last = index === steps.length - 1;
        if (last !== (current.type === "export")) {
          throw new Error(`${field}.type: exactly one export step is required at the end.`);
        }
        if (current.type === "normalize" && index !== 0) {
          throw new Error(`${field}.type: normalize can only be the first step.`);
        }
        if (
          current.type === "resize" &&
          current.fit !== "inside" &&
          current.width * current.height > maxImagePixels
        ) {
          throw new Error(`${field}.width: the resize canvas must not exceed 64 million pixels.`);
        }
        if (current.type === "export") {
          const names = new Set<string>();
          for (const [variantIndex, variant] of current.variants.entries()) {
            const fileName = variantFileName(variant).toLowerCase();
            if (names.has(fileName))
              throw new Error(
                `${field}.variants[${variantIndex}].name: duplicate output filename "${fileName}".`,
              );
            names.add(fileName);
          }
        }
      }

      const directoryFields = {
        watch: pipeline.watch,
        processing: pipeline.processing ?? join("data", "processing", id),
        output: pipeline.output,
        archive: pipeline.archive,
        failed: pipeline.failed,
      };
      for (const [key, location] of Object.entries(directoryFields)) {
        const field = `${prefix}.${key}`;
        const canonical = await physicalPath(resolve(base, location)).catch((error: unknown) => {
          throw new Error(`${field}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        });
        const overlap = directoriesSeen.find(
          (entry) => includesPath(entry.path, canonical) || includesPath(canonical, entry.path),
        );
        if (overlap) throw new Error(`${field}: directory overlaps ${overlap.field}.`);
        directoriesSeen.push({ field, path: canonical });
      }
      const directories: WatchDirectories = {
        input: resolve(base, directoryFields.watch),
        processing: resolve(base, directoryFields.processing),
        output: resolve(base, directoryFields.output),
        archive: resolve(base, directoryFields.archive),
        failed: resolve(base, directoryFields.failed),
      };

      pipelines.push({
        id,
        steps: steps.map((current) =>
          current.type === "watermark"
            ? { ...current, image: resolve(base, current.image) }
            : current,
        ),
        directories,
      });
    }
    return {
      settings: {
        ...result.output.settings,
        stateDirectory,
        modelCache: resolve(base, result.output.settings.modelCache),
      },
      pipelines,
    };
  } catch (error) {
    throw new Error(
      `Invalid configuration "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
