/** @file CLI entry point for one-shot conversion and watch folder lifecycle management. */

import { extname } from "node:path";
import { parseArgs } from "node:util";
import { processImage, validateWebpSettings } from "./application/process-image.ts";

const webpOptions = "[--width 1600] [--height 1600] [--quality 85]";
const usage = [
  "Usage:",
  `  pixelflow process <input> <output.webp> ${webpOptions}`,
  `  pixelflow watch [data-directory] ${webpOptions} [--stability-ms 2000]`,
].join("\n");
const [command, ...args] = process.argv.slice(2);

try {
  if (command === undefined) {
    console.log("PixelFlow foundation is ready.");
  } else if (command === "--help") {
    console.log(usage);
  } else if (command === "process" || command === "watch") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        width: { type: "string", default: "1600" },
        height: { type: "string", default: "1600" },
        quality: { type: "string", default: "85" },
        ...(command === "watch"
          ? { "stability-ms": { type: "string" as const, default: "2000" } }
          : {}),
      },
    });
    const settings = {
      width: Number(values.width),
      height: Number(values.height),
      quality: Number(values.quality),
    };

    if (command === "process") {
      const [inputPath, outputPath] = positionals;
      if (!inputPath || !outputPath || positionals.length !== 2) throw new Error(usage);
      if (extname(outputPath).toLowerCase() !== ".webp") {
        throw new Error("Output path must end in .webp.");
      }
      const { convertWithSharp } = await import("./infrastructure/sharp-webp.ts");
      const { width, height } = await processImage(
        { ...settings, inputPath, outputPath },
        convertWithSharp,
      );
      console.log(`Wrote "${outputPath}" (${width}x${height}).`);
    } else {
      if (positionals.length > 1 || positionals[0] === "") throw new Error(usage);
      const stabilityMs = Number(values["stability-ms"]);
      if (!Number.isInteger(stabilityMs) || stabilityMs < 1 || stabilityMs > 2_147_483_647) {
        throw new Error("stability-ms must be an integer from 1 to 2147483647.");
      }
      validateWebpSettings(settings);

      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        const [{ default: pino }, { runWatchFolder }, { convertWithSharp }] = await Promise.all([
          import("pino"),
          import("./infrastructure/watch-folder.ts"),
          import("./infrastructure/sharp-webp.ts"),
        ]);
        const logger = pino();
        await runWatchFolder(
          { ...settings, root: positionals[0] ?? "data", stabilityMs },
          convertWithSharp,
          logger,
          controller.signal,
        );
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    }
  } else {
    throw new Error(`Unknown command "${command}". ${usage}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
