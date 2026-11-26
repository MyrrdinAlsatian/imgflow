import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Logger } from "pino";
import type { JobJournal } from "../application/job-journal.ts";
import { httpPage, httpScript } from "./http-page.ts";
import { openSharpImage } from "./sharp-image.ts";
import { syncPath } from "./watch-files.ts";
import type { WatchDirectories } from "./watch-files.ts";

type HttpSettings = Readonly<{ host: string; port: number; token: string }>;
type HttpPipeline = Readonly<{ id: string; directories: WatchDirectories }>;

const maxBytes = 20 * 1024 * 1024;
const uploadTimeoutMs = 60_000;
const stagingPrefix = ".pixelflow-http-";
const submissionRoute = /^\/api\/v1\/pipelines\/([a-z0-9_-]+)\/jobs$/i;
const jobRoute =
  /^\/api\/v1\/jobs\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/files\/([a-z0-9][a-z0-9_-]{0,63}\.(?:webp|avif|png|jpg)))?$/i;
const variantName = /^[a-z0-9][a-z0-9_-]{0,63}\.(webp|avif|png|jpg)$/i;
const mimeTypes = new Map([
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
]);
const uploadTypes = new Map([
  ["image/jpeg", { extension: "jpg", format: "jpeg" }],
  ["image/png", { extension: "png", format: "png" }],
  ["image/webp", { extension: "webp", format: "webp" }],
]);

export function readHttpSettings(env: NodeJS.ProcessEnv): HttpSettings | undefined {
  const token = env.PIXELFLOW_HTTP_TOKEN;
  if (token === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error("PIXELFLOW_HTTP_TOKEN must contain 32 to 128 URL-safe characters.");
  }
  const port = Number(env.PIXELFLOW_HTTP_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PIXELFLOW_HTTP_PORT must be an integer from 1 to 65535.");
  }
  return { token, port, host: env.PIXELFLOW_HTTP_HOST ?? "127.0.0.1" };
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function codeIs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function stageUpload(request: IncomingMessage, directories: WatchDirectories) {
  const type = uploadTypes.get(request.headers["content-type"] ?? "");
  if (!type) throw new HttpError(415, "Send JPEG, PNG or WebP as the raw request body.");
  if (Number(request.headers["content-length"]) > maxBytes)
    throw new HttpError(413, "Image exceeds 20 MiB.");

  const id = randomUUID();
  const name = `upload.${type.extension}`;
  const staging = await mkdtemp(join(directories.processing, stagingPrefix));
  const temporary = join(staging, name);
  const timer = setTimeout(() => request.destroy(), uploadTimeoutMs).unref();
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Expected a binary request body.");
        size += chunk.length;
        if (size > maxBytes) throw new HttpError(413, "Image exceeds 20 MiB.");
        await file.writeFile(chunk);
      }
      if (size === 0) throw new HttpError(400, "The image body is empty.");
      await file.sync();
    } finally {
      await file.close();
    }

    try {
      const image = await openSharpImage(temporary);
      const { format, width, height } = await image.metadata();
      if (format !== type.format || !width || !height || width * height > 64_000_000) {
        throw new HttpError(
          422,
          "Image format does not match Content-Type, or dimensions exceed the limit.",
        );
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, "Invalid single-frame JPEG, PNG or WebP image.", { cause: error });
    }

    if (process.platform !== "win32") await syncPath(staging, "r");
    // Reconciliation can adopt this complete directory even if the journal write never runs.
    await rename(staging, join(directories.processing, id));
    if (process.platform !== "win32") await syncPath(directories.processing, "r");
    return { id, name, scope: directories.input };
  } finally {
    clearTimeout(timer);
    await rm(staging, { recursive: true, force: true });
  }
}

async function publishedFiles(directory: string): Promise<readonly string[]> {
  try {
    if (!(await lstat(directory)).isDirectory()) return [];
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && variantName.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (codeIs(error, "ENOENT")) return [];
    throw error;
  }
}

async function download(response: ServerResponse, directory: string, name: string) {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const mimeType = mimeTypes.get(extension);
  if (!mimeType || !(await publishedFiles(directory)).includes(name))
    throw new HttpError(404, "File not found.");
  const file = await open(
    join(directory, name),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch((error: unknown) => {
    if (codeIs(error, "ENOENT") || codeIs(error, "ELOOP"))
      throw new HttpError(404, "File not found.");
    throw error;
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new HttpError(404, "File not found.");
    response.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename="${name}"`,
    });
    await pipeline(file.createReadStream({ autoClose: false }), response);
  } finally {
    await file.close();
  }
}

/**
 * Runs the authenticated ingress alongside the watcher. Uploads enter the same durable queue
 * as folder deposits, and downloads are limited to published image variants.
 */
export async function runHttpConnector(
  settings: HttpSettings,
  pipelines: readonly HttpPipeline[],
  journal: JobJournal,
  schedule: (scope: string, id: string) => void,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const byId = new Map(pipelines.map((entry) => [entry.id, entry]));
  const byScope = new Map(pipelines.map((entry) => [entry.directories.input, entry]));
  const authorization = digest(`Bearer ${settings.token}`);
  let uploads = 0;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const { method, url = "" } = request;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (method === "GET" && (url === "/" || url === "/app.js")) {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      response.writeHead(200, {
        "Content-Type": url === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      });
      response.end(url === "/" ? httpPage : httpScript);
      return;
    }
    if (!url.startsWith("/api/v1/")) throw new HttpError(404, "Route not found.");
    if (!timingSafeEqual(authorization, digest(request.headers.authorization ?? ""))) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="PixelFlow"');
      throw new HttpError(401, "A valid bearer token is required.");
    }
    if (method === "GET" && url === "/api/v1/pipelines") {
      json(response, 200, { pipelines: [...byId.keys()] });
      return;
    }
    const selected = submissionRoute.exec(url)?.[1];
    if (method === "POST" && selected) {
      const target = byId.get(selected);
      if (!target) throw new HttpError(404, "Pipeline not found.");
      if (uploads >= 2) throw new HttpError(429, "Too many uploads in progress.");
      uploads++;
      try {
        const job = await stageUpload(request, target.directories);
        const record =
          journal.find(job.id) ?? journal.add(job, JSON.stringify(target.directories), null);
        schedule(job.scope, job.id);
        const statusUrl = `/api/v1/jobs/${job.id}`;
        response.setHeader("Location", statusUrl);
        json(response, 202, { id: job.id, status: record.status, statusUrl });
      } finally {
        uploads--;
      }
      return;
    }
    const [, id, filename] = jobRoute.exec(url) ?? [];
    if (method === "GET" && id) {
      const record = journal.find(id);
      const target = record && byScope.get(record.scope);
      if (!target || !record) throw new HttpError(404, "Job not found.");
      const directory = join(target.directories.output, id);
      if (filename) {
        if (record.status !== "completed") throw new HttpError(404, "File not found.");
        await download(response, directory, filename);
        return;
      }
      const files = record.status === "completed" ? await publishedFiles(directory) : [];
      json(response, 200, {
        id,
        pipeline: target.id,
        status: record.status,
        attempts: record.attempts,
        files: files.map((name) => ({ name, url: `/api/v1/jobs/${id}/files/${name}` })),
      });
      return;
    }
    throw new HttpError(404, "Route not found.");
  }

  for (const { directories } of pipelines) {
    const entries = await readdir(directories.processing, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^\.pixelflow-http-[a-zA-Z0-9]{6}$/.test(entry.name))
        await rm(join(directories.processing, entry.name), { recursive: true, force: true });
    }
  }
  if (signal.aborted) return;

  const active = new Set<Promise<void>>();
  const server = createServer(
    { headersTimeout: 15_000, requestTimeout: uploadTimeoutMs },
    (req, res) => {
      const task = handle(req, res)
        .catch((error: unknown) => {
          if (!(error instanceof HttpError) && !req.aborted && !signal.aborted) {
            logger.error({ err: error }, "HTTP connector request failed");
          }
          if (res.destroyed) return;
          if (res.headersSent) {
            res.destroy();
            return;
          }
          if (!req.complete) res.setHeader("Connection", "close");
          if (error instanceof HttpError) json(res, error.status, { error: error.message });
          else json(res, 500, { error: "Internal server error." });
        })
        .finally(() => active.delete(task));
      active.add(task);
    },
  );
  server.maxConnections = 32;
  server.setTimeout(uploadTimeoutMs, (socket) => socket.destroy());

  function close() {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    return closed;
  }

  let stop: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      stop = resolve;
      signal.addEventListener("abort", stop, { once: true });
      server.once("error", reject);
      server.listen(settings.port, settings.host, () => {
        logger.info({ host: settings.host, port: settings.port }, "HTTP connector ready");
      });
    });
  } finally {
    signal.removeEventListener("abort", stop);
    await close();
    await Promise.all(active);
  }
}
