import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Logger } from "pino";
import type { JobRecord } from "../domain/job.ts";
import type { JobStatus } from "../domain/job.ts";
import { validateImageUpload } from "./sharp-image.ts";
import { readFileStamp } from "./watch-files.ts";

/** Listener settings for the optional job API. */
export type HttpSettings = Readonly<{ host: string; port: number; maxUploadBytes: number }>;

type HttpPipeline = Readonly<{
  id: string;
  scope: string;
  output: string;
  outputNames: readonly string[];
  submit(name: string, data: Buffer): Promise<JobRecord>;
}>;

type JobResponse = Readonly<{
  jobId: string;
  status: JobStatus;
  outputs: readonly { name: string; url: string }[];
}> &
  (
    | Readonly<{ statusUrl: string; estimatedProcessingMs: number | null }>
    | Readonly<{ pipelineId: string; attempts: number; retryAt: number | null }>
  );

const inputs = new Map([
  ["image/jpeg", { format: "jpeg", name: "image.jpg" }],
  ["image/png", { format: "png", name: "image.png" }],
  ["image/webp", { format: "webp", name: "image.webp" }],
]);

const outputTypes = new Map([
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
]);

const outputName = /^[a-z0-9][a-z0-9_-]{0,63}\.(?:jpg|png|webp|avif)$/i;
const uploadRoute = /^\/pipelines\/([a-z0-9][a-z0-9_-]{0,63})\/jobs$/i;
const jobRoute = /^\/jobs\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/outputs\/([^/]+))?$/;

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function json(
  response: ServerResponse,
  status: number,
  value: JobResponse | { error: string },
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function links(jobId: string, names: readonly string[]) {
  return names.map((name) => ({ name, url: `/jobs/${jobId}/outputs/${name}` }));
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Reads the encoded body up to the configured limit, including for chunked uploads. */
async function readUpload(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers["content-length"] ?? 0) > limit) {
    throw new HttpError(413, "The image exceeds the upload size limit.");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected a binary request body.");
    bytes += chunk.length;

    if (bytes > limit) throw new HttpError(413, "The image exceeds the upload size limit.");
    chunks.push(chunk);
  }

  if (!bytes) throw new HttpError(400, "The request body is empty.");

  return Buffer.concat(chunks, bytes);
}

/** Lists regular image exports in the durable result directory, including after a config change. */
async function publishedNames(directory: string): Promise<string[]> {
  try {
    if (!(await lstat(directory)).isDirectory()) return [];

    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && outputName.test(entry.name))
      .map(({ name }) => name)
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Accepts validated uploads and serves journal snapshots and published exports.
 * The caller keeps storage and journal adapters open until close resolves.
 */
export async function startJobHttp(
  settings: HttpSettings,
  pipelines: readonly HttpPipeline[],
  findJob: (id: string) => JobRecord | undefined,
  estimateProcessingMs: (scope: string) => number | null,
  logger: Logger,
  shutdown: AbortSignal,
): Promise<{ close(): Promise<void> }> {
  const token = process.env.PIXELFLOW_HTTP_TOKEN;

  if (!token && settings.host !== "127.0.0.1" && settings.host !== "::1") {
    throw new Error("PIXELFLOW_HTTP_TOKEN is required when HTTP listens outside loopback.");
  }

  const authorization = token ? hash(`Bearer ${token}`) : undefined;
  const byId = new Map(pipelines.map((entry) => [entry.id, entry]));
  const byScope = new Map(pipelines.map((entry) => [entry.scope, entry]));
  let uploading = false;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      authorization &&
      !timingSafeEqual(authorization, hash(request.headers.authorization ?? ""))
    ) {
      response.setHeader("WWW-Authenticate", "Bearer");
      throw new HttpError(401, "A valid bearer token is required.");
    }

    const path = request.url?.split("?", 1)[0] ?? "";
    const upload = uploadRoute.exec(path);

    if (request.method === "POST" && upload) {
      if (shutdown.aborted) throw new HttpError(503, "The service is stopping.");
      const target = byId.get(upload[1] ?? "");

      if (!target) throw new HttpError(404, "Pipeline not found.");
      const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      const input = inputs.get(mediaType ?? "");

      if (!input || (request.headers["content-encoding"] ?? "identity") !== "identity") {
        throw new HttpError(415, "Send an uncompressed JPEG, PNG or WebP image body.");
      }

      if (uploading) {
        response.setHeader("Retry-After", "1");
        throw new HttpError(503, "Another image upload is being validated.");
      }

      uploading = true;

      try {
        const data = await readUpload(request, settings.maxUploadBytes);

        try {
          await validateImageUpload(data, input.format);
        } catch {
          throw new HttpError(
            422,
            "The image must decode as a supported single-frame image within the pixel limit.",
          );
        }

        if (shutdown.aborted) throw new HttpError(503, "The service is stopping.");

        if (response.destroyed) return;
        const estimate = estimateProcessingMs(target.scope);
        const job = await target.submit(input.name, data);
        const statusUrl = `/jobs/${job.id}`;
        response.setHeader("Location", statusUrl);
        json(response, 202, {
          jobId: job.id,
          status: job.status,
          statusUrl,
          estimatedProcessingMs: estimate,
          outputs: links(job.id, target.outputNames),
        });
      } finally {
        uploading = false;
      }

      return;
    }

    const match = jobRoute.exec(path);

    if (request.method !== "GET" || !match) throw new HttpError(404, "Route not found.");
    const job = findJob(match[1] ?? "");
    const target = job && byScope.get(job.scope);

    if (!job || !target) throw new HttpError(404, "Job not found.");
    const directory = join(target.output, job.id);
    const ready = job.status === "published" || job.status === "completed";
    const requested = match[2];

    if (!requested) {
      const names = ready ? await publishedNames(directory) : [];
      json(response, 200, {
        jobId: job.id,
        pipelineId: target.id,
        status: job.status,
        attempts: job.attempts,
        retryAt: job.retryAt,
        outputs: links(job.id, names),
      });

      return;
    }

    if (!outputName.test(requested)) throw new HttpError(404, "Output not found.");

    if (!ready && ["claiming", "pending", "running", "retry"].includes(job.status)) {
      throw new HttpError(409, "The job outputs are not ready.");
    }

    if (!ready || !(await publishedNames(directory)).includes(requested)) {
      throw new HttpError(404, "Output not found.");
    }

    const file = join(directory, requested);
    const stamp = await readFileStamp(file);

    if (!stamp) throw new HttpError(404, "Output not found.");
    response.writeHead(200, {
      "Content-Type": outputTypes.get(extname(requested)) ?? "application/octet-stream",
      "Content-Length": String(stamp.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(createReadStream(file), response);
  }

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await handle(request, response);
    } catch (error) {
      if (response.destroyed) return;

      if (response.headersSent) {
        response.destroy();

        return;
      }

      if (!request.complete || !request.readableEnded) response.setHeader("Connection", "close");

      if (error instanceof HttpError) {
        json(response, error.statusCode, { error: error.message });
      } else {
        logger.error({ err: error }, "Job API request failed");
        json(response, 500, { error: "The request could not be completed." });
      }
    }
  }

  const active = new Set<Promise<void>>();

  const server = createServer(
    { headersTimeout: 10_000, requestTimeout: 30_000, connectionsCheckingInterval: 1000 },
    (request, response) => {
      const task = respond(request, response).finally(() => active.delete(task));
      active.add(task);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info({ host: settings.host, port: settings.port }, "Job API listening");

  let stopped: Promise<void> | undefined;

  const stop = () => {
    stopped ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });

    return stopped;
  };

  shutdown.addEventListener("abort", stop, { once: true });

  if (shutdown.aborted) stop();

  return {
    async close() {
      shutdown.removeEventListener("abort", stop);
      await stop();
      await Promise.all(active);
    },
  };
}
