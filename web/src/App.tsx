import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_STATE,
  formatFStop,
  formatFocal,
  type DepthMap,
  type PipelineState,
} from "./core/types";
import { estimateDepthHeuristic, downsampleDepth } from "./core/depth";
import { estimateDepthOnnx, sampleDepth } from "./core/depthOnnx";
import { parseExif } from "./core/exif";
import { FILM_STOCKS } from "./core/film";
import { LensRenderer, relFromMeters } from "./gl/renderer";

type Mode = "lens" | "tele" | "film" | "adjust";
type DepthSource = "none" | "heuristic" | "ai";

const ICONS = {
  aperture: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v7.5M20.8 8.2l-6.5 4.5M18.4 19.2l-4-6.9M5.6 19.2l6.5-4.5M3.2 8.2l4 6.9" />
    </svg>
  ),
  tele: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="7" width="14" height="10" rx="2" />
      <path d="M17 10l4-2v8l-4-2" />
      <circle cx="9" cy="12" r="2.5" />
    </svg>
  ),
  film: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 15h18M8 4v16M16 4v16" />
    </svg>
  ),
  adjust: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  ),
  undo: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </svg>
  ),
  redo: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 000 12h3" />
    </svg>
  ),
  export: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12M7 8l5-5 5 5" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </svg>
  ),
  depth: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 18V8l8-4 8 4v10l-8 4-8-4z" />
      <path d="M4 8l8 4 8-4M12 12v10" />
    </svg>
  ),
  compare: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12 3v18" />
      <path d="M8 7H5a2 2 0 00-2 2v6a2 2 0 002 2h3M16 7h3a2 2 0 012 2v6a2 2 0 01-2 2h-3" />
    </svg>
  ),
  image: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M3 16l5-4 4 3 4-5 5 6" />
    </svg>
  ),
};

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  return (
    <div className="dock__slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={() => onCommit?.()}
        onKeyUp={() => onCommit?.()}
      />
      <div className="dock__ticks" aria-hidden>
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i} className={i % 5 === 0 ? "maj" : ""} />
        ))}
      </div>
    </div>
  );
}

/** Decode a File/Blob to ImageData. Clear errors for HEIC etc. */
async function decodeImage(file: Blob): Promise<{ imageData: ImageData; name: string }> {
  const name = file instanceof File ? file.name : "photo";
  const type = (file as File).type || "";
  if (/hei[cf]/i.test(type) || /\.hei[cf]$/i.test(name)) {
    const { default: heic2any } = await import("heic2any");
    const jpeg = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    const blob = Array.isArray(jpeg) ? jpeg[0] : jpeg;
    return decodeImage(blob as Blob);
  }
  if (file.size > 40 * 1024 * 1024) {
    throw new Error("That file is over 40 MB — try a smaller export.");
  }

  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Fallback via <img> (some browsers/encoders)
    bmp = await new Promise<ImageBitmap>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        createImageBitmap(img)
          .then(resolve)
          .catch(() => reject(new Error("Couldn’t decode this image format.")))
          .finally(() => URL.revokeObjectURL(url));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(
          new Error(
            "Couldn’t open that file. Use JPEG or PNG (HEIC may need Safari).",
          ),
        );
      };
      img.src = url;
    });
  }

  const maxEdge = 1600;
  const scale =
    Math.max(bmp.width, bmp.height) > maxEdge
      ? maxEdge / Math.max(bmp.width, bmp.height)
      : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return { imageData: ctx.getImageData(0, 0, w, h), name };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rendererRef = useRef<LensRenderer | null>(null);
  const depthRef = useRef<DepthMap | null>(null);
  const depthSourceRef = useRef<DepthSource>("none");
  const historyRef = useRef<PipelineState[]>([]);
  const futureRef = useRef<PipelineState[]>([]);
  const rafRef = useRef(0);
  const loadSeq = useRef(0);

  const [state, setState] = useState<PipelineState>(DEFAULT_STATE);
  const [mode, setMode] = useState<Mode>("lens");
  const [hasImage, setHasImage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [compareX, setCompareX] = useState(-1);
  const [depthPeek, setDepthPeek] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [meta, setMeta] = useState({ focal: 26, fNum: 1.4, name: "" });
  const [depthOverlay, setDepthOverlay] = useState<string | null>(null);
  const [depthSource, setDepthSource] = useState<DepthSource>("none");
  const [focusDot, setFocusDot] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!canvasRef.current || rendererRef.current) return;
    try {
      rendererRef.current = new LensRenderer(canvasRef.current);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "WebGL2 not available");
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const scheduleRender = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rendererRef.current?.render(state, { compareX, showOriginal: false, depthPeek });
    });
  }, [state, compareX, depthPeek]);

  useEffect(() => {
    if (hasImage) scheduleRender();
  }, [hasImage, scheduleRender]);

  const pushHistory = useCallback(() => {
    historyRef.current.push(structuredClone(state));
    if (historyRef.current.length > 40) historyRef.current.shift();
    futureRef.current = [];
  }, [state]);

  const setLens = (patch: Partial<PipelineState["lens"]>, commit = false) => {
    if (commit) pushHistory();
    setState((s) => ({ ...s, lens: { ...s.lens, ...patch } }));
  };
  const setTele = (patch: Partial<PipelineState["tele"]>, commit = false) => {
    if (commit) pushHistory();
    setState((s) => ({ ...s, tele: { ...s.tele, ...patch } }));
  };
  const setFilm = (patch: Partial<PipelineState["film"]>, commit = false) => {
    if (commit) pushHistory();
    setState((s) => ({ ...s, film: { ...s.film, ...patch } }));
  };
  const setAdjust = (patch: Partial<PipelineState["adjust"]>, commit = false) => {
    if (commit) pushHistory();
    setState((s) => ({ ...s, adjust: { ...s.adjust, ...patch } }));
  };

  const undo = () => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    futureRef.current.push(structuredClone(state));
    setState(prev);
  };
  const redo = () => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push(structuredClone(state));
    setState(next);
  };

  const applyDepth = (depth: DepthMap, source: DepthSource) => {
    depthRef.current = depth;
    depthSourceRef.current = source;
    setDepthSource(source);
    rendererRef.current?.setDepth(depth);
    // refresh peek overlay
    if (depthPeek) setDepthPeek(false);
  };

  const runAiDepth = async (imageData: ImageData, seq: number) => {
    try {
      setBusy("AI depth: downloading model (one-time ~27 MB)…");
      const depth = await estimateDepthOnnx(imageData, (msg) => {
        if (seq === loadSeq.current && msg) setBusy(msg);
      });
      if (seq !== loadSeq.current) return;
      applyDepth(depth, "ai");
      setToast("AI depth ready — Depth Anything V2");
    } catch (e) {
      console.error(e);
      if (seq === loadSeq.current) {
        setToast(
          e instanceof Error && /fetch|network|download/i.test(e.message)
            ? "AI depth offline — staying on fast depth"
            : "AI depth failed — using fast depth",
        );
      }
    } finally {
      if (seq === loadSeq.current) setBusy(null);
    }
  };

  const finishLoad = async (
    imageData: ImageData,
    name: string,
    exif: { focalMm: number | null; fNumber: number | null },
  ) => {
    const seq = ++loadSeq.current;
    setBusy("Estimating depth…");
    await new Promise((r) => setTimeout(r, 20));
    const heuristic = estimateDepthHeuristic(imageData);
    applyDepth(downsampleDepth(heuristic, 640), "heuristic");

    const display = document.createElement("canvas");
    display.width = imageData.width;
    display.height = imageData.height;
    display.getContext("2d")!.putImageData(imageData, 0, 0);
    // Upload canvas directly — ImageBitmap drops UNPACK_FLIP_Y in Chromium.
    rendererRef.current?.setImage(display, depthRef.current!);

    const focal = exif.focalMm ?? 26;
    const fNum = exif.fNumber ?? 1.4;
    setMeta({ focal, fNum, name });
    setState((s) => ({
      ...s,
      lens: { ...s.lens, focalMm: focal, fNumber: fNum, focusM: 1.8, focusRel: 0.55 },
      tele: { ...s.tele, subjectM: 1.8 },
    }));
    historyRef.current = [];
    futureRef.current = [];
    setFocusDot(null);
    setHasImage(true);
    setBusy(null);

    // Background: upgrade to real ONNX depth
    void runAiDepth(imageData, seq);
  };

  const loadFile = async (file: Blob, fallbackName?: string) => {
    const seq = ++loadSeq.current;
    setBusy("Reading photo…");
    try {
      const { imageData, name } = await decodeImage(file);
      if (seq !== loadSeq.current) return;
      const exif = file instanceof File || fallbackName
        ? await parseExif(file)
        : { focalMm: null, fNumber: null, exposureSec: null, iso: null };
      await finishLoad(imageData, name || fallbackName || "photo", exif);
    } catch (e) {
      console.error(e);
      setBusy(null);
      setToast(e instanceof Error ? e.message : "Could not open that file");
    }
  };

  const loadSample = async () => {
    setBusy("Loading sample…");
    try {
      const res = await fetch("/samples/street.jpg");
      if (!res.ok) throw new Error("Sample missing — drop your own photo");
      const blob = await res.blob();
      await loadFile(blob, "sample-street.jpg");
    } catch (e) {
      setBusy(null);
      setToast(e instanceof Error ? e.message : "Could not load sample");
    }
  };

  const onPick = (f: File | undefined | null) => {
    if (f) void loadFile(f);
    // allow re-picking the same file
    if (fileRef.current) fileRef.current.value = "";
  };

  // Depth peek overlay
  useEffect(() => {
    if (!depthPeek || !depthRef.current || !hasImage) {
      setDepthOverlay(null);
      return;
    }
    const d = depthRef.current;
    const w = Math.min(800, d.width * 2);
    const h = Math.round((d.height / d.width) * w);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(d.height - 1, Math.floor((y / h) * d.height));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(d.width - 1, Math.floor((x / w) * d.width));
        const v = d.data[sy * d.width + sx];
        const i = (y * w + x) * 4;
        img.data[i] = Math.min(255, v * 255 * 1.15);
        img.data[i + 1] = Math.min(255, v * v * 255);
        img.data[i + 2] = Math.min(255, 50 + (1 - v) * 60);
        img.data[i + 3] = 230;
      }
    }
    ctx.putImageData(img, 0, 0);
    setDepthOverlay(c.toDataURL());
  }, [depthPeek, hasImage, depthSource]);

  const exportImage = async () => {
    if (!rendererRef.current || !hasImage) return;
    setBusy("Exporting…");
    rendererRef.current.render(state, { compareX: -1, showOriginal: false, depthPeek: false });
    await new Promise((r) => setTimeout(r, 20));
    const blob = await rendererRef.current.exportBlob("image/jpeg", 0.94);
    setBusy(null);
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `photo-lens-${Date.now()}.jpg`;
    a.click();
    URL.revokeObjectURL(a.href);
    setToast("Saved to downloads");
  };

  const resetAll = () => {
    pushHistory();
    setState({
      ...DEFAULT_STATE,
      lens: { ...DEFAULT_STATE.lens, focalMm: meta.focal, fNumber: meta.fNum },
    });
  };

  // Viewport interaction: compare drag OR tap-to-focus
  const viewportRef = useRef<HTMLDivElement>(null);
  const draggingCompare = useRef(false);

  const viewportPos = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return {
      u: (e.clientX - rect.left) / rect.width,
      v: (e.clientY - rect.top) / rect.height,
    };
  };

  const onViewportDown = (e: React.PointerEvent) => {
    if (!hasImage || depthPeek) return;
    if (compareX >= 0) {
      draggingCompare.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const { u } = viewportPos(e);
      setCompareX(Math.min(1, Math.max(0, u)));
      return;
    }
    // Tap to focus
    const { u, v } = viewportPos(e);
    // canvas uses object-fit contain — map through displayed rect of canvas
    const canvas = canvasRef.current;
    if (!canvas || !depthRef.current) return;
    const cRect = canvas.getBoundingClientRect();
    const cu = (e.clientX - cRect.left) / cRect.width;
    const cv = (e.clientY - cRect.top) / cRect.height;
    if (cu < 0 || cu > 1 || cv < 0 || cv > 1) return;
    // GL v is bottom-up; depth map is top-down
    const rel = sampleDepth(depthRef.current, cu, 1 - cv);
    const focusM = Math.max(0.4, Math.min(12, metersFromRel(rel)));
    setFocusDot({ x: u, y: v });
    setLens({ focusRel: rel, focusM }, true);
    setToast(`Focus ${focusM.toFixed(1)}m`);
  };

  const onViewportMove = (e: React.PointerEvent) => {
    if (!draggingCompare.current) return;
    const { u } = viewportPos(e);
    setCompareX(Math.min(1, Math.max(0, u)));
  };
  const onViewportUp = () => {
    draggingCompare.current = false;
  };

  const valueRow = useMemo(() => {
    switch (mode) {
      case "lens":
        return {
          main: formatFStop(state.lens.fNumber),
          sub: `${formatFocal(state.lens.focalMm)} · focus ${state.lens.focusM.toFixed(1)}m`,
        };
      case "tele":
        return {
          main: `${state.tele.k.toFixed(2)}×`,
          sub: `subject ${state.tele.subjectM.toFixed(1)}m`,
        };
      case "film":
        return {
          main: FILM_STOCKS.find((f) => f.id === state.film.stock)?.name ?? "Clean",
          sub: `hal ${Math.round(state.film.halation * 100)} · grain ${Math.round(state.film.grain * 100)}`,
        };
      case "adjust":
        return {
          main: `${state.adjust.exposure >= 0 ? "+" : ""}${state.adjust.exposure.toFixed(1)} EV`,
          sub: `con ${fmtSigned(state.adjust.contrast)} · sat ${fmtSigned(state.adjust.saturation)}`,
        };
    }
  }, [mode, state]);

  const depthBadge =
    depthSource === "ai" ? "DEPTH · AI" : depthSource === "heuristic" ? "DEPTH · FAST" : "DEPTH";

  return (
    <div className="app">
      <div className="app__frame">
        <header className="topbar">
          <div className="topbar__group">
            <button className="iconbtn" onClick={undo} disabled={!historyRef.current.length} title="Undo">
              {ICONS.undo}
            </button>
            <button className="iconbtn" onClick={redo} disabled={!futureRef.current.length} title="Redo">
              {ICONS.redo}
            </button>
            <span className="topbar__title">
              Photo Lens{meta.name ? <span> · {truncate(meta.name, 12)}</span> : null}
            </span>
          </div>
          <div className="topbar__group">
            {hasImage && (
              <>
                <button
                  className="iconbtn"
                  style={depthPeek ? { color: "var(--accent)" } : undefined}
                  onClick={() => setDepthPeek((v) => !v)}
                  title="Depth map"
                >
                  {ICONS.depth}
                </button>
                <button
                  className="iconbtn"
                  style={compareX >= 0 ? { color: "var(--accent)" } : undefined}
                  onClick={() => setCompareX((v) => (v >= 0 ? -1 : 0.5))}
                  title="Compare"
                >
                  {ICONS.compare}
                </button>
              </>
            )}
            <button className="iconbtn iconbtn--accent" onClick={exportImage} disabled={!hasImage}>
              {ICONS.export} Save
            </button>
          </div>
        </header>

        <div
          className="viewport"
          ref={viewportRef}
          onPointerDown={onViewportDown}
          onPointerMove={onViewportMove}
          onPointerUp={onViewportUp}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            onPick(f);
          }}
        >
          <canvas
            ref={canvasRef}
            style={hasImage ? { width: "100%", height: "100%", objectFit: "contain" } : { display: "none" }}
          />
          {depthPeek && depthOverlay && (
            <img
              src={depthOverlay}
              alt="Depth map"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                pointerEvents: "none",
                zIndex: 2,
              }}
            />
          )}
          {compareX >= 0 && hasImage && !depthPeek && (
            <>
              <div className="compare-line" style={{ left: `${compareX * 100}%` }} />
              <span className="compare-label compare-label--l">BEFORE</span>
              <span className="compare-label compare-label--r">AFTER</span>
            </>
          )}
          {focusDot && hasImage && !depthPeek && compareX < 0 && (
            <span
              style={{
                position: "absolute",
                left: `${focusDot.x * 100}%`,
                top: `${focusDot.y * 100}%`,
                width: 18,
                height: 18,
                marginLeft: -9,
                marginTop: -9,
                borderRadius: "50%",
                border: "1.5px solid var(--accent)",
                boxShadow: "0 0 0 3px rgba(232,184,77,0.25)",
                zIndex: 3,
                pointerEvents: "none",
              }}
            />
          )}
          {hasImage && (
            <div className="viewport__badge">
              {formatFocal(state.lens.focalMm)} · {formatFStop(state.lens.fNumber)}
            </div>
          )}
          {depthPeek && <div className="depth-tag">{depthBadge}</div>}
          {!hasImage && (
            <div className="viewport__hint">
              {ICONS.image}
              <h1>
                Make phone photos
                <br />
                feel like a better camera
              </h1>
              <p>Optical bokeh, telephoto compression, and film looks — fully offline, no account.</p>
              <div className="viewport__hint-actions">
                <button className="btn btn--primary" onClick={() => fileRef.current?.click()}>
                  Choose photo
                </button>
                <button className="btn" onClick={loadSample}>
                  Try a sample
                </button>
              </div>
            </div>
          )}
          {dragOver && <div className="viewport__dragover">Drop photo to edit</div>}
          {busy && (
            <div className="busy">
              <div className="busy__box">
                <span className="spinner" />
                {busy}
              </div>
            </div>
          )}
          {toast && <div className="toast">{toast}</div>}
          <label className="sr-only" htmlFor="photo-input">
            Choose photo
          </label>
          <input
            ref={fileRef}
            id="photo-input"
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
        </div>

        <div className="dock">
          <div className="dock__panel">
            <div className="dock__meta">
              <div className="dock__value">{valueRow.main}</div>
              <div className="dock__sub">{valueRow.sub}</div>
            </div>

            {mode === "lens" && (
              <>
                <div className="segrow">
                  <button
                    className={`chip ${state.lens.strength > 0 ? "chip--on" : ""}`}
                    onClick={() => setLens({ strength: state.lens.strength > 0 ? 0 : 0.75 }, true)}
                  >
                    {state.lens.strength > 0 ? "Bokeh on" : "Bokeh off"}
                  </button>
                  {[1.4, 2.8, 5.6].map((f) => (
                    <button
                      key={f}
                      className={`chip ${Math.abs(state.lens.fNumber - f) < 0.05 ? "chip--on" : ""}`}
                      onClick={() => setLens({ fNumber: f }, true)}
                    >
                      ƒ/{f}
                    </button>
                  ))}
                  {[26, 50, 85].map((f) => (
                    <button
                      key={f}
                      className={`chip ${state.lens.focalMm === f ? "chip--on" : ""}`}
                      onClick={() => setLens({ focalMm: f }, true)}
                    >
                      {f}mm
                    </button>
                  ))}
                </div>
                <div className="segrow" role="group" aria-label="Bokeh style">
                  {(
                    [
                      ["soft", "Soft"],
                      ["bubble", "Bubble"],
                      ["hex", "Hex"],
                      ["cateye", "Cat-eye"],
                      ["swirl", "Swirl"],
                      ["star", "Star"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={`chip ${state.lens.style === id ? "chip--on" : ""}`}
                      onClick={() => setLens({ style: id }, true)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Slider
                  value={state.lens.strength}
                  min={0}
                  max={1.5}
                  step={0.01}
                  onChange={(v) => setLens({ strength: v })}
                  onCommit={() => setLens({}, true)}
                />
                <Slider
                  value={state.lens.focusM}
                  min={0.4}
                  max={8}
                  step={0.05}
                  onChange={(v) => setLens({ focusM: v })}
                  onCommit={() => setLens({}, true)}
                />
              </>
            )}

            {mode === "tele" && (
              <>
                <div className="segrow">
                  {[1, 1.25, 1.5, 2].map((k) => (
                    <button
                      key={k}
                      className={`chip ${Math.abs(state.tele.k - k) < 0.01 ? "chip--on" : ""}`}
                      onClick={() => setTele({ k }, true)}
                    >
                      {k === 1 ? "Off" : `${k}×`}
                    </button>
                  ))}
                </div>
                <Slider
                  value={state.tele.k}
                  min={1}
                  max={2.5}
                  step={0.01}
                  onChange={(v) => setTele({ k: v })}
                  onCommit={() => setTele({}, true)}
                />
                <Slider
                  value={state.tele.subjectM}
                  min={0.5}
                  max={6}
                  step={0.05}
                  onChange={(v) => setTele({ subjectM: v })}
                  onCommit={() => setTele({}, true)}
                />
              </>
            )}

            {mode === "film" && (
              <>
                <div className="filmstrip">
                  {FILM_STOCKS.map((s) => (
                    <button
                      key={s.id}
                      className={`filmcard ${state.film.stock === s.id ? "filmcard--on" : ""}`}
                      onClick={() => setFilm({ stock: s.id }, true)}
                    >
                      <span className="filmcard__swatch" style={{ background: s.swatch }} />
                      <span className="filmcard__name">{s.name}</span>
                    </button>
                  ))}
                </div>
                <Slider
                  value={state.film.halation}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) => setFilm({ halation: v })}
                  onCommit={() => setFilm({}, true)}
                />
                <Slider
                  value={state.film.grain}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) => setFilm({ grain: v })}
                  onCommit={() => setFilm({}, true)}
                />
              </>
            )}

            {mode === "adjust" && (
              <>
                <div className="segrow">
                  <button className="chip" onClick={resetAll}>
                    Reset all
                  </button>
                </div>
                <Slider
                  value={state.adjust.exposure}
                  min={-3}
                  max={3}
                  step={0.05}
                  onChange={(v) => setAdjust({ exposure: v })}
                  onCommit={() => setAdjust({}, true)}
                />
                <Slider
                  value={state.adjust.contrast}
                  min={-1}
                  max={1}
                  step={0.01}
                  onChange={(v) => setAdjust({ contrast: v })}
                  onCommit={() => setAdjust({}, true)}
                />
                <Slider
                  value={state.adjust.saturation}
                  min={-1}
                  max={1}
                  step={0.01}
                  onChange={(v) => setAdjust({ saturation: v })}
                  onCommit={() => setAdjust({}, true)}
                />
                <Slider
                  value={state.adjust.temperature}
                  min={-1}
                  max={1}
                  step={0.01}
                  onChange={(v) => setAdjust({ temperature: v })}
                  onCommit={() => setAdjust({}, true)}
                />
              </>
            )}
          </div>

          <nav className="tabbar">
            {(
              [
                ["lens", "Lens", ICONS.aperture],
                ["tele", "Tele", ICONS.tele],
                ["film", "Film", ICONS.film],
                ["adjust", "Tune", ICONS.adjust],
              ] as const
            ).map(([id, label, icon]) => (
              <button key={id} className={`tab ${mode === id ? "tab--on" : ""}`} onClick={() => setMode(id)}>
                {icon}
                {label}
              </button>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

/** rel-near [0,1] → metres using the same hyperbolic prior as the warp. */
function metersFromRel(rel: number, far = 12, near = 0.35): number {
  const t = Math.min(1, Math.max(0, rel));
  return (far * near) / (near + t * (far - near));
}

function fmtSigned(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// silence unused import if tree-shaken oddly
void relFromMeters;
