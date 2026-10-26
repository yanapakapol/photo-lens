/** Core types for the Photo Lens pipeline.
 *  This module is platform-free: no DOM, no WebGL. Safe to port to
 *  React Native / iOS later. */

/** Relative depth map, row-major, values normalized to [0,1]
 *  where 0 = farthest, 1 = nearest. */
export interface DepthMap {
  width: number;
  height: number;
  data: Float32Array;
}

/** Optical parameters driving bokeh + telephoto (thin-lens model). */
export interface LensParams {
  /** Focal length in mm (virtual, after crop/zoom). */
  focalMm: number;
  /** Aperture f-number, e.g. 1.4, 2.8. */
  fNumber: number;
  /** Focus distance in metres. */
  focusM: number;
  /** Focus plane in depth units [0,1] — set by tap-to-focus. */
  focusRel: number;
  /** Scene scale: metres represented by full depth range (depth prior). */
  sceneScaleM: number;
  /** Blur intensity multiplier, 0–2. */
  strength: number;
  /** Aperture rendering style (bokeh shape). */
  style: BokehStyle;
}

export type BokehStyle = "soft" | "bubble" | "hex" | "cateye" | "swirl" | "star";

/** Telephoto (dolly-zoom) parameters. */
export interface TeleParams {
  /** Zoom factor k (1 = off, 2 = 2× compression). */
  k: number;
  /** Subject distance in metres (pixels near this depth keep size). */
  subjectM: number;
}

export type FilmStockId =
  | "none"
  | "portrait"
  | "chrome"
  | "mono"
  | "night"
  | "verdura";

export interface FilmParams {
  stock: FilmStockId;
  /** Overall look intensity 0–1. */
  intensity: number;
  /** Halation strength 0–1 (red glow around highlights). */
  halation: number;
  /** Film grain amount 0–1. */
  grain: number;
}

export interface AdjustParams {
  exposure: number; // EV, -3..+3
  contrast: number; // -1..+1
  saturation: number; // -1..+1
  temperature: number; // -1..+1 (cool..warm)
}

export interface PipelineState {
  lens: LensParams;
  tele: TeleParams;
  film: FilmParams;
  adjust: AdjustParams;
}

export const DEFAULT_STATE: PipelineState = {
  lens: {
    focalMm: 26,
    fNumber: 1.4,
    focusM: 1.6,
    focusRel: 0.55,
    sceneScaleM: 12,
    strength: 0.75,
    style: "soft",
  },
  tele: { k: 1, subjectM: 1.8 },
  film: { stock: "none", intensity: 0.85, halation: 0.5, grain: 0.4 },
  adjust: { exposure: 0, contrast: 0, saturation: 0, temperature: 0 },
};

/** Circle of confusion via the thin-lens model from the research brief:
 *  c = (f² / N) · |D − S| / (D · (S − f))
 *  f, D, S in the same units (mm here). Returns CoC in mm on sensor. */
export function cocMm(
  focalMm: number,
  fNumber: number,
  focusMm: number,
  objectMm: number,
): number {
  const f = focalMm;
  const s = focusMm;
  const d = objectMm;
  return ((f * f) / fNumber) * Math.abs(d - s) / (d * (s - f));
}

/** Convert relative depth [0,1] (1 = near) to object distance in metres
 *  under a linear-in-disparity prior: D = sceneScale / (1 + z·(ratio−1))
 *  with a practical hyperbolic mapping used by mobile portrait modes. */
export function depthToMeters(relNear: number, sceneScaleM: number): number {
  // relNear 0 → far (sceneScale), 1 → near (0.35 m floor)
  const far = sceneScaleM;
  const near = 0.35;
  const t = Math.min(1, Math.max(0, relNear));
  // Hyperbolic: most of the range compressed at the far end.
  return far * near / (near + t * (far - near));
}

/** Sensor width proxy for 35mm-equivalent full frame (36 mm). */
export const SENSOR_WIDTH_MM = 36;

/** Max CoC diameter in pixels for a given lens setup at image width. */
export function maxCocPixels(
  lens: LensParams,
  imageWidth: number,
): number {
  // c_mm on full-frame sensor, scaled to pixels:
  // pixels = c_mm / SENSOR_WIDTH_MM * imageWidth
  const focusMm = lens.focusM * 1000;
  // CoC at far plane (D → sceneScale)
  const farMm = lens.sceneScaleM * 1000;
  const cFar = cocMm(lens.focalMm, lens.fNumber, focusMm, farMm);
  const px = (cFar / SENSOR_WIDTH_MM) * imageWidth;
  return px * lens.strength;
}

export function formatFStop(n: number): string {
  return `ƒ/${n.toFixed(1)}`;
}

export function formatFocal(mm: number): string {
  return `${Math.round(mm)}mm`;
}
