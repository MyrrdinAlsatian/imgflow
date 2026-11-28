import { readFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runConfiguredWatch } from "../src/infrastructure/configured-watch.ts";

let root: string;
let port: number;
let base: string;
let shutdown: AbortController;
let service: Promise<void> | undefined;
const unknownJob = "/jobs/00000000-0000-0000-0000-000000000000";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelflow-http-"));
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve) => reservation.close(() => resolve()));

  if (!v.is(v.object({ port: v.number() }), address)) throw new Error("Expected a TCP address.");
  port = address.port;
  base = `http://127.0.0.1:${port}`;
  vi.stubEnv("PIXELFLOW_HTTP_TOKEN", undefined);
});

afterEach(async () => {
  shutdown?.abort();

  try {
    await service;
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    service = undefined;
  }
});

async function start(options: { token?: string; invalidPipeline?: boolean } = {}) {
  shutdown = new AbortController();
  const config = join(root, "pixelflow.yaml");

  const watermark = options.invalidPipeline
    ? "      - type: watermark\n        image: missing.png\n"
    : "";

  await writeFile(
    config,
    `
version: 1
settings:
  maxRetries: 0
  logLevel: silent
  http:
    port: ${port}
    maxUploadBytes: 8192
pipelines:
  photos:
    watch: input
    output: output
    archive: archive
    failed: failed
    steps:
${watermark}      - type: export
        variants:
          - format: webp
          - format: jpeg
            name: preview
`,
  );
  service = runConfiguredWatch(config, shutdown.signal);
  const authentication = options.token ? { Authorization: `Bearer ${options.token}` } : undefined;
  await Promise.race([
    service.then(() => {
      throw new Error("The service stopped before opening HTTP.");
    }),
    vi.waitFor(
      async () => {
        const response = await fetch(
          base + unknownJob,
          authentication ? { headers: authentication } : {},
        );

        expect(response.status).toBe(404);
        await response.text();
      },
      { timeout: 4000 },
    ),
  ]);
}

async function upload(data: Uint8Array<ArrayBuffer> | string, type = "image/jpeg", token?: string) {
  const headers = new Headers({ "Content-Type": type });

  if (token) headers.set("Authorization", `Bearer ${token}`);

  return fetch(base + "/pipelines/photos/jobs", {
    method: "POST",
    headers,
    body: data,
  });
}

type ExpectedStatus = {
  status: string;
  jobId?: string;
  pipelineId?: string;
  attempts?: number;
  retryAt?: number | null;
  outputs?: { name: string; url: string }[];
};

async function waitForStatus(path: string, expected: ExpectedStatus): Promise<void> {
  await vi.waitFor(
    async () => {
      const response = await fetch(base + path);
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject(expected);
    },
    { timeout: 4000 },
  );
}

test("accepts an image, exposes its published variants and retains the job after restart", async () => {
  const source = await readFile(new URL("./fixtures/oriented.jpg", import.meta.url));
  await start();
  const accepted = await upload(new Uint8Array(source));
  const statusUrl = accepted.headers.get("location") ?? "";
  expect(accepted.status).toBe(202);
  expect(statusUrl).toMatch(/^\/jobs\/[0-9a-f-]{36}$/);
  const jobId = statusUrl.split("/").at(-1);

  if (!jobId) throw new Error("The receipt is missing its job ID.");
  const webp = { name: "image.webp", url: `${statusUrl}/outputs/image.webp` };
  const jpeg = { name: "preview.jpg", url: `${statusUrl}/outputs/preview.jpg` };
  expect(await accepted.json()).toEqual({
    jobId,
    status: "pending",
    statusUrl,
    estimatedProcessingMs: null,
    outputs: [webp, jpeg],
  });
  await waitForStatus(statusUrl, {
    status: "completed",
    jobId,
    pipelineId: "photos",
    attempts: 1,
    retryAt: null,
    outputs: [webp, jpeg],
  });
  expect(await readFile(join(root, "archive", jobId, "image.jpg"))).toEqual(source);

  shutdown.abort();
  await service;
  await start();
  await waitForStatus(statusUrl, { status: "completed" });

  for (const [variant, format] of [
    [webp, "webp"],
    [jpeg, "jpeg"],
  ] as const) {
    const download = await fetch(base + variant.url);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe(`image/${format}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(await sharp(bytes).metadata()).toMatchObject({ format });
  }

  const traversal = await fetch(`${base}${statusUrl}/outputs/%2e%2e%2fimage.jpg`);
  expect(traversal.status).toBe(404);
  const next = await upload(new Uint8Array(source));
  const receipt: unknown = await next.json();
  expect(next.status).toBe(202);
  expect(receipt).toMatchObject({ estimatedProcessingMs: expect.any(Number) });
});

test("rejects invalid, mismatched, truncated and oversized uploads without retaining a job", async () => {
  await start();
  const truncated = await readFile(new URL("./fixtures/truncated.jpg", import.meta.url));
  const png = await readFile(new URL("./fixtures/transparent.png", import.meta.url));

  for (const [bytes, type, status] of [
    ["", "image/jpeg", 400],
    ["arbitrary text", "text/plain", 415],
    ["arbitrary text", "image/jpeg", 422],
    [new Uint8Array(png), "image/jpeg", 422],
    [new Uint8Array(truncated), "image/jpeg", 422],
    [new Uint8Array(8193), "image/jpeg", 413],
  ] as const) {
    const response = await upload(bytes, type);
    expect(response.status).toBe(status);
    await response.text();
  }

  // A chunked body has no Content-Length, so the server must count the received bytes.
  const chunked = await new Promise<number | undefined>((resolve, reject) => {
    const client = request(
      base + "/pipelines/photos/jobs",
      {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );

    client.once("error", reject);
    client.write(Buffer.alloc(4096));
    client.end(Buffer.alloc(4097));
  });

  expect(chunked).toBe(413);
  expect(await readdir(join(root, "archive"))).toEqual([]);
  expect(await readdir(join(root, "failed"))).toEqual([]);
  expect(await readdir(join(root, "data", "processing", "photos"))).toEqual([]);
});

test("reports failed jobs without a downloadable output", async () => {
  await start({ invalidPipeline: true });
  const source = await readFile(new URL("./fixtures/oriented.jpg", import.meta.url));
  const accepted = await upload(new Uint8Array(source));
  expect(accepted.status).toBe(202);
  await accepted.text();
  const path = accepted.headers.get("location") ?? "";
  await waitForStatus(path, { status: "failed", attempts: 1, outputs: [] });
  const missing = await fetch(`${base}${path}/outputs/image.webp`);
  expect(missing.status).toBe(404);
});

test("requires the configured bearer token for polling and uploads", async () => {
  const token = "test-secret";
  vi.stubEnv("PIXELFLOW_HTTP_TOKEN", token);
  await start({ token });
  const unauthorized = await fetch(base + unknownJob);
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
  const denied = await upload("bytes", "image/jpeg", "wrong-token");
  expect(denied.status).toBe(401);
  const source = await readFile(new URL("./fixtures/oriented.jpg", import.meta.url));
  const accepted = await upload(new Uint8Array(source), "image/jpeg", token);
  expect(accepted.status).toBe(202);
  await accepted.text();
});
