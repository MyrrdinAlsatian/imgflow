import PQueue from "p-queue";
import pino from "pino";
import type { BackgroundRemover } from "../application/background-remover.ts";
import { variantFileName } from "../domain/image-pipeline.ts";
import { createPipelineRenderer } from "./sharp-pipeline.ts";
import { loadWatchConfig } from "./watch-config.ts";
import { runWatchFolders } from "./watch-folder.ts";

/**
 * Validates the YAML and starts every configured folder. Pipelines that remove backgrounds
 * share one local BEN2 session, with one inference at a time.
 *
 * @param file - YAML configuration file to load before starting any watchers.
 * @param shutdown - Signal to stop admissions and finish jobs already in progress.
 * @returns Resolves after watcher shutdown and release of the model session, when loaded.
 * @throws On invalid configuration, model initialization failure or a watch service error.
 */
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
        outputNames: steps.flatMap((step) =>
          step.type === "export" ? step.variants.map(variantFileName) : [],
        ),
        stabilityMs: settings.stabilityMs,
        render: createPipelineRenderer(steps, remove),
      })),
      settings.concurrency,
      pino({ level: settings.logLevel }),
      shutdown,
      settings,
    );
  } finally {
    await model?.close();
  }
}
