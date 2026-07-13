/**
 * Per-tile atlas signal cache for UMAP empty-tile filtering.
 * Atlas gray = raw/65535 (full scale 0..65535). We store tile mean in 0–1,
 * then score in raw units so display window stretch cannot revive empty tiles.
 * Same pass can collect raw pixel samples for Zarr-only intensity range.
 */
import {
  applyIntensityWindow01,
  INTENSITY_FULL_RANGE,
  INTENSITY_RANGE_SAMPLE_CAP,
  readAtlasIntensity01,
  windowFromChannel,
} from "./intensityWindow";
import { loadImageCached } from "./loadImageCached";

/**
 * Minimum composite tile mean in raw units (0..65535 × alpha sum).
 * Edge-only / haze tiles stay below this; real content usually clears it.
 */
export const TILE_SIGNAL_MIN_RAW = 1900;

/** Also require some post-window response (drops tiles entirely below contrast min). */
export const TILE_SIGNAL_MIN_WINDOWED = 0.02;

/**
 * Scan one atlas PNG once:
 * - means: Float32Array[local_index] = mean intensity in 0–1
 * - rawSamples: subsampled raw intensities (gray01 * 65535) for range stats
 */
export async function scanAtlasTileStats(
  atlasUrl,
  { tile, cols, nTiles },
  { collectSamples = false, sampleCap = INTENSITY_RANGE_SAMPLE_CAP } = {},
) {
  const t = Number(tile) || 16;
  const c = Number(cols);
  const n = Number(nTiles);
  if (!atlasUrl || !Number.isFinite(c) || c <= 0 || !Number.isFinite(n) || n <= 0) {
    return null;
  }
  const img = await loadImageCached(String(atlasUrl));
  if (!img) return null;

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);

  const means = new Float32Array(n);
  const rawSamples = collectSamples ? [] : null;
  const pixelBudget = Math.max(1, n * t * t);
  const stride = collectSamples
    ? Math.max(1, Math.floor(pixelBudget / Math.max(1, sampleCap)))
    : 1;
  let sampleCursor = 0;

  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / c);
    const col = i % c;
    const x0 = col * t;
    const y0 = row * t;
    let sum = 0;
    let count = 0;
    for (let dy = 0; dy < t; dy++) {
      const yy = y0 + dy;
      if (yy >= h) break;
      for (let dx = 0; dx < t; dx++) {
        const xx = x0 + dx;
        if (xx >= w) break;
        const bi = (yy * w + xx) * 4;
        const g01 = readAtlasIntensity01(data, bi);
        sum += g01;
        count++;
        if (rawSamples) {
          if (sampleCursor % stride === 0) {
            rawSamples.push(g01 * INTENSITY_FULL_RANGE);
          }
          sampleCursor++;
        }
      }
    }
    means[i] = count > 0 ? sum / count : 0;
  }
  return { means, rawSamples };
}

/**
 * Scan one atlas PNG → Float32Array[local_index] = mean intensity in 0–1
 * (atlas encodes raw/65535).
 */
export async function scanAtlasTileMean01(atlasUrl, layout) {
  const stats = await scanAtlasTileStats(atlasUrl, layout, { collectSamples: false });
  return stats?.means ?? null;
}

/** Layout from /atlas_uv response (or infer from atlas pixel size). */
export function atlasLayoutFromUv(uvMeta, tileFallback = 16) {
  if (!uvMeta || typeof uvMeta !== "object") return null;
  const tile = Number(uvMeta.tile) || tileFallback;
  const cols = Number(uvMeta.cols);
  const nTiles = Array.isArray(uvMeta.uv) ? uvMeta.uv.length : Number(uvMeta.n);
  if (!Number.isFinite(cols) || cols <= 0 || !Number.isFinite(nTiles) || nTiles <= 0) {
    return null;
  }
  return { tile, cols, nTiles };
}

/**
 * Composite scores for one point across active channels.
 * - meanRaw: Σ mean01 * 65535 * alpha  (absolute content, 0..65535 scale)
 * - windowed: Σ window(mean01) * alpha (respects contrast; 0 if below window)
 * Returns null if any active channel is not scanned yet for this chunk.
 */
export function compositeTileSignalScore(
  point,
  {
    channels,
    tileSignalByChannel,
    windows = {},
    alphas = {},
    omePixelRangeByChannelId = {},
  },
) {
  const list = Array.isArray(channels) ? channels : [];
  if (list.length === 0 || !point) return null;

  const chunkId = point.chunk_id ?? 0;
  const local = point.local_index;
  if (!Number.isFinite(local) || local < 0) return null;

  let meanRaw = 0;
  let windowed = 0;
  let saw = false;
  let missing = false;
  for (const ch of list) {
    const byChunk = tileSignalByChannel?.[ch] ?? tileSignalByChannel?.[String(ch)];
    const arr = byChunk?.[chunkId] ?? byChunk?.[String(chunkId)];
    if (!arr || local >= arr.length) {
      missing = true;
      continue;
    }
    saw = true;
    const mean01 = arr[local] ?? 0;
    const { winMin01, winMax01 } = windowFromChannel(
      ch,
      windows,
      omePixelRangeByChannelId,
    );
    const a = Math.min(1, Math.max(0, alphas?.[ch] ?? 1));
    meanRaw += mean01 * INTENSITY_FULL_RANGE * a;
    windowed += applyIntensityWindow01(mean01, winMin01, winMax01) * a;
  }
  if (missing || !saw) return null;
  return { meanRaw, windowed };
}

/**
 * True when every active channel has a scanned array for every chunk present in points.
 * Until then, empty-tile filtering should stay off to avoid progressive flicker.
 */
export function tileSignalsReadyForPoints(points, channels, tileSignalByChannel) {
  const list = Array.isArray(channels) ? channels : [];
  if (list.length === 0) return true;
  if (!Array.isArray(points) || points.length === 0) return true;

  const chunks = new Set();
  for (let i = 0; i < points.length; i++) {
    const c = points[i]?.chunk_id ?? 0;
    chunks.add(c);
  }

  for (const ch of list) {
    const byChunk = tileSignalByChannel?.[ch] ?? tileSignalByChannel?.[String(ch)];
    if (!byChunk) return false;
    for (const chunkId of chunks) {
      const arr = byChunk[chunkId] ?? byChunk[String(chunkId)];
      if (!arr) return false;
    }
  }
  return true;
}

/**
 * One-pass filter + score + sort for UMAP candidate pool.
 * When applyFilter is false (signals not ready / no channels), keep all points.
 */
export function buildScoredEligibleItems(
  points,
  opts,
  {
    applyFilter = true,
    minRaw = TILE_SIGNAL_MIN_RAW,
    minWindowed = TILE_SIGNAL_MIN_WINDOWED,
  } = {},
) {
  if (!Array.isArray(points) || points.length === 0) return [];

  const items = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let score = 0;
    if (applyFilter) {
      const s = compositeTileSignalScore(p, opts);
      // Ready path: missing score should not keep the point (treat as empty).
      if (s == null) continue;
      if (!(s.meanRaw > minRaw && s.windowed > minWindowed)) continue;
      score = s.meanRaw;
    }
    const x = Number(p?.x);
    const y = Number(p?.y);
    items.push({
      p,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      score,
      id: Number.isFinite(p?.id) ? p.id : i,
    });
  }
  items.sort((a, b) => b.score - a.score || a.id - b.id);
  return items;
}

/** True if point should stay in the UMAP candidate pool. */
export function passesTileSignalFilter(
  point,
  opts,
  minRaw = TILE_SIGNAL_MIN_RAW,
  minWindowed = TILE_SIGNAL_MIN_WINDOWED,
) {
  const score = compositeTileSignalScore(point, opts);
  // No data yet → keep (callers that gate on tileSignalsReadyForPoints skip this path).
  if (score == null) return true;
  return score.meanRaw > minRaw && score.windowed > minWindowed;
}
