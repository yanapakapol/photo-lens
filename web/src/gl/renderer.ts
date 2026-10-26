import {
  VERT,
  FRAG_WARP,
  FRAG_BOKEH,
  FRAG_HALATION_PREFILTER,
  FRAG_BLUR,
  FRAG_FILM,
} from "./shaders";
import { getStock } from "../core/film";
import { type DepthMap, type PipelineState } from "../core/types";

/** Multi-pass WebGL2 renderer for the Photo Lens pipeline.
 *  color → [warp] → [disc bokeh] → [halation] → [film+grain] → canvas
 *
 *  Texture convention: color uploaded with UNPACK_FLIP_Y_WEBGL=1 (upright);
 *  depth rows are flipped at pack time so both share the same V axis. */
export class LensRenderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private quad: WebGLBuffer;
  private programs: Record<string, WebGLProgram> = {};
  private colorTex: WebGLTexture | null = null;
  private depthTex: WebGLTexture | null = null;
  private fbos: Record<string, { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }> = {};
  private imgW = 0;
  private imgH = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      preserveDrawingBuffer: true,
      antialias: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.canvas = canvas;
    gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("OES_texture_float_linear");

    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.quad = quad;

    this.programs.warp = this.compile(FRAG_WARP);
    this.programs.bokeh = this.compile(FRAG_BOKEH);
    this.programs.pre = this.compile(FRAG_HALATION_PREFILTER);
    this.programs.blur = this.compile(FRAG_BLUR);
    this.programs.film = this.compile(FRAG_FILM);
  }

  private compile(frag: string): WebGLProgram {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, frag);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(fs));
      throw new Error("Shader compile failed");
    }
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(p));
      throw new Error("Program link failed");
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
  }

  private bindQuad(prog: WebGLProgram) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private makeTarget(key: string, w: number, h: number, float = false) {
    const gl = this.gl;
    const prev = this.fbos[key];
    if (prev && prev.w === w && prev.h === h) return prev;
    if (prev) {
      gl.deleteFramebuffer(prev.fb);
      gl.deleteTexture(prev.tex);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      float ? gl.RGBA16F : gl.RGBA8,
      w,
      h,
      0,
      gl.RGBA,
      float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const entry = { fb, tex, w, h };
    this.fbos[key] = entry;
    return entry;
  }

  setImage(image: ImageBitmap | HTMLCanvasElement | HTMLImageElement, depth: DepthMap) {
    const gl = this.gl;
    const w = "width" in image ? image.width : (image as HTMLImageElement).naturalWidth;
    const h = "height" in image ? image.height : (image as HTMLImageElement).naturalHeight;
    this.imgW = w;
    this.imgH = h;
    this.canvas.width = w;
    this.canvas.height = h;

    // ImageBitmap ignores UNPACK_FLIP_Y_WEBGL in Chromium — always
    // re-draw onto a canvas and upload that with flipY=1.
    let source: HTMLCanvasElement | HTMLImageElement = image as HTMLCanvasElement;
    if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d")!.drawImage(image, 0, 0);
      source = cv;
    }

    if (this.colorTex) gl.deleteTexture(this.colorTex);
    this.colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);

    if (this.depthTex) gl.deleteTexture(this.depthTex);
    this.depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    // Pack rel-near into R8. Typed-array uploads are NOT flipped by
    // UNPACK_FLIP_Y, so flip rows here to match the color texture.
    const packed = new Uint8Array(depth.width * depth.height);
    for (let y = 0; y < depth.height; y++) {
      const srcY = depth.height - 1 - y;
      for (let x = 0; x < depth.width; x++) {
        packed[y * depth.width + x] =
          Math.round(Math.min(1, Math.max(0, depth.data[srcY * depth.width + x])) * 255);
      }
    }
    // Reset flip so later DOM uploads stay consistent
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, depth.width, depth.height, 0, gl.RED, gl.UNSIGNED_BYTE, packed);
  }

  /** Update depth only (AI finished) without reloading color. */
  setDepth(depth: DepthMap) {
    const gl = this.gl;
    if (!this.depthTex) return;
    const packed = new Uint8Array(depth.width * depth.height);
    for (let y = 0; y < depth.height; y++) {
      const srcY = depth.height - 1 - y;
      for (let x = 0; x < depth.width; x++) {
        packed[y * depth.width + x] =
          Math.round(Math.min(1, Math.max(0, depth.data[srcY * depth.width + x])) * 255);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, depth.width, depth.height, 0, gl.RED, gl.UNSIGNED_BYTE, packed);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  }

  render(
    state: PipelineState,
    opts: { compareX: number; showOriginal: boolean; depthPeek: boolean },
  ) {
    const gl = this.gl;
    if (!this.colorTex || !this.depthTex) return;
    const W = this.imgW;
    const H = this.imgH;
    const aspect = W / H;

    const maxEdge = 2048;
    const scale = Math.max(W, H) > maxEdge ? maxEdge / Math.max(W, H) : 1;
    const ww = Math.max(1, Math.round(W * scale));
    const wh = Math.max(1, Math.round(H * scale));

    const warped = this.makeTarget("warped", ww, wh);
    const warpedDepth = this.makeTarget("warpedDepth", ww, wh);
    const bokeh = this.makeTarget("bokeh", ww, wh);
    const half = this.makeTarget("half", Math.max(1, ww >> 1), Math.max(1, wh >> 1), true);
    const half2 = this.makeTarget("half2", half.w, half.h, true);

    let currentTex: WebGLTexture = this.colorTex;
    let currentDepth: WebGLTexture = this.depthTex;

    // --- Pass 1: telephoto warp color + depth together (skip when k≈1) ---
    const k = state.tele.k;
    if (Math.abs(k - 1) > 0.005) {
      const p = this.programs.warp;
      this.bindQuad(p);
      const uMode = gl.getUniformLocation(p, "uMode");
      const uColor = gl.getUniformLocation(p, "uColor");
      const uDepth = gl.getUniformLocation(p, "uDepth");
      const uK = gl.getUniformLocation(p, "uK");
      const uSub = gl.getUniformLocation(p, "uSubjectDepth");
      const uComp = gl.getUniformLocation(p, "uCompression");
      const uAsp = gl.getUniformLocation(p, "uAspect");

      // Color
      gl.bindFramebuffer(gl.FRAMEBUFFER, warped.fb);
      gl.viewport(0, 0, ww, wh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
      gl.uniform1i(uColor, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      gl.uniform1i(uDepth, 1);
      gl.uniform1f(uK, k);
      gl.uniform1f(uSub, relFromMeters(state.tele.subjectM));
      gl.uniform1f(uComp, 0.22 * Math.min(1, (k - 1) * 1.4));
      gl.uniform1f(uAsp, aspect);
      gl.uniform1f(uMode, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      currentTex = warped.tex;

      // Depth (same warp map → stays registered with color)
      gl.bindFramebuffer(gl.FRAMEBUFFER, warpedDepth.fb);
      gl.viewport(0, 0, ww, wh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTex); // unused in depth mode but bound
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      gl.uniform1f(uMode, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      currentDepth = warpedDepth.tex;
    }

    // --- Pass 2: disc bokeh (skip when strength=0) ---
    const strength = state.lens.strength;
    if (strength > 0.01) {
      const p = this.programs.bokeh;
      this.bindQuad(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bokeh.fb);
      gl.viewport(0, 0, ww, wh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, currentTex);
      gl.uniform1i(gl.getUniformLocation(p, "uColor"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, currentDepth);
      gl.uniform1i(gl.getUniformLocation(p, "uDepth"), 1);
      gl.uniform2f(gl.getUniformLocation(p, "uTexel"), 1 / ww, 1 / wh);
      gl.uniform1f(gl.getUniformLocation(p, "uAspect"), aspect);

      // Aperture diameter ∝ f/N — drives max blur and subject-band thickness.
      const fStop = Math.max(0.7, state.lens.fNumber);
      const focal = state.lens.focalMm;
      const apertureGain = (focal / 35) * (1.8 / fStop);
      const resGain = ww / 1100;
      // Background blur grows with distance behind subject (progressive).
      const cocScale = 85 * apertureGain * resGain * strength;
      const maxCoc = Math.min(
        48 * apertureGain * resGain * strength,
        Math.min(ww, wh) * 0.05,
      );
      // Whole-subject keep-sharp band: wider aperture → slightly thinner band
      // but still thick enough to cover a full person (not a pin on the face).
      // f/1.4 ≈ 0.28 depth units; f/5.6 ≈ 0.45 (almost everything sharp).
      const subjectBand = 0.22 + 0.18 * (1.4 / fStop);
      // Foreground (nearer than subject) stays sharp for a while, then mild blur.
      const nearBand = 0.12;
      const nearBlur = 0.35 * strength; // subtle — phone portrait apps barely blur near field

      const styleIds: Record<string, number> = {
        soft: 0, bubble: 1, hex: 2, cateye: 3, swirl: 4, star: 5,
      };

      gl.uniform1f(gl.getUniformLocation(p, "uCocScale"), cocScale);
      gl.uniform1f(gl.getUniformLocation(p, "uFocusDepth"), state.lens.focusRel);
      gl.uniform1f(gl.getUniformLocation(p, "uMaxCoc"), Math.max(1.0, maxCoc));
      gl.uniform1f(gl.getUniformLocation(p, "uHighlightBoost"), 0.35 * strength);
      gl.uniform1f(gl.getUniformLocation(p, "uSubjectBand"), subjectBand);
      gl.uniform1f(gl.getUniformLocation(p, "uNearBand"), nearBand);
      gl.uniform1f(gl.getUniformLocation(p, "uNearBlur"), nearBlur);
      gl.uniform1f(gl.getUniformLocation(p, "uStyle"), styleIds[state.lens.style] ?? 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      currentTex = bokeh.tex;
    }

    // --- Pass 3: halation brightpass + separable blur (linear) ---
    const stock = getStock(state.film.stock);
    const useHalation =
      state.film.stock === "none"
        ? state.film.halation > 0.01
        : state.film.halation * stock.halationBias > 0.01;
    if (useHalation) {
      const pre = this.programs.pre;
      this.bindQuad(pre);
      gl.bindFramebuffer(gl.FRAMEBUFFER, half.fb);
      gl.viewport(0, 0, half.w, half.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, currentTex);
      gl.uniform1i(gl.getUniformLocation(pre, "uColor"), 0);
      gl.uniform1f(gl.getUniformLocation(pre, "uThreshold"), 0.65);
      gl.uniform1f(gl.getUniformLocation(pre, "uKnee"), 0.22);
      gl.uniform2f(gl.getUniformLocation(pre, "uTexel"), 1 / ww, 1 / wh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const blur = this.programs.blur;
      this.bindQuad(blur);
      gl.bindFramebuffer(gl.FRAMEBUFFER, half2.fb);
      gl.viewport(0, 0, half2.w, half2.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, half.tex);
      gl.uniform1i(gl.getUniformLocation(blur, "uColor"), 0);
      gl.uniform2f(gl.getUniformLocation(blur, "uDir"), 1.8 / half.w, 0);
      gl.uniform1f(gl.getUniformLocation(blur, "uSigma"), 2.4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, half.fb);
      gl.viewport(0, 0, half.w, half.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, half2.tex);
      gl.uniform2f(gl.getUniformLocation(blur, "uDir"), 0, 1.8 / half.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // --- Pass 4: film composite (with true original for compare) ---
    const p = this.programs.film;
    this.bindQuad(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, ww, wh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTex);
    gl.uniform1i(gl.getUniformLocation(p, "uColor"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, half.tex);
    gl.uniform1i(gl.getUniformLocation(p, "uHalation"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.uniform1i(gl.getUniformLocation(p, "uOriginal"), 2);
    gl.uniform2f(gl.getUniformLocation(p, "uTexel"), 1 / ww, 1 / wh);
    gl.uniform1f(gl.getUniformLocation(p, "uSeed"), 17.13);
    gl.uniform1f(gl.getUniformLocation(p, "uIntensity"), state.film.intensity);
    gl.uniform1f(
      gl.getUniformLocation(p, "uHalationAmt"),
      state.film.stock === "none"
        ? state.film.halation * 0.55
        : state.film.halation * stock.halationBias * 1.35,
    );
    gl.uniform1f(
      gl.getUniformLocation(p, "uGrainAmt"),
      state.film.stock === "none" ? state.film.grain * 0.45 : state.film.grain * stock.grainBias,
    );
    gl.uniform1f(gl.getUniformLocation(p, "uGrainSize"), Math.max(0.6, stock.grainSize * (ww / 1200)));
    gl.uniform1f(gl.getUniformLocation(p, "uExposure"), state.adjust.exposure);
    gl.uniform1f(gl.getUniformLocation(p, "uContrast"), state.adjust.contrast);
    gl.uniform1f(gl.getUniformLocation(p, "uSaturation"), state.adjust.saturation);
    gl.uniform1f(gl.getUniformLocation(p, "uTemperature"), state.adjust.temperature);
    gl.uniform3fv(gl.getUniformLocation(p, "uShadowTint"), stock.shadowTint);
    gl.uniform3fv(gl.getUniformLocation(p, "uMidTint"), stock.midTint);
    gl.uniform3fv(gl.getUniformLocation(p, "uHighTint"), stock.highlightTint);
    gl.uniform1f(gl.getUniformLocation(p, "uCurve"), stock.curve);
    gl.uniform1f(gl.getUniformLocation(p, "uSatFilm"), stock.sat);
    gl.uniform3fv(gl.getUniformLocation(p, "uMonoMix"), stock.monoMix ?? [0, 0, 0]);
    gl.uniform1f(gl.getUniformLocation(p, "uCompareX"), opts.compareX);
    gl.uniform1f(gl.getUniformLocation(p, "uShowOriginal"), opts.showOriginal || opts.depthPeek ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  exportBlob(type = "image/jpeg", quality = 0.92): Promise<Blob | null> {
    return new Promise((resolve) => this.canvas.toBlob(resolve, type, quality));
  }

  /** Read depth as ImageData for the peek overlay (CPU path). */
  depthToImageData(depth: DepthMap, w: number, h: number): ImageData {
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(depth.height - 1, Math.floor((y / h) * depth.height));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(depth.width - 1, Math.floor((x / w) * depth.width));
        const v = Math.round(depth.data[sy * depth.width + sx] * 255);
        const i = (y * w + x) * 4;
        out.data[i] = Math.min(255, v * 1.2);
        out.data[i + 1] = Math.min(255, (v / 255) ** 2 * 255);
        out.data[i + 2] = Math.min(255, 40 + v * 80);
        out.data[i + 3] = 255;
      }
    }
    return out;
  }
}

/** Inverse of depthToMeters: metres → rel near [0,1]. Uses same prior as warp. */
export function relFromMeters(m: number, far = 12, near = 0.35): number {
  const t = ((far * near) / Math.max(m, near) - near) / (far - near);
  return Math.min(1, Math.max(0, t));
}
