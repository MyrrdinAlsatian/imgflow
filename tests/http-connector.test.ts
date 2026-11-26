import { ok } from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runConfiguredWatch } from "../src/infrastructure/configured-watch.ts";

const fixture = fileURLToPath(new URL("./fixtures/oriented.jpg", import.meta.url));
const token = "test-token-for-pixelflow-http-connector";
const auth = { Authorization: `Bearer ${token}` };
let directory: string;
let config: string;
let origin: string;
let stop: AbortController;
let service: Promise<void> | undefined;

async function availablePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("No loopback test port.");
  return address.port;
}

async function start() {
  stop = new AbortController();
  service = runConfiguredWatch(config, stop.signal);
  const failure = service.then(() => {
    throw new Error("Watcher stopped before the connector was ready.");
  });
  await Promise.race([
    failure,
    vi.waitFor(async () => {
      const response = await fetch(origin, { signal: stop.signal });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('id="upload"');
    }),
  ]);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pixelflow-http-"));
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  vi.stubEnv("PIXELFLOW_HTTP_TOKEN", token);
  vi.stubEnv("PIXELFLOW_HTTP_HOST", "127.0.0.1");
  vi.stubEnv("PIXELFLOW_HTTP_PORT", String(port));
  config = join(directory, "pipelines.yaml");
  stop = new AbortController();
  service = undefined;
  await writeFile(
    config,
    `
version: 1
settings:
  scanIntervalSeconds: 60
  logLevel: silent
pipelines:
  web:
    watch: input
    processing: processing
    output: output
    archive: archive
    failed: failed
    steps:
      - type: normalize
      - type: export
        variants:
          - format: webp
          - format: png
`,
  );
});

afterEach(async () => {
  stop.abort();
  try {
    await service;
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

test("uploads, tracks and downloads a complete job after service restart", async () => {
  await start();
  const list = await fetch(`${origin}/api/v1/pipelines`, { headers: auth });
  expect(await list.json()).toEqual({ pipelines: ["web"] });

  const uploaded = await fetch(`${origin}/api/v1/pipelines/web/jobs`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "image/jpeg" },
    body: await readFile(fixture),
  });
  expect(uploaded.status).toBe(202);
  const job = await uploaded.json();
  ok(job && typeof job === "object" && "id" in job && "statusUrl" in job);
  const { id, statusUrl } = job;
  ok(typeof id === "string" && typeof statusUrl === "string");
  expect(uploaded.headers.get("location")).toBe(`/api/v1/jobs/${id}`);
  expect(statusUrl).toBe(uploaded.headers.get("location"));

  await vi.waitFor(async () => {
    const response = await fetch(`${origin}${statusUrl}`, { headers: auth });
    expect(await response.json()).toEqual({
      id,
      pipeline: "web",
      status: "completed",
      attempts: 1,
      files: ["image.png", "image.webp"].map((name) => ({
        name,
        url: `${statusUrl}/files/${name}`,
      })),
    });
  });
  expect(await readFile(join(directory, "archive", id, "upload.jpg"))).toEqual(
    await readFile(fixture),
  );

  stop.abort();
  await service;
  await start();
  const file = await fetch(`${origin}${statusUrl}/files/image.webp`, { headers: auth });
  expect(file.status).toBe(200);
  expect(file.headers.get("content-disposition")).toBe('attachment; filename="image.webp"');
  expect(await sharp(Buffer.from(await file.arrayBuffer())).metadata()).toMatchObject({
    format: "webp",
    width: 40,
    height: 80,
  });
  const archive = await fetch(`${origin}${statusUrl}/files/upload.jpg`, { headers: auth });
  expect(archive.status).toBe(404);
  const unauthorized = await fetch(`${origin}${statusUrl}/files/image.webp`);
  expect(unauthorized.status).toBe(401);
});

test("denies invalid credentials and rejects uploads without queueing partial files", async () => {
  await start();
  const url = `${origin}/api/v1/pipelines/web/jobs`;
  const post = (body: string | Buffer<ArrayBuffer>, contentType: string, tokenHeader = auth) =>
    fetch(url, { method: "POST", headers: { ...tokenHeader, "Content-Type": contentType }, body });
  const photo = await readFile(fixture);
  expect((await post(photo, "image/jpeg", { Authorization: "Bearer invalid" })).status).toBe(401);
  expect((await post(photo, "application/octet-stream")).status).toBe(415);
  expect((await post(photo, "image/png")).status).toBe(422);
  expect((await post("", "image/jpeg")).status).toBe(400);
  expect((await post(Buffer.alloc(20 * 1024 * 1024 + 1), "image/png")).status).toBe(413);
  expect(await readdir(join(directory, "processing"))).toEqual([]);
  expect(await readdir(join(directory, "output"))).toEqual([]);
});
