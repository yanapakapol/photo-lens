/** GLSL sources — Photo Lens WebGL2 pipeline.
 *  Original implementations. Algorithm ideas from permissive refs:
 *  BokehMe (Apache-2.0) scatter-as-gather · postfx (MIT) film order.
 *  Bokeh aperture shapes are classic optics, reimplemented from scratch. */

export const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** Telephoto warp. uMode: 0 = color, 1 = depth (r channel only).
 *  Depth is warped with the same map as color so bokeh stays registered. */
export const FRAG_WARP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform float uK;
uniform float uSubjectDepth;
uniform float uCompression;
uniform float uAspect;
uniform float uMode; // 0 color, 1 depth

void main() {
  vec2 c = vec2(0.5, 0.5);
  vec2 p = vUv - c;
  p.x *= uAspect;
  float rel = texture(uDepth, vUv).r;
  float dSub = clamp(rel - uSubjectDepth, -1.0, 1.0);
  float farBoost = uCompression * max(0.0, -dSub);
  float nearPull = uCompression * 0.4 * max(0.0, dSub);
  float s = clamp(uK * (1.0 + farBoost - nearPull), max(1.0, uK * 0.92), uK * 1.45);
  vec2 src = p / max(s, 1e-4);
  src.x /= uAspect;
  src += c;
  src = clamp(src, vec2(0.002), vec2(0.998));
  if (uMode > 0.5) {
    float d = texture(uDepth, src).r;
    frag = vec4(d, d, d, 1.0);
  } else {
    frag = texture(uColor, src);
  }
}`;

/** Depth-aware bokeh with selectable aperture style.
 *  uStyle: 0 soft · 1 bubble · 2 hex · 3 cat-eye · 4 swirl · 5 star
 *  DOF plateau keeps the whole subject plane sharp (not just a pin). */
export const FRAG_BOKEH = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform float uCocScale;
uniform float uFocusDepth;
uniform float uMaxCoc;
uniform float uHighlightBoost;
uniform float uSubjectBand; // depth units behind focus kept fully sharp (whole subject)
uniform float uNearBand;    // depth units in front of focus kept sharp before near-blur
uniform float uNearBlur;    // 0..1 strength of foreground blur (usually mild)
uniform float uBokehSize;   // highlight disc size multiplier 0–2
uniform float uStyle;
uniform float uAspect;

const int TAPS = 48;
const float GA = 2.39996323;

/** CoC (portrait-app style, asymmetric):
 *  - Subject band = hard zero (razor edges)
 *  - Far background: progressive blur that grows with distance
 *  - Near foreground: only mild (phone portrait apps barely blur near field) */
float cocOf(float rel) {
  float bandStart = uFocusDepth - uSubjectBand;
  float nearStart = uFocusDepth + uNearBand;
  if (rel >= bandStart && rel <= nearStart) return 0.0;
  if (rel < bandStart) {
    float past = bandStart - rel;
    float feather = smoothstep(0.0, 0.035, past);
    return min(uMaxCoc, feather * past * uCocScale);
  }
  float pastN = rel - nearStart;
  float featherN = smoothstep(0.0, 0.04, pastN);
  return min(uMaxCoc, featherN * pastN * uCocScale * uNearBlur);
}

// Signed aperture mask in unit disc coords (x,y in [-1,1]).
float apertureMask(vec2 q, float style, float ang) {
  float r = length(q);
  if (style < 0.5) {
    // Soft cream disc — slightly feathered edge
    return 1.0 - smoothstep(0.82, 1.0, r);
  } else if (style < 1.5) {
    // Soap-bubble: hard edge + bright rim
    float disc = 1.0 - smoothstep(0.96, 1.0, r);
    float rim = smoothstep(0.72, 0.96, r) * disc;
    return disc * (0.75 + 0.55 * rim);
  } else if (style < 2.5) {
    // Hexagonal aperture blades
    float a = atan(q.y, q.x);
    float hexR = cos(0.5236) / cos(mod(a + 3.14159 / 6.0, 1.0472) - 0.5236); // π/3 sectors
    return 1.0 - smoothstep(hexR * 0.92, hexR, r);
  } else if (style < 3.5) {
    // Cat-eye: ellipse pinched toward frame edge
    vec2 e = q;
    e.x *= 0.55; // oval
    float rr = length(e);
    return 1.0 - smoothstep(0.85, 1.0, rr);
  } else if (style < 4.5) {
    // Swirl / Petzval-like: soft disc with angular weight
    float a2 = atan(q.y, q.x);
    float swirl = 0.55 + 0.45 * sin(a2 * 3.0 + r * 6.0);
    return (1.0 - smoothstep(0.75, 1.0, r)) * swirl;
  } else {
    // Star / anamorphic-ish: soft disc + cross streaks
    float disc = 1.0 - smoothstep(0.7, 1.0, r);
    float streak = pow(max(0.0, 1.0 - abs(q.x) * 1.1), 3.0) + pow(max(0.0, 1.0 - abs(q.y) * 1.1), 3.0);
    return clamp(disc * 0.75 + streak * 0.55 * (1.0 - smoothstep(0.9, 1.15, r)), 0.0, 1.0);
  }
}

void main() {
  float rel = texture(uDepth, vUv).r;
  float coc = cocOf(rel);
  vec3 center = texture(uColor, vUv).rgb;
  if (coc < 0.85) {
    frag = vec4(center, 1.0);
    return;
  }

  float lum = dot(center, vec3(0.2126, 0.7152, 0.0722));
  // Bright points become large bokeh balls; scale with uBokehSize.
  float hi = smoothstep(0.55, 0.95, lum);
  float hGain = uHighlightBoost * (0.4 + 2.2 * hi) * mix(1.0, 1.8, uBokehSize - 1.0 > 0.0 ? min(uBokehSize - 1.0, 1.0) : 0.0);
  // Highlight pixels use a larger effective disc (the “ดวง bokeh”)
  float radius = coc * mix(1.0, 1.0 + 0.9 * uBokehSize * hi, 1.0);
  radius = max(radius, coc);

  vec3 c0 = center * (1.0 + hGain * hi);

  vec2 centerUV = vUv - 0.5;
  vec3 sum = c0 * 0.28;
  float wsum = 0.28;

  for (int i = 1; i <= TAPS; i++) {
    float fi = float(i);
    float rn = sqrt(fi / float(TAPS));
    float a = fi * GA;
    vec2 dir = vec2(cos(a), sin(a));
    vec2 q = dir * rn;
    if (uStyle > 3.5 && uStyle < 4.5) {
      float twist = rn * 2.4;
      float ca = cos(twist), sa = sin(twist);
      q = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);
    }
    if (uStyle > 2.5 && uStyle < 3.5) {
      float edge = length(centerUV) * 1.6;
      q.x *= mix(1.0, 0.35, clamp(edge, 0.0, 1.0));
    }

    float mask = apertureMask(q, uStyle, a);
    if (mask <= 0.01) continue;

    vec2 offset = q * radius * uTexel;
    vec2 uvc = clamp(vUv + offset, vec2(0.0), vec2(1.0));
    float dist = rn * radius;

    float relT = texture(uDepth, uvc).r;
    float cocT = cocOf(relT);
    if (cocT < 0.5 && relT > uFocusDepth - uSubjectBand) continue; // don't pull sharp subject
    float reach = max(cocT, coc);
    float w = smoothstep(reach + 1.0, reach - 1.5, dist);
    if (relT > rel + 0.04 && cocT > 1.5 && coc > 1.0) {
      w = max(w, smoothstep(cocT + 1.0, cocT - 2.0, dist));
    }
    if (w <= 0.001) continue;

    vec3 ct = texture(uColor, uvc).rgb;
    float lumT = dot(ct, vec3(0.2126, 0.7152, 0.0722));
    // Strong bright-sample weight → visible bokeh balls from point lights
    float hiT = smoothstep(0.5, 0.92, lumT);
    ct *= 1.0 + hGain * (0.3 + 1.6 * hiT);
    w *= mask * (0.25 + 0.75 * hiT) * (1.0 - smoothstep(0.86, 1.08, rn));
    // Soft disc edge for bubble-like rim
    if (uStyle > 0.5 && uStyle < 1.5) {
      w *= 1.0 + 0.45 * smoothstep(0.7, 0.95, rn) * (1.0 - smoothstep(0.95, 1.05, rn));
    }
    sum += ct * w;
    wsum += w;
  }
  frag = vec4(sum / max(wsum, 1e-4), 1.0);
}`;

export const FRAG_HALATION_PREFILTER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uColor;
uniform float uThreshold;
uniform float uKnee;
uniform vec2 uTexel;

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  vec2 o = uTexel * 0.5;
  vec3 c0 = toLinear(texture(uColor, vUv + vec2(-o.x, -o.y)).rgb);
  vec3 c1 = toLinear(texture(uColor, vUv + vec2( o.x, -o.y)).rgb);
  vec3 c2 = toLinear(texture(uColor, vUv + vec2(-o.x,  o.y)).rgb);
  vec3 c3 = toLinear(texture(uColor, vUv + vec2( o.x,  o.y)).rgb);
  vec3 acc = (c0 + c1 + c2 + c3) * 0.25;
  float lum = dot(acc, vec3(0.2126, 0.7152, 0.0722));
  float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, lum - uThreshold) / max(lum, 1e-4);
  frag = vec4(acc * contrib, 1.0);
}`;

export const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uColor;
uniform vec2 uDir;
uniform float uSigma;

void main() {
  float weights[5];
  weights[0] = 0.227027;
  weights[1] = 0.1945946;
  weights[2] = 0.1216216;
  weights[3] = 0.054054;
  weights[4] = 0.016216;
  vec3 acc = texture(uColor, vUv).rgb * weights[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i) * uSigma;
    acc += texture(uColor, vUv + o).rgb * weights[i];
    acc += texture(uColor, vUv - o).rgb * weights[i];
  }
  frag = vec4(acc, 1.0);
}`;

export const FRAG_FILM = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uColor;
uniform sampler2D uHalation;
uniform sampler2D uOriginal;
uniform vec2 uTexel;
uniform float uSeed;
uniform float uIntensity;
uniform float uHalationAmt;
uniform float uGrainAmt;
uniform float uGrainSize;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
uniform vec3 uShadowTint;
uniform vec3 uMidTint;
uniform vec3 uHighTint;
uniform float uCurve;
uniform float uSatFilm;
uniform float uCompareX;
uniform float uShowOriginal;

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSRgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 grade(vec3 lin) {
  lin *= exp2(uExposure);
  float t = uTemperature;
  lin *= vec3(1.0 + t * 0.12, 1.0 + t * 0.02, 1.0 - t * 0.14);
  float l = luma(lin);
  vec3 tint = mix(uShadowTint, uMidTint, smoothstep(0.0, 0.45, l));
  tint = mix(tint, uHighTint, smoothstep(0.55, 1.0, l));
  lin = mix(lin, lin * tint, uIntensity);
  float k = uCurve * uIntensity + uContrast * 0.5;
  if (abs(k) > 0.001) {
    vec3 x = lin;
    vec3 s = x * x * (3.0 - 2.0 * clamp(x, 0.0, 1.0));
    lin = mix(x, s, clamp(k, -0.9, 0.95));
  }
  vec3 hal = texture(uHalation, vUv).rgb;
  lin += hal * vec3(1.0, 0.55, 0.35) * uHalationAmt * uIntensity;
  return lin;
}

void main() {
  if (uShowOriginal > 0.5 || (uCompareX >= 0.0 && vUv.x < uCompareX)) {
    frag = vec4(texture(uOriginal, vUv).rgb, 1.0);
    return;
  }
  vec3 src = texture(uColor, vUv).rgb;
  vec3 lin = grade(toLinear(src));
  vec3 outc = toSRgb(lin);
  float sat = mix(1.0, uSatFilm * (1.0 + uSaturation), uIntensity);
  float l = luma(outc);
  outc = mix(vec3(l), outc, sat);
  if (uGrainAmt > 0.001) {
    vec2 gp = vUv / (uTexel * max(uGrainSize, 0.5));
    float n1 = hash(floor(gp) + uSeed);
    float n2 = hash(floor(gp) + uSeed + 19.19);
    float g = (n1 + n2 - 1.0);
    float D = luma(outc);
    float selwyn = sqrt(max(D, 0.02)) * 0.7 + exp(-2.0 * D) * 0.45;
    selwyn *= 1.0 + 0.35 * smoothstep(0.75, 1.0, D);
    outc += g * selwyn * uGrainAmt * 0.11 * mix(1.0, uIntensity, 0.8);
  }
  vec2 q = vUv - 0.5;
  outc *= 1.0 - dot(q, q) * 0.28 * uIntensity;
  frag = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;
