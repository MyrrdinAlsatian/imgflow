import PQueue from "p-queue";
import pino from "pino";
import type { BackgroundRemover } from "../application/background-remover.ts";
import { createPipelineRenderer } from "./sharp-pipeline.ts";
import { loadWatchConfig } from "./watch-config.ts";
import { runWatchFolders } from "./watch-folder.ts";

/** Opens the validated YAML pipelines and owns the lifetime of their shared BEN2 session. */
export async function runConfiguredWatch(file: string, shutdown: AbortSignal): Promise<void> {
  const { settings, pipelines } = await loadWatchConfig(file);
  if (shutdown.aborted) return;
  const needsModel = pipelines.some(({ steps }) =>
    steps.some((step) => step.type === "remove-background"),
  );
  const model = needsModel
    ? await (await import("./ben2.ts")).openBen2(settings.modelCache)
    : undefined;
  try {
    // Keep inference serial even if independent image jobs can run concurrently.
    const inference = new PQueue({ concurrency: 1 });
    const remove: BackgroundRemover | undefined = model
      ? (image) => inference.add(() => model.remove(image))
      : undefined;
    await runWatchFolders(
      pipelines.map(({ id, directories, steps }) => ({
        id,
        directories,
        stabilityMs: settings.stabilityMs,
        render: createPipelineRenderer(steps, remove),
      })),
      settings.concurrency,
      pino({ level: settings.logLevel }),
      shutdown,
    );
  } finally {
    await model?.close();
  }
}
