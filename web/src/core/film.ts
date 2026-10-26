import type { FilmStockId } from "./types";

/** Self-authored parametric film looks — no third-party LUT files, no
 *  real emulsion trademarks (Portra/Kodachrome/HP5 are trademarks of
 *  their owners; we use category names that evoke the look only).
 *  Pipeline order follows postfx (MIT) documented order:
 *  linear → WB/exposure → curve/split → halation (linear) → sRGB → grain. */
export interface FilmStockDef {
  id: FilmStockId;
  name: string;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  midTint: [number, number, number];
  curve: number;
  sat: number;
  monoMix: [number, number, number] | null;
  halationBias: number;
  grainBias: number;
  grainSize: number;
  swatch: string;
}

export const FILM_STOCKS: FilmStockDef[] = [
  {
    id: "none",
    name: "Clean",
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    midTint: [1, 1, 1],
    curve: 0,
    sat: 1,
    monoMix: null,
    halationBias: 0,
    grainBias: 0,
    grainSize: 1,
    swatch: "linear-gradient(135deg,#3a4048,#8a929c)",
  },
  {
    id: "portrait",
    name: "Portrait 400",
    shadowTint: [0.98, 0.96, 0.94],
    highlightTint: [1.06, 1.0, 0.92],
    midTint: [1.04, 0.99, 0.95],
    curve: 0.35,
    sat: 0.88,
    monoMix: null,
    halationBias: 0.35,
    grainBias: 0.3,
    grainSize: 1.15,
    swatch: "linear-gradient(135deg,#c9a88a,#e8d5b8,#8a9a7a)",
  },
  {
    id: "chrome",
    name: "Chrome 64",
    shadowTint: [0.92, 0.95, 1.02],
    highlightTint: [1.1, 1.0, 0.88],
    midTint: [1.08, 0.97, 0.9],
    curve: 0.62,
    sat: 1.18,
    monoMix: null,
    halationBias: 0.25,
    grainBias: 0.25,
    grainSize: 1,
    swatch: "linear-gradient(135deg,#8b1e1e,#d4a017,#1e3a5f)",
  },
  {
    id: "mono",
    name: "Classic Mono",
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    midTint: [1, 1, 1],
    curve: 0.55,
    sat: 0,
    monoMix: [0.28, 0.6, 0.12],
    halationBias: 0.1,
    grainBias: 0.85,
    grainSize: 1.4,
    swatch: "linear-gradient(135deg,#1a1a1a,#9a9a9a,#e8e8e8)",
  },
  {
    id: "night",
    name: "Night Cine",
    shadowTint: [0.9, 0.98, 1.08],
    highlightTint: [1.12, 0.98, 0.9],
    midTint: [0.96, 1.0, 1.05],
    curve: 0.42,
    sat: 1.05,
    monoMix: null,
    halationBias: 1.0,
    grainBias: 0.4,
    grainSize: 1.2,
    swatch: "linear-gradient(135deg,#0e1e2e,#c43c3c,#f0e0c8)",
  },
  {
    id: "verdura",
    name: "Verdura 400",
    shadowTint: [0.92, 1.04, 0.96],
    highlightTint: [0.98, 1.04, 0.94],
    midTint: [0.95, 1.05, 0.97],
    curve: 0.4,
    sat: 1.12,
    monoMix: null,
    halationBias: 0.2,
    grainBias: 0.35,
    grainSize: 1.1,
    swatch: "linear-gradient(135deg,#1e4a2e,#7aba6a,#d8e8c8)",
  },
];

export function getStock(id: FilmStockId): FilmStockDef {
  return FILM_STOCKS.find((s) => s.id === id) ?? FILM_STOCKS[0];
}
