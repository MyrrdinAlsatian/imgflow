import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { env, pipeline, RawImage } from "@huggingface/transformers";
import type { BackgroundRemover } from "../application/background-remover.ts";

/**
 * Opens one BEN2 FP16 session on the native CPU backend using the local model cache.
 *
 * @param cache - Directory containing `ben2/config.json`, `ben2/preprocessor_config.json`
 *   and `ben2/onnx/model_fp16.onnx`.
 * @returns The reusable alpha estimator and an operation that releases its native session.
 * @throws If a required file is unavailable or ONNX Runtime cannot initialize the model.
 */
export async function openBen2(cache: string) {
  const directory = resolve(cache, "ben2");
  for (const name of ["config.json", "preprocessor_config.json", "onnx/model_fp16.onnx"]) {
    const path = join(directory, name);
    try {
      await access(path, constants.R_OK);
    } catch (error) {
      throw new Error(`BEN2 model file is unavailable: "${path}". Prepare the local cache first.`, {
        cause: error,
      });
    }
  }

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  const segment = await pipeline("image-segmentation", directory, {
    device: "cpu",
    dtype: "fp16",
    local_files_only: true,
    session_options: {
      intraOpNumThreads: Math.min(4, availableParallelism()),
      interOpNumThreads: 1,
    },
  });

  const remove: BackgroundRemover = async ({ width, height, pixels }) => {
    const rgb = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const [foreground] = await segment(new RawImage(rgb, width, height, 3));
    const mask = foreground?.mask;
    if (!mask || mask.channels !== 1 || mask.width !== width || mask.height !== height) {
      throw new Error("BEN2 returned an unexpected foreground mask.");
    }
    return new Uint8Array(mask.data.buffer, mask.data.byteOffset, mask.data.byteLength);
  };

  return { remove, close: () => segment.dispose() };
}
