/** @file CLI entry point for parsing arguments and composing the image conversion use case. */

import { extname } from "node:path";
import { parseArgs } from "node:util";
import { processImage } from "./application/process-image.ts";

const usage =
  "Usage: pixelflow process <input> <output.webp> [--width 1600] [--height 1600] [--quality 85]";
const [command, ...args] = process.argv.slice(2);

try {
  if (command === undefined) {
    console.log("PixelFlow foundation is ready.");
  } else if (command === "--help") {
    console.log(usage);
  } else if (command === "process") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        width: { type: "string", default: "1600" },
        height: { type: "string", default: "1600" },
        quality: { type: "string", default: "85" },
      },
    });
    const [inputPath, outputPath] = positionals;
    if (!inputPath || !outputPath || positionals.length !== 2) {
      throw new Error(usage);
    }
    if (extname(outputPath).toLowerCase() !== ".webp") {
      throw new Error("Output path must end in .webp.");
    }

    // Load the native adapter only when an image needs processing.
    const { convertWithSharp } = await import("./infrastructure/sharp-webp.ts");
    const { width, height } = await processImage(
      {
        inputPath,
        outputPath,
        width: Number(values.width),
        height: Number(values.height),
        quality: Number(values.quality),
      },
      convertWithSharp,
    );
    console.log(`Wrote "${outputPath}" (${width}x${height}).`);
  } else {
    throw new Error(`Unknown command "${command}". ${usage}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
