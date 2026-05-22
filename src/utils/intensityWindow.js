/**
 * Shared intensity windowing + tone gain.
 * Zarr atlas: gray = raw / INTENSITY_FULL_RANGE; mask icons use alpha as intensity (deck.gl IconLayer).
 */

export const INTENSITY_FULL_RANGE = 65535;
export const TONE_GAIN = 1.35;
/** Legacy server PNG only; UMAP sprites do not clear sub-threshold pixels. */
export const ALPHA_VISIBLE_MIN = 5 / 255;
/** 2× supersample + max-pool approximates deck.gl linear icon texture filtering. */
export const HOVER_ICON_SUPERSAMPLE = 2;

export function resolveRawWindow(window, defaults = { min: 0, max: INTENSITY_FULL_RANGE }) {
  const w = window || {};
  return {
    min: Number.isFinite(w.min) ? w.min : defaults.min,
    max: Number.isFinite(w.max) ? w.max : defaults.max,
  };
}

export function rawWindowToNormalized01(min, max, fullRange = INTENSITY_FULL_RANGE) {
  const winMin01 = Math.max(0, Math.min(1, min / fullRange));
  const winMax01 = Math.max(0, Math.min(1, max / fullRange));
  return {
    winMin01,
    winMax01,
    span: Math.max(1e-6, winMax01 - winMin01),
  };
}

export function windowFromChannel(ch, windows) {
  const { min, max } = resolveRawWindow(windows?.[ch]);
  return rawWindowToNormalized01(min, max);
}

export function applyIntensityWindow01(gray01, winMin01, winMax01) {
  if (gray01 <= winMin01) return 0;
  if (gray01 >= winMax01) return 1;
  const span = Math.max(1e-6, winMax01 - winMin01);
  return (gray01 - winMin01) / span;
}

export function combinedRawWindow(channels, windows) {
  const list = Array.isArray(channels) ? channels : [];
  if (list.length === 0) return resolveRawWindow(null);
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (const ch of list) {
    const { min, max } = resolveRawWindow(windows?.[ch]);
    rawMin = Math.min(rawMin, min);
    rawMax = Math.max(rawMax, max);
  }
  if (!Number.isFinite(rawMin)) return resolveRawWindow(null);
  return { min: rawMin, max: rawMax };
}

/**
 * Mask-mode icon intensity (IconLayer: mix(tex.rgb, tint, 1) → tint; alpha = tex.a).
 * Matches WindowedIconLayer `iconA = color.a`.
 */
export function readAtlasIntensity01(data, pixelByteIndex) {
  const i = pixelByteIndex;
  const a = data[i + 3] / 255;
  const r = data[i] / 255;
  const g = data[i + 1] / 255;
  const b = data[i + 2] / 255;
  return Math.max(a, r, g, b);
}

/**
 * Per-channel layer output before additive blend (shader: min(tint * v * toneGain, 1)).
 * v = window(iconA) * channelAlpha; tint is not multiplied by gray in mask mode.
 */
export function maskModeChannelRgb255(col, v, toneGain = TONE_GAIN) {
  if (v <= 0) return { r: 0, g: 0, b: 0 };
  return {
    r: (col[0] ?? 255) * v * toneGain,
    g: (col[1] ?? 255) * v * toneGain,
    b: (col[2] ?? 255) * v * toneGain,
  };
}

export function clampAccumulatedRgb(r, g, b, a) {
  return {
    r: Math.min(255, Math.max(0, r)),
    g: Math.min(255, Math.max(0, g)),
    b: Math.min(255, Math.max(0, b)),
    a: Math.min(255, Math.max(0, a)),
  };
}

/**
 * Max-pool icon intensity from SS× supersampled (linear) tile crop.
 */
export function sampleIconIntensityGrid(imageData, outW, outH, supersample = HOVER_ICON_SUPERSAMPLE) {
  const data = imageData.data;
  const sw = outW * supersample;
  const grid = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let iconA = 0;
      for (let dy = 0; dy < supersample; dy++) {
        for (let dx = 0; dx < supersample; dx++) {
          const bi = ((y * supersample + dy) * sw + (x * supersample + dx)) * 4;
          iconA = Math.max(iconA, readAtlasIntensity01(data, bi));
        }
      }
      grid[y * outW + x] = iconA;
    }
  }
  return grid;
}

export function applyToneGainRgb(r, g, b, a, toneGain = TONE_GAIN, clearSubThreshold = true) {
  if (clearSubThreshold && a < ALPHA_VISIBLE_MIN * 255) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  return {
    r: Math.min(255, r * toneGain),
    g: Math.min(255, g * toneGain),
    b: Math.min(255, b * toneGain),
    a: Math.max(0, Math.min(255, a)),
  };
}

export function scaleRgbByToneGain(rgb, toneGain = TONE_GAIN) {
  const [r, g, b] = rgb || [255, 255, 255];
  return [
    Math.min(255, Math.round((r ?? 255) * toneGain)),
    Math.min(255, Math.round((g ?? 255) * toneGain)),
    Math.min(255, Math.round((b ?? 255) * toneGain)),
  ];
}
