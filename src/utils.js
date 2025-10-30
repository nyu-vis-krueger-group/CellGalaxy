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


