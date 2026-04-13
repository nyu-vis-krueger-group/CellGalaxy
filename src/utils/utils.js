// Shared helpers for viewer / selection / projection.

/** Ray-cast: point [px,py] inside polygon [[x,y],...]. */
export function pointInPolygon([px, py], polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      const intersect =
        (yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
/** AABB center of points with x,y,z. */
export function computeCenter(points) {
  if (!points?.length) return [0, 0, 0];

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const x = p.x;
    const y = p.y;
    const z = p.z ?? 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  return [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
}



/** Smoothstep on t in [0,1]. */
export function ease(t) {
  return t * t * (3 - 2 * t);
}

/** Per-chunk IconLayer mappings from meta + chunkUV. */
export function buildIconMappingsByChunk(meta, chunkUV) {
  if (!meta || !chunkUV) return {};
  
  const map = {};
  for (const [chunkIdStr, uvObj] of Object.entries(chunkUV)) {
    const chunkId = Number(chunkIdStr);
    const { tile, width, height, uv } = uvObj;
    const imap = {};
    
    for (const u of uv) {
      const x = Math.round(u.u0 * width);
      const y = Math.round(u.v0 * height);
      imap[`t_${u.local_index}`] = {
        x,
        y,
        width: tile,
        height: tile,
        // Atlas RGB as mask (not alpha-only).
        mask:true,
        anchorY: tile / 2,
        anchorX: tile / 2,
      };
    }
    map[chunkId] = imap;
  }
  
  return map;
}

/** Canvas DPR from deck ref or window. */
export function getCanvasDPR(deckRef) {
  const deck = deckRef?.current?.deck;
  const canvas = deck?.canvas || deck?.getCanvas?.();
  if (!canvas) return window.devicePixelRatio || 1;
  
  const cssW = canvas.clientWidth || canvas.width;
  const dpr = cssW ? canvas.width / cssW : window.devicePixelRatio || 1;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/** Pointer position in canvas space from deck info + container. */
export function getEventCoordinates(info, containerRef) {
  if (info?.offsetCenter && Number.isFinite(info.offsetCenter.x)) {
    return { x: info.offsetCenter.x, y: info.offsetCenter.y };
  }
  
  if (Number.isFinite(info?.x) && Number.isFinite(info?.y)) {
    return { x: info.x, y: info.y };
  }
  
  const evt = info?.srcEvent;
  if (evt && typeof evt.clientX === "number") {
    const rect = containerRef?.current?.getBoundingClientRect();
    return {
      x: evt.clientX - (rect?.left ?? 0),
      y: evt.clientY - (rect?.top ?? 0),
    };
  }
  
  return { x: 0, y: 0 };
}

/** Clamp (x,y) inside node's offsetParent with margin. */
export function clampPositionToParent(node, x, y, margin = 8) {
  if (!node) return { x, y };
  const parent = node.offsetParent || document.body;
  const prect = parent.getBoundingClientRect();
  const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: node.offsetWidth || 0, height: node.offsetHeight || 0 };
  const w = rect.width || node.offsetWidth || 0;
  const h = rect.height || node.offsetHeight || 0;
  let nx = Math.round(x);
  let ny = Math.round(y);
  const maxX = Math.max(margin, prect.width - w - margin);
  const maxY = Math.max(margin, prect.height - h - margin);
  if (nx > maxX) nx = maxX;
  if (ny > maxY) ny = maxY;
  if (nx < margin) nx = margin;
  if (ny < margin) ny = margin;
  return { x: nx, y: ny };
}

/** Clamp floating panel to viewport (e.g. analysis popover). */
export function clampPositionToViewport(node, x, y, margin = 8) {
  const rect = node?.getBoundingClientRect
    ? node.getBoundingClientRect()
    : { width: node?.offsetWidth || 0, height: node?.offsetHeight || 0 };
  const w = rect.width || node?.offsetWidth || 0;
  const h = rect.height || node?.offsetHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  let nx = Math.round(x);
  let ny = Math.round(y);
  const maxX = Math.max(margin, vw - w - margin);
  const maxY = Math.max(margin, vh - h - margin);
  if (nx > maxX) nx = maxX;
  if (ny > maxY) ny = maxY;
  if (nx < margin) nx = margin;
  if (ny < margin) ny = margin;
  return { x: nx, y: ny };
}

/** Box from drag corners. */
export function computeSelectionBounds(dragStart, dragEnd) {
  const x0 = Math.min(dragStart.x, dragEnd.x);
  const y0 = Math.min(dragStart.y, dragEnd.y);
  const width = Math.max(1, Math.abs(dragStart.x - dragEnd.x));
  const height = Math.max(1, Math.abs(dragStart.y - dragEnd.y));
  
  return { x0, y0, width, height };
}

/** deck.pickObjects in rect. */
export function performBoxSelection(deck, bounds) {
  const { x0, y0, width, height } = bounds;
  
  const picked = deck?.pickObjects({
    x: x0,
    y: y0,
    width,
    height,
  }) || [];
  
  return picked;
}

/** Lasso path in screen space → selected ids. */
export function performLassoSelection(points, viewport, lassoPoints) {
  if (lassoPoints.length < 3) return new Set();
  
  const ids = new Set();
  for (const p of points) {
    const [sx, sy] = viewport.project([p.x, p.y, p.z ?? 0]);
    if (pointInPolygon([sx, sy], lassoPoints)) {
      ids.add(p.id);
    }
  }
  
  return ids;
}

/** 1D KDE on [0,1]; ys normalized to max 1. */
export function kde1d(values01, bandwidth = 0.08, samples = 192) {
  const vals = Array.isArray(values01) ? values01 : [];
  if (vals.length === 0) return { xs: [], ys: [] };
  const xs = new Array(samples);
  const ys = new Array(samples).fill(0);
  const twoSigma2 = 2 * bandwidth * bandwidth;
  const norm = 1 / (Math.sqrt(Math.PI * twoSigma2) * vals.length);
  for (let i = 0; i < samples; i++) {
    const x = i / (samples - 1);
    xs[i] = x;
    let acc = 0;
    for (let j = 0; j < vals.length; j++) {
      const d = x - vals[j];
      acc += Math.exp(-(d * d) / twoSigma2);
    }
    ys[i] = acc * norm;
  }
  const maxY = Math.max(1e-6, ...ys);
  for (let i = 0; i < samples; i++) ys[i] /= maxY;
  return { xs, ys };
}


/** 2D convex hull (Andrew monotone chain), CCW, no duplicate closing point. */
export function computeConvexHull2D(pts) {
  const n = Array.isArray(pts) ? pts.length : 0;
  if (n < 3) return pts.map(p => [p.x, p.y]);
  const p = pts.map((v, i) => ({ x: +v.x, y: +v.y })).filter(v => Number.isFinite(v.x) && Number.isFinite(v.y));
  p.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (let i = 0; i < p.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
    lower.push(p[i]);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper).map(v => [v.x, v.y]);
  return hull;
}


/**
 * Project world positions to DOM coords over the canvas (previews, labels, ranking).
 * deckRef / containerRef / items / getWorldPosition / mapResult as documented at call sites.
 */
export function projectItemsToScreen({
  deckRef,
  containerRef,
  items,
  getWorldPosition,
  mapResult,
}) {
  const deckInstance = deckRef?.current?.deck;
  const containerEl = containerRef?.current;
  if (!deckInstance || !containerEl || !Array.isArray(items) || items.length === 0) {
    return [];
  }

  // getViewports can throw during mount/resize; swallow and return [].
  let viewports;
  try {
    viewports = deckInstance.getViewports?.();
  } catch {
    return [];
  }
  if (!viewports || viewports.length === 0) return [];
  const viewport = viewports[0];
  const canvas = deckInstance.canvas;
  if (!canvas) return [];

  const containerRect = containerEl.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const offsetX = canvasRect.left - containerRect.left;
  const offsetY = canvasRect.top - containerRect.top;

  return items.map((item) => {
    const world = getWorldPosition(item);
    const projected = viewport.project(world);
    const sx = projected?.[0] ?? 0;
    const sy = projected?.[1] ?? 0;
    return mapResult(item, sx, sy, offsetX, offsetY);
  });
}


