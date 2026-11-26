import { checkWatchHealth } from "./watch-health.ts";

try {
  const path = process.env.PIXELFLOW_HEALTH_FILE;
  if (!path) throw new Error("PIXELFLOW_HEALTH_FILE is required.");
  await checkWatchHealth(path);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
