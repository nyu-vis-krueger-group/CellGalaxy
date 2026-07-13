/**
 * Shared intensity windowing + tone gain.
 * With OME-TIFF: Viv + Zarr/UMAP share the same raw-unit window (from omePixelRangeByChannelId).
 * Zarr-only: same shape filled from atlas tile pixel stats (raw = gray01 * 65535).
 * Zarr atlas: gray = raw / INTENSITY_FULL_RANGE; mask icons use alpha as intensity (deck.gl IconLayer).
 * Viv: contrastLimits use the same raw [min, max] directly.
 */

export const INTENSITY_FULL_RANGE = 65535;
export const TONE_GAIN = 1.0;
/** Cap non-zero samples for percentile auto window (OME + Zarr tile paths). */
export const INTENSITY_RANGE_SAMPLE_CAP = 50000;
/**
 * Zarr cell-tile auto window (vs OME full-field 1%–99%).
 * 0.5%–99.5% of non-zero atlas pixels (raw = gray01 × 65535).
 */
export const ZARR_TILE_AUTO_MIN_PCT = 0.01;
export const ZARR_TILE_AUTO_MAX_PCT = 0.99;
/** 2× supersample + max-pool approximates deck.gl linear icon texture filtering. */
export const HOVER_ICON_SUPERSAMPLE = 2;

export function firstFinite(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Normalize data / auto bounds; fallbacks when a side is missing. */
export function normalizeIntensityRange(dataMin, dataMax, autoMin, autoMax, fallbackLo, fallbackHi) {
  const lo0 = Number.isFinite(dataMin) ? dataMin : fallbackLo;
  const hi0 = Number.isFinite(dataMax) ? dataMax : fallbackHi;
  const lo = Math.min(lo0, hi0);
  const hi = Math.max(lo0, hi0);
  const aLo0 = Number.isFinite(autoMin) ? autoMin : lo;
  const aHi0 = Number.isFinite(autoMax) ? autoMax : hi;
  const aLo = Math.min(aLo0, aHi0);
  const aHi = Math.max(aLo0, aHi0);
  return { dataMin: lo, dataMax: hi, autoMin: aLo, autoMax: aHi };
}

export function percentileFromSorted(sorted, p01) {
  if (!Array.isArray(sorted) || sorted.length === 0) return undefined;
  const p = Math.max(0, Math.min(1, p01));
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

/**
 * Viv-style channel stats from a numeric pixel buffer (OME raster or Zarr tile raws).
 * Domain min/max include zeros; auto window = 1st–99th percentile of non-zero samples.
 */
export function computeRangeFromNumericArray(values, sampleCap = INTENSITY_RANGE_SAMPLE_CAP) {
  if (!values || typeof values.length !== "number" || values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  const sample = [];
  const stride = Math.max(1, Math.floor(values.length / Math.max(1, sampleCap)));
  let sampleCursor = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v > 0) {
      if (sampleCursor % stride === 0) sample.push(v);
      sampleCursor++;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (sample.length === 0) {
    return normalizeIntensityRange(min, max, min, max, min, max);
  }
  sample.sort((a, b) => a - b);
  const autoMin = percentileFromSorted(sample, 0.01);
  const autoMax = percentileFromSorted(sample, 0.99);
  return normalizeIntensityRange(min, max, autoMin, autoMax, min, max);
}

/**
 * Merge chunk-level raw samples into a running accumulator, then finalize range.
 * Used by Zarr-only path as atlas tiles arrive.
 */
export function createIntensityRangeAccumulator(sampleCap = INTENSITY_RANGE_SAMPLE_CAP) {
  return { min: Infinity, max: -Infinity, sample: [], sampleCap };
}

export function mergeIntensitySamples(acc, values) {
  if (!acc || !values || typeof values.length !== "number" || values.length === 0) return acc;
  const cap = acc.sampleCap || INTENSITY_RANGE_SAMPLE_CAP;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (v < acc.min) acc.min = v;
    if (v > acc.max) acc.max = v;
    if (v > 0 && acc.sample.length < cap) acc.sample.push(v);
  }
  return acc;
}

/**
 * @param {object} acc
 * @param {object} [opts]
 * @param {number} [opts.autoMinPct=0.01] percentile of non-zero
 * @param {number} [opts.autoMaxPct=0.99]
 * @param {number|null} [opts.autoMinFixed] force autoMin when set
 */
export function finalizeIntensityRangeAccumulator(
  acc,
  { autoMinPct = 0.01, autoMaxPct = 0.99, autoMinFixed = null } = {},
) {
  if (!acc || !Number.isFinite(acc.min) || !Number.isFinite(acc.max)) return null;
  const sample = acc.sample;
  if (!sample || sample.length === 0) {
    return normalizeIntensityRange(acc.min, acc.max, acc.min, acc.max, acc.min, acc.max);
  }
  const sorted = sample.slice().sort((a, b) => a - b);
  const autoMax = percentileFromSorted(sorted, autoMaxPct);
  const autoMin =
    Number.isFinite(autoMinFixed)
      ? autoMinFixed
      : percentileFromSorted(sorted, autoMinPct);
  return normalizeIntensityRange(acc.min, acc.max, autoMin, autoMax, acc.min, acc.max);
}

export function intensityRangeToChannelMapEntry(r) {
  if (!r) return null;
  return {
    data_min: Number.isFinite(r.dataMin) ? r.dataMin : 0,
    data_max: Number.isFinite(r.dataMax) ? r.dataMax : INTENSITY_FULL_RANGE,
    auto_min: Number.isFinite(r.autoMin) ? r.autoMin : 0,
    auto_max: Number.isFinite(r.autoMax) ? r.autoMax : INTENSITY_FULL_RANGE,
  };
}

/**
 * Normalize OME / Zarr-derived pixel range (DataLoader / ChannelManager shape).
 * Returns null when range is unavailable.
 */
export function readOmePixelRange(omePv) {
  if (!omePv || typeof omePv !== "object") return null;
  const dataMin = firstFinite(omePv.data_min, omePv.dataMin, omePv.min);
  const dataMax = firstFinite(omePv.data_max, omePv.dataMax, omePv.max);
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return null;
  const autoMin = firstFinite(omePv.auto_min, omePv.autoMin, dataMin);
  const autoMax = firstFinite(omePv.auto_max, omePv.autoMax, dataMax);
  return {
    dataMin: Math.min(dataMin, dataMax),
    dataMax: Math.max(dataMin, dataMax),
    autoMin: Math.min(autoMin, autoMax),
    autoMax: Math.max(autoMin, autoMax),
  };
}

/** Viv-style default contrast window from OME range (auto / percentile). */
export function omeWindowDefaults(omePv) {
  const range = readOmePixelRange(omePv);
  if (!range) return null;
  return { min: range.autoMin, max: range.autoMax };
}

export function resolveRawWindow(window, defaults = { min: 0, max: INTENSITY_FULL_RANGE }) {
  const w = window || {};
  const d = defaults || { min: 0, max: INTENSITY_FULL_RANGE };
  return {
    min: Number.isFinite(w.min) ? w.min : d.min,
    max: Number.isFinite(w.max) ? w.max : d.max,
  };
}

/** True when window is missing or still the 0–65535 placeholder (not a real auto/user window). */
export function isFullRangePlaceholderWindow(window, eps = 1e-6) {
  if (!window || typeof window !== "object") return true;
  const lo = Number(window.min);
  const hi = Number(window.max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return true;
  return Math.abs(lo - 0) < eps && Math.abs(hi - INTENSITY_FULL_RANGE) < eps;
}

/**
 * Same raw-unit window for Viv contrastLimits and Zarr sprite windowing (UMAP + spatial + hover).
 * Prefer user `windows[ch]` unless it is still the full-range placeholder — then use
 * OME/Zarr-derived auto range so sprites pick up tile stats even before ChannelManager syncs.
 */
export function resolveChannelRawWindow(ch, windows, omePixelRangeByChannelId) {
  const omeDefaults = omeWindowDefaults(omePixelRangeByChannelId?.[ch]);
  const fallback = omeDefaults || { min: 0, max: INTENSITY_FULL_RANGE };
  const w = windows?.[ch] ?? windows?.[String(ch)];
  if (isFullRangePlaceholderWindow(w) && omeDefaults) {
    return { min: omeDefaults.min, max: omeDefaults.max };
  }
  return resolveRawWindow(w, fallback);
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

/** Atlas / hover path: Viv-equivalent window expressed in 0–1 (atlas = raw/65535). */
export function windowFromChannel(ch, windows, omePixelRangeByChannelId) {
  const { min, max } = resolveChannelRawWindow(ch, windows, omePixelRangeByChannelId);
  return rawWindowToNormalized01(min, max);
}

export function applyIntensityWindow01(gray01, winMin01, winMax01) {
  if (gray01 <= winMin01) return 0;
  if (gray01 >= winMax01) return 1;
  const span = Math.max(1e-6, winMax01 - winMin01);
  return (gray01 - winMin01) / span;
}

export function combinedRawWindow(channels, windows, omePixelRangeByChannelId) {
  const list = Array.isArray(channels) ? channels : [];
  if (list.length === 0) {
    return resolveChannelRawWindow(null, windows, omePixelRangeByChannelId);
  }
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (const ch of list) {
    const { min, max } = resolveChannelRawWindow(ch, windows, omePixelRangeByChannelId);
    rawMin = Math.min(rawMin, min);
    rawMax = Math.max(rawMax, max);
  }
  if (!Number.isFinite(rawMin)) {
    return resolveChannelRawWindow(null, windows, omePixelRangeByChannelId);
  }
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

export function scaleRgbByToneGain(rgb, toneGain = TONE_GAIN) {
  const [r, g, b] = rgb || [255, 255, 255];
  return [
    Math.min(255, Math.round((r ?? 255) * toneGain)),
    Math.min(255, Math.round((g ?? 255) * toneGain)),
    Math.min(255, Math.round((b ?? 255) * toneGain)),
  ];
}
