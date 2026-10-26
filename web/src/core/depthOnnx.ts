/** Depth Anything V2 Small (Apache-2.0) via ONNX Runtime Web.
 *  Model at /models/dav2-small-int8.onnx (same-origin, offline after first load).
 *  License Apache-2.0 — verified on HF card + GitHub LICENSE. */
import * as ort from "onnxruntime-web";
import type { DepthMap } from "./types";

const MODEL_URL = "/models/dav2-small-int8.onnx";
const INPUT = 518;

// Use the bundled WASM (no external wasmPaths — that path broke loading).
// Single thread avoids COOP/COEP requirements.
ort.env.wasm.numThreads = 1;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const res = await fetch(MODEL_URL);
      if (!res.ok) throw new Error(`Depth model HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 1_000_000) throw new Error("Depth model truncated");
      return ort.InferenceSession.create(buf, {
        executionProviders: ["wasm"],
      });
    })().catch((e) => {
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

export async function estimateDepthOnnx(
  imageData: ImageData,
  onProgress?: (msg: string) => void,
): Promise<DepthMap> {
  const session = await getSession();
  const { width: w, height: h } = imageData;

  const scale = INPUT / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d")!.putImageData(imageData, 0, 0);

  const cv = document.createElement("canvas");
  cv.width = INPUT;
  cv.height = INPUT;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#7f7f7f";
  ctx.fillRect(0, 0, INPUT, INPUT);
  ctx.drawImage(src, 0, 0, nw, nh);
  const inputImg = ctx.getImageData(0, 0, INPUT, INPUT);

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const chw = new Float32Array(3 * INPUT * INPUT);
  const px = inputImg.data;
  const plane = INPUT * INPUT;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    chw[i] = px[p] / 255 / std[0] - mean[0] / std[0];
    chw[plane + i] = px[p + 1] / 255 / std[1] - mean[1] / std[1];
    chw[2 * plane + i] = px[p + 2] / 255 / std[2] - mean[2] / std[2];
  }

  onProgress?.("Running depth network…");
  const tensor = new ort.Tensor("float32", chw, [1, 3, INPUT, INPUT]);
  const feeds: Record<string, ort.Tensor> = { [session.inputNames[0]]: tensor };
  const results = await session.run(feeds);
  const out = results[session.outputNames[0]];
  const data = out.data as Float32Array;
  const dims = out.dims as number[];
  const oh = dims[dims.length - 2];
  const ow = dims[dims.length - 1];

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(max - min, 1e-6);

  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * (oh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(oh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * (ow - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(ow - 1, x0 + 1);
      const tx = fx - x0;
      const v00 = data[y0 * ow + x0];
      const v10 = data[y0 * ow + x1];
      const v01 = data[y1 * ow + x0];
      const v11 = data[y1 * ow + x1];
      const v =
        (v00 * (1 - tx) + v10 * tx) * (1 - ty) +
        (v01 * (1 - tx) + v11 * tx) * ty;
      depth[y * w + x] = Math.min(1, Math.max(0, (v - min) / range));
    }
  }
  smooth3(depth, w, h);
  return { width: w, height: h, data: depth };
}

function smooth3(buf: Float32Array, w: number, h: number) {
  const src = buf.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      buf[i] =
        (src[i] * 4 +
          (src[i - 1] + src[i + 1] + src[i - w] + src[i + w]) * 2 +
          src[i - w - 1] +
          src[i - w + 1] +
          src[i + w - 1] +
          src[i + w + 1]) /
        16;
    }
  }
}

export function sampleDepth(depth: DepthMap, u: number, v: number): number {
  const x = Math.min(depth.width - 1, Math.max(0, Math.round(u * (depth.width - 1))));
  const y = Math.min(depth.height - 1, Math.max(0, Math.round(v * (depth.height - 1))));
  return depth.data[y * depth.width + x];
}
