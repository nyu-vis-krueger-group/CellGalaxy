// =============================
// utils.js - utility function collection
// =============================

/**
 * Determine if a screen space point is inside a polygon (ray casting method)
 * @param {Array} point - [px, py] point coordinates to be determined
 * @param {Array} polygon - [[x1,y1], [x2,y2], ...] polygon vertex array
 * @returns {boolean} whether the point is inside the polygon
 */
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
/**
 * Calculate the geometric center of a point set
 * @param {Array} points - point array, each point contains x, y, z properties
 * @returns {Array} [centerX, centerY, centerZ]
 */
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



/**
 * Smooth interpolation function (smoothstep)
 * @param {number} t - interpolation parameter [0, 1]
 * @returns {number} smoothed value
 */
export function ease(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Build icon mapping for each chunk, used by IconLayer
 * @param {Object} meta - metadata
 * @param {Object} chunkUV - UV coordinate information for chunk
 * @returns {Object} icon mapping object
 */
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
        // Use atlas RGB directly (grayscale), not alpha-mask mode
        mask:true,
        anchorY: tile / 2,
        anchorX: tile / 2,
      };
    }
    map[chunkId] = imap;
  }
  
  return map;
}

/**
 * Get canvas device pixel ratio
 * @param {Object} deckRef - deck.gl ref reference
 * @returns {number} device pixel ratio
 */
export function getCanvasDPR(deckRef) {
  const deck = deckRef?.current?.deck;
  const canvas = deck?.canvas || deck?.getCanvas?.();
  if (!canvas) return window.devicePixelRatio || 1;
  
  const cssW = canvas.clientWidth || canvas.width;
  const dpr = cssW ? canvas.width / cssW : window.devicePixelRatio || 1;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * Unified get mouse event screen coordinates (relative to canvas top-left)
 * @param {Object} info - event information object
 * @param {HTMLElement} containerRef - container element ref
 * @returns {Object} {x, y} coordinate object
 */
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

/**
 * Clamp an absolute position into the bounds of a node's offset parent
 * @param {HTMLElement} node - the element to clamp within its offsetParent
 * @param {number} x - desired left (CSS pixels)
 * @param {number} y - desired top (CSS pixels)
 * @param {number} margin - padding margin from edges
 * @returns {{x:number, y:number}} clamped position
 */
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

/**
 * Clamp an absolute position to the browser viewport (window), useful for
 * floating panels that may span multiple viewer containers (e.g. analysis popover).
 */
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

/**
 * Calculate selection box boundaries
 * @param {Object} dragStart - drag start point {x, y}
 * @param {Object} dragEnd - drag end point {x, y}
 * @returns {Object} {x0, y0, width, height} selection box boundaries
 */
export function computeSelectionBounds(dragStart, dragEnd) {
  const x0 = Math.min(dragStart.x, dragEnd.x);
  const y0 = Math.min(dragStart.y, dragEnd.y);
  const width = Math.max(1, Math.abs(dragStart.x - dragEnd.x));
  const height = Math.max(1, Math.abs(dragStart.y - dragEnd.y));
  
  return { x0, y0, width, height };
}

/**
 * Perform box selection operation
 * @param {Object} deck - deck.gl instance
 * @param {Object} bounds - selection box boundaries {x0, y0, width, height}
 * @returns {Array} array of selected objects
 */
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

/**
 * Perform lasso selection operation
 * @param {Array} points - all data points
 * @param {Object} viewport - viewport object
 * @param {Array} lassoPoints - lasso path points [[x,y], ...]
 * @returns {Set} set of selected IDs
 */
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

/**
 * 1D Kernel Density Estimation over values in [0,1]
 * Returns xs in [0,1] and ys normalized to max 1
 */
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


/**
 * Compute 2D convex hull using Andrew's monotone chain.
 * @param {Array<{x:number,y:number}>} pts - points array
 * @returns {Array<[number,number]>} hull path (counter-clockwise), no repeated last point
 */
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
 * Batch-project world coordinates from DeckGL into screen (DOM) coordinates.
 * Suitable for scenarios where DOM elements are overlaid on top of the canvas:
 *  - cluster representative previews
 *  - cluster text annotations
 *  - similarity ranking labels
 *
 * Note: this helper only handles coordinate conversion and offset, and is
 * agnostic to business-specific fields.
 *
 * @param {Object} params
 * @param {React.RefObject} params.deckRef - ref to DeckGL component (.current.deck)
 * @param {React.RefObject} params.containerRef - outer container ref for DOM offset
 * @param {Array} params.items - array of items to project
 * @param {Function} params.getWorldPosition - (item) => [x, y, z] world coordinates
 * @param {Function} params.mapResult - (item, sx, sy, offsetX, offsetY) => any, mapped result
 * @returns {Array} array returned from mapResult
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

  // deck.gl may throw assertion errors during the initial mount / resize switch.
  // Protect against that: if getViewports fails, return an empty result to avoid breaking React effects.
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



