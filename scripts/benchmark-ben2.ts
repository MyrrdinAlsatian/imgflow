/**
 * @file Reports BEN2 CPU timings and process peak RSS as JSON.
 * Session opening has its own timer. The first image is the cold run, followed by three
 * sequential runs of the same image with the loaded session. Temporary WebPs are removed at exit.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openBen2 } from "../src/infrastructure/ben2.ts";
import { createSharpWebpConverter } from "../src/infrastructure/sharp-webp.ts";

const [inputPath, cache = "models", ...extra] = process.argv.slice(2);
if (!inputPath || !cache || extra.length) {
  console.error("Usage: pnpm bench:ben2 <input-image> [model-cache]");
  process.exitCode = 1;
} else {
  const directory = await mkdtemp(join(tmpdir(), "pixelflow-ben2-bench-"));
  try {
    const loadStart = performance.now();
    const { remove, close } = await openBen2(cache);
    const sessionMs = Math.round(performance.now() - loadStart);
    try {
      /** Time spent in the mask adapter, including preprocessing and mask resizing. */
      let maskPipelineMs = 0;
      const convert = createSharpWebpConverter(async (image) => {
        const start = performance.now();
        const mask = await remove(image);
        maskPipelineMs = Math.round(performance.now() - start);
        return mask;
      });
      const samples = [];
      for (let index = 0; index < 4; index++) {
        const outputPath = join(directory, `${index}.webp`);
        const start = performance.now();
        const dimensions = await convert({
          inputPath,
          outputPath,
          width: 1600,
          height: 1600,
          quality: 85,
        });
        const conversionMs = Math.round(performance.now() - start);
        samples.push({
          run: index === 0 ? "cold" : "warm",
          ...dimensions,
          maskPipelineMs,
          conversionMs,
          webpBytes: (await stat(outputPath)).size,
        });
      }
      console.log(
        JSON.stringify(
          {
            platform: process.platform,
            arch: process.arch,
            cpu: cpus()[0]?.model,
            logicalCpus: availableParallelism(),
            node: process.version,
            sessionMs,
            peakRssKiB: process.resourceUsage().maxRSS,
            samples,
          },
          null,
          2,
        ),
      );
    } finally {
      await close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
