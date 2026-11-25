import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the entry point reports readiness and exits successfully", () => {
  const entryPoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const result = spawnSync(process.execPath, [entryPoint], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("PixelFlow foundation is ready.");
});
