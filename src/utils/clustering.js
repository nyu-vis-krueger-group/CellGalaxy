import { CLUSTERING_COLORS } from "../constants/clustering";
import { computeConvexHull2D } from "./utils";

export function clusterColor(label) {
  const palette = CLUSTERING_COLORS;
  const n = palette.length;
  if (!Number.isFinite(label) || n === 0) return [255, 255, 255];
  const idx = ((label % n) + n) % n;
  const c = palette[idx] || palette[0];
  return [c[0], c[1], c[2]];
}

export function buildOutlineData2D(points, labelKey = "label") {
  if (!Array.isArray(points) || points.length < 3) return [];
  const groups = new Map();
  for (const p of points) {
    const val = p?.[labelKey];
    const k = Number.isFinite(val) ? val : (p?.label ?? 0);
    const arr = groups.get(k) || [];
    arr.push(p);
    groups.set(k, arr);
  }
  const out = [];
  for (const [label, arr] of groups.entries()) {
    if (arr.length < 3) continue;
    const hull = computeConvexHull2D(arr);
    if (!hull || hull.length < 3) continue;
    const rgb = clusterColor(label);
    let sumX = 0;
    let sumY = 0;
    for (const p of arr) {
      sumX += p.x ?? 0;
      sumY += p.y ?? 0;
    }
    const n = arr.length || 1;
    const centroid = [sumX / n, sumY / n, 0];
    // Close hull path
    const closedPath = hull
      .map(([x, y]) => [x, y, 0])
      .concat([[hull[0][0], hull[0][1], 0]]);

    out.push({
      path: closedPath,
      color: [rgb[0], rgb[1], rgb[2], 255],
      label,
      centroid,
    });
  }
  return out;
}

export function projectOutlines3D(viewport, points, filteredIds, labelKey = "label") {
  if (!viewport || !Array.isArray(points) || points.length < 3) return [];
  const byLabel = new Map();
  const activeFilter = filteredIds && filteredIds.size > 0;
  for (const p of points) {
    if (activeFilter && !filteredIds.has(p.id)) continue;
    const val = p?.[labelKey];
    const label = Number.isFinite(val) ? val : (p?.label ?? 0);

    const [sx, sy] = viewport.project([p.x, p.y, p.z ?? 0]);
    const entry = byLabel.get(label) || {
      screen: [],
      sumX: 0,
      sumY: 0,
      sumZ: 0,
      count: 0,
    };
    entry.screen.push({ x: sx, y: sy });
    entry.sumX += p.x ?? 0;
    entry.sumY += p.y ?? 0;
    entry.sumZ += p.z ?? 0;
    entry.count += 1;
    byLabel.set(label, entry);
  }
  const paths = [];
  for (const [label, entry] of byLabel.entries()) {
    const arr = entry.screen;
    if (!arr || arr.length < 3) continue;
    const hull = computeConvexHull2D(arr);
    if (!hull || hull.length < 3) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of hull) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const bbox = {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    };

    const denom = entry.count > 0 ? entry.count : 1;
    const centroidWorld = [
      entry.sumX / denom,
      entry.sumY / denom,
      entry.sumZ / denom,
    ];
    const projectedCentroid = viewport.project(centroidWorld);
    const pixelOffset = [
      bbox.cx - (projectedCentroid?.[0] ?? bbox.cx),
      bbox.cy - (projectedCentroid?.[1] ?? bbox.cy),
    ];

    const rgb = clusterColor(label);
    const d = hull.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ") + " Z";
    paths.push({
      d,
      poly: hull.map(([x, y]) => [x, y]),
      color: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`,
      rgb,
      label,
      bbox,
      centroidWorld,
      projectedCentroid: [projectedCentroid?.[0] ?? 0, projectedCentroid?.[1] ?? 0],
      pixelOffset,
    });
  }
  return paths;
}
