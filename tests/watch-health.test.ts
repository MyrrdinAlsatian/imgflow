import { spawnSync } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { expect, test, vi } from "vitest";
import { runWatchFolder } from "../src/infrastructure/watch-folder.ts";
import { checkWatchHealth, startWatchHealth } from "../src/infrastructure/watch-health.ts";

test("an active watcher passes the healthcheck and reports an unavailable output directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelflow-health-"));
  const path = join(root, "health.json");
  const stop = new AbortController();
  vi.stubEnv("PIXELFLOW_HEALTH_FILE", path);
  vi.stubEnv("PIXELFLOW_HEALTH_MAX_JOB_SECONDS", "900");
  const service = runWatchFolder(
    { root, stabilityMs: 25, width: 1600, height: 1600, quality: 85 },
    async () => {
      throw new Error("No job is expected.");
    },
    pino({ level: "silent" }),
    stop.signal,
  );
  const cli = fileURLToPath(new URL("../src/infrastructure/healthcheck.ts", import.meta.url));
  const probe = () => spawnSync(process.execPath, [cli], { encoding: "utf8", timeout: 5000 });
  try {
    await vi.waitFor(() => checkWatchHealth(path), { timeout: 8000 });
    expect(probe().status).toBe(0);

    await rename(join(root, "output"), join(root, "offline-output"));
    await vi.waitFor(
      async () => {
        await expect(checkWatchHealth(path)).rejects.toThrow("output");
      },
      { timeout: 8000 },
    );
    const unhealthy = probe();
    expect(unhealthy.status).toBe(1);
    expect(unhealthy.stderr).toContain("output");
  } finally {
    stop.abort();
    try {
      await service;
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}, 20_000);

test("rejects a heartbeat that has stopped refreshing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelflow-stale-"));
  const path = join(root, "health.json");
  try {
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, writtenAt: Date.now() - 60000, error: null }),
    );
    await expect(checkWatchHealth(path)).rejects.toThrow("stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a job that has stopped making progress while the event loop still responds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelflow-stalled-"));
  const path = join(root, "health.json");
  const release = Promise.withResolvers<void>();
  await writeFile(join(root, "jobs.sqlite"), "");
  const onError = vi.fn();
  const health = startWatchHealth({
    path,
    folders: [],
    stateDirectory: root,
    maxJobSeconds: 1,
    checkJournal: () => {},
    shutdown: new AbortController().signal,
    onError,
  });
  const active = health.track(() => release.promise);
  try {
    await vi.waitFor(
      async () => {
        await expect(checkWatchHealth(path)).rejects.toThrow("active job exceeded");
      },
      { timeout: 8500 },
    );
    expect(onError).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await active;
    await health.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
