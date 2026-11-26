/** @file Local administrative commands for a PixelFlow watch service. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { jobStatuses } from "./application/job-journal.ts";
import { loadWatchConfig } from "./infrastructure/watch-config.ts";

const journal = "[--state-directory <path> | --config <pipelines.yaml>]";
const usage = [
  "Usage:",
  `  pixelflow admin jobs [--status <status>] [--limit <n>] [--offset <n>] ${journal}`,
  `  pixelflow admin job <id> ${journal}`,
  `  pixelflow admin retry <id> ${journal}`,
  "  pixelflow admin validate <pipelines.yaml>",
  `  pixelflow admin metrics ${journal}`,
].join("\n");

/**
 * Dispatches a local administration command. Help prints usage. Command results go to stdout
 * as JSON. YAML validation and journal queries can run independently of the watcher.
 *
 * @param args - CLI arguments after the `admin` subcommand.
 * @throws If the arguments, configuration or journal operation are invalid.
 * The main entry point reports the diagnostic and sets the exit code.
 */
export async function runAdmin(args: readonly string[]): Promise<void> {
  const [action, ...options] = args;
  if (!action || action === "--help") {
    console.log(usage);
    return;
  }
  if (action === "validate") {
    const { positionals } = parseArgs({ args: options, allowPositionals: true });
    const [file] = positionals;
    if (!file || positionals.length !== 1) throw new Error(usage);
    const { settings, pipelines } = await loadWatchConfig(file);
    console.log(
      JSON.stringify(
        {
          valid: true,
          config: resolve(file),
          stateDirectory: settings.stateDirectory,
          pipelines: pipelines.map(({ id }) => id),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action !== "jobs" && action !== "job" && action !== "retry" && action !== "metrics") {
    throw new Error(`Unknown admin command "${action}".\n${usage}`);
  }

  const { values, positionals } = parseArgs({
    args: options,
    allowPositionals: true,
    options: {
      "state-directory": { type: "string" },
      config: { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
    },
  });
  const { "state-directory": state, config, status, limit, offset } = values;
  if (state === "" || config === "" || (state !== undefined && config !== undefined)) {
    throw new Error("Choose either --state-directory or --config with a path.");
  }
  const needsId = action === "job" || action === "retry";
  const [id] = positionals;
  if (
    (needsId ? !id || positionals.length !== 1 : positionals.length !== 0) ||
    (action !== "jobs" && (status !== undefined || limit !== undefined || offset !== undefined))
  )
    throw new Error(usage);

  const parsed = config === undefined ? undefined : await loadWatchConfig(config);
  const stateDirectory = resolve(state ?? parsed?.settings.stateDirectory ?? "data/state");
  const { inspectJob, listJobs, queueManualRetry, readJobMetrics } =
    await import("./infrastructure/journal-admin.ts");
  let result: unknown;
  if (action === "jobs") {
    if (status !== undefined && !jobStatuses.some((entry) => entry === status)) {
      throw new Error(`Invalid job status "${status}".`);
    }
    const count = Number(limit ?? 50);
    const skip = Number(offset ?? 0);
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error("--limit must be an integer from 1 to 1000.");
    }
    if (!Number.isSafeInteger(skip) || skip < 0 || offset === "") {
      throw new Error("--offset must be a non-negative integer.");
    }
    result = await listJobs(stateDirectory, count, skip, status);
  } else if (action === "metrics") {
    result = await readJobMetrics(stateDirectory);
  } else if (id && action === "job") {
    result = await inspectJob(stateDirectory, id);
  } else if (id) {
    const layouts =
      parsed &&
      new Map(
        parsed.pipelines.map(({ directories }) => [directories.input, JSON.stringify(directories)]),
      );
    result = await queueManualRetry(stateDirectory, id, layouts);
  }
  console.log(JSON.stringify(result, null, 2));
}
