/** @file Downloads and verifies the pinned BEN2 files for an offline model cache. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const revision = "c552aa82688edce09f0ac9d2e31ad53d9d629010";
const repository = `https://huggingface.co/onnx-community/BEN2-ONNX/resolve/${revision}`;
const files = {
  "config.json": "a1955f3bbdd628a0ea0339ec14bc98ba7b09e1a35d267e4ab01e902d2489dfa5",
  "preprocessor_config.json": "447d9ccb2c4129ab0ca045fc293e7d79dbc45e293ac1e94818d865db77f65a54",
  "onnx/model_fp16.onnx": "dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1",
};

/**
 * Checks a cache entry against its pinned SHA-256 by streaming its contents.
 *
 * @param path - File to verify.
 * @param expected - Expected lowercase hexadecimal SHA-256 digest.
 * @throws If the file cannot be read or its digest differs.
 */
async function verify(path: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected) {
    throw new Error(`SHA-256 mismatch for "${path}".`);
  }
}

/**
 * Verifies an existing cache entry or downloads a missing entry to a temporary file.
 * A successful digest check is required before moving the download to its final path.
 *
 * @param cache - Cache root containing the `ben2` directory.
 * @param name - Path relative to the pinned model repository and to the local `ben2` directory.
 * @param expected - Pinned lowercase hexadecimal SHA-256 digest.
 * @throws If download, validation or publication fails. An existing entry is left in place.
 */
async function prepare(cache: string, name: string, expected: string): Promise<void> {
  const path = join(cache, "ben2", name);
  const exists = await stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!exists) {
    await mkdir(dirname(path), { recursive: true });
    const staging = await mkdtemp(join(dirname(path), ".ben2-"));
    const temporary = join(staging, "download");
    try {
      const response = await fetch(`${repository}/${name}`, {
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Could not download ${name} (HTTP ${response.status}).`);
      }
      await pipeline(response.body, createWriteStream(temporary, { flags: "wx" }));
      await verify(temporary, expected);
      await rename(temporary, path);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } else {
    if (!exists.isFile()) throw new Error(`Expected a file at "${path}".`);
    await verify(path, expected);
  }
  console.log(`Verified ${path}`);
}

try {
  if (process.argv.length > 3 || process.argv[2] === "") {
    throw new Error("Usage: pnpm model:prepare [model-cache]");
  }
  const cache = resolve(process.argv[2] ?? "models");
  for (const [name, expected] of Object.entries(files)) {
    await prepare(cache, name, expected);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
