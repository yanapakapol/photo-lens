import type { DepthMap } from "./types";

/** Fast heuristic relative depth (offline fallback before AI depth lands).
 *  Center-weighted subject prior + mild vertical ground cue + local detail.
 *  Much weaker vertical term than before — it was classifying people's
 *  heads as "far" and breaking bokeh. */
export function estimateDepthHeuristic(imageData: ImageData): DepthMap {
  const { width: w, height: h, data } = imageData;
  const gray = new Float32Array(w * h);
  const sat = new Float32Array(w * h);

  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const r = data[p] / 255;
    const g = data[p + 1] / 255;
    const b = data[p + 2] / 255;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    sat[i] = max === 0 ? 0 : (max - min) / max;
  }

  const energy = new Float32Array(w * h);
  const stride = 2;
  for (let y = stride; y < h - stride; y += stride) {
    for (let x = stride; x < w - stride; x += stride) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      energy[i] = Math.min(1, Math.hypot(gx, gy) * 3.2);
    }
  }
  blurFill(energy, w, h, 10);

  const depth = new Float32Array(w * h);
  const cx = 0.5;
  const cy = 0.45;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const i = y * w + x;
      // Strong oval subject bias (covers a standing person / main subject)
      const dx = (u - cx) * 1.05;
      const dy = (v - cy) * 0.78;
      const rad = Math.sqrt(dx * dx + dy * dy);
      const center = Math.max(0, 1 - rad * 1.35) ** 1.1;
      // Weak ground cue only near the bottom of frame
      const ground = Math.pow(Math.max(0, v - 0.55) / 0.45, 1.6);
      const cue = 0.5 * energy[i] + 0.5 * sat[i];
      let d = 0.52 * center * (0.65 + cue) + 0.22 * ground + 0.18 * cue;
      // Keep a mid-range floor so subject isn't glued to background
      d = d * 0.85 + 0.12;
      depth[i] = Math.min(1, Math.max(0, d));
    }
  }
  blurFill(depth, w, h, 4);
  return { width: w, height: h, data: depth };
}

function blurFill(buf: Float32Array, w: number, h: number, radius: number): void {
  if (radius < 1) return;
  const tmp = new Float32Array(buf.length);
  const inv = 1 / (radius * 2 + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += buf[row + clampi(x, w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      acc += buf[row + clampi(x + radius + 1, w)] - buf[row + clampi(x - radius, w)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[clampi(y, h) * w + x];
    for (let y = 0; y < h; y++) {
      buf[y * w + x] = acc * inv;
      acc += tmp[clampi(y + radius + 1, h) * w + x] - tmp[clampi(y - radius, h) * w + x];
    }
  }
}

function clampi(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

export function downsampleDepth(depth: DepthMap, maxEdge: number): DepthMap {
  const scale = Math.max(depth.width, depth.height) / maxEdge;
  if (scale <= 1) return depth;
  const w = Math.max(1, Math.round(depth.width / scale));
  const h = Math.max(1, Math.round(depth.height / scale));
  const out = new Float32Array(w * h);
  const sx = depth.width / w;
  const sy = depth.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(depth.height, Math.ceil((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(depth.width, Math.ceil((x + 1) * sx));
      let acc = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          acc += depth.data[yy * depth.width + xx];
          n++;
        }
      }
      out[y * w + x] = n ? acc / n : 0;
    }
  }
  return { width: w, height: h, data: out };
}
