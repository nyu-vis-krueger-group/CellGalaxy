/**
 * UMAP near-duplicate tile suppression (world-space grid).
 *
 * DeckViewState keeps sprite *world* footprint constant while zooming:
 *   worldTile = computedImageSize / 2^zoom = imageSize / 2^baseZoom
 * So overlap radius must use (imageSize, baseZoom) — not live zoom —
 * otherwise every scroll tick re-dedups for a mathematically identical radius.
 *
 * Icons are axis-aligned squares → Chebyshev distance (max(|dx|,|dy|)).
 */

/** Centers closer than this × tile edge (world, Chebyshev) → keep stronger only. */
export const TILE_OVERLAP_RATIO = 0.8;

/**
 * World-space exclusion radius from slider size at marker zoom baseline.
 * @param {number} tilePxAtBaseZoom - effectiveImageSize (slider), not computedImageSize
 * @param {number} baseZoom - DeckViewState marker baseline zoom
 */
export function worldOverlapRadius(tilePxAtBaseZoom, baseZoom) {
  const s = Math.max(1e-3, Number(tilePxAtBaseZoom) || 0);
  const z = Number.isFinite(baseZoom) ? baseZoom : 0;
  return TILE_OVERLAP_RATIO * s * Math.pow(2, -z);
}

/**
 * Greedy dedup over already scored+sorted items:
 * `{ p, x, y, score, id }[]` sorted by score desc.
 * O(n) with grid hashing. Chebyshev metric for square icons.
 */
export function dedupPrescoredByOverlap(items, radius) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!(radius > 0) || !Number.isFinite(radius)) {
    return items.map((it) => it.p);
  }

  const cell = radius;
  const grid = new Map();
  const kept = [];
  const bucketKey = (ix, iy) => `${ix},${iy}`;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ix = Math.floor(item.x / cell);
    const iy = Math.floor(item.y / cell);
    let blocked = false;
    for (let dx = -1; dx <= 1 && !blocked; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(bucketKey(ix + dx, iy + dy));
        if (!bucket) continue;
        for (let j = 0; j < bucket.length; j++) {
          const o = bucket[j];
          const adx = Math.abs(item.x - o.x);
          const ady = Math.abs(item.y - o.y);
          if (adx < radius && ady < radius) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }
    }
    if (blocked) continue;
    kept.push(item.p);
    const k = bucketKey(ix, iy);
    let bucket = grid.get(k);
    if (!bucket) {
      bucket = [];
      grid.set(k, bucket);
    }
    bucket.push(item);
  }
  return kept;
}
