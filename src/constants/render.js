export const RENDER_SPRITES = "sprites";
export const RENDER_POINTS = "points";

/** Cell focus (__focusCell*, click-zoom): deck zoom. OME spatial = pixel coords; UMAP / sprite spatial = normalized [-1,1]. */
/** Fallback when tilePx unknown (≈16px tile → ~140 CSS px). */
export const CELL_FOCUS_ZOOM_SPATIAL_OME = 3.13;
/** @deprecated Use CELL_FOCUS_ZOOM_SPATIAL_OME */
export const CELL_FOCUS_ZOOM_SPATIAL = CELL_FOCUS_ZOOM_SPATIAL_OME;
export const CELL_FOCUS_ZOOM_UMAP = 14;

/** Target on-screen cell size (CSS px) after focus — keeps small/large tiles readable. */
export const CELL_FOCUS_TARGET_SCREEN_PX = 140;

/** Deck zoom when focusing a cell (cross-view eye icon, click-zoom). */
export function cellFocusZoomForView({
  isUMAPView = false,
  rawUsesOmeTiff = false,
  tilePx = 16,
  /** Zarr sprite spatial: marker px at markerBaseZoom (effectiveImageSize). */
  markerSizeAtBase = null,
  markerBaseZoom = 8,
} = {}) {
  if (isUMAPView) return CELL_FOCUS_ZOOM_UMAP;

  if (rawUsesOmeTiff) {
    // OME: screen ≈ tilePx * 2^zoom (world pixels → screen).
    const t = Number(tilePx) > 0 ? Number(tilePx) : 16;
    const z = Math.log2(CELL_FOCUS_TARGET_SCREEN_PX / t);
    return Math.max(0.25, Math.min(10, Number.isFinite(z) ? z : CELL_FOCUS_ZOOM_SPATIAL_OME));
  }

  // Zarr sprite spatial: screen ≈ markerSizeAtBase * 2^(zoom - baseZoom).
  const base = Number.isFinite(markerBaseZoom) ? markerBaseZoom : 8;
  const m = Number(markerSizeAtBase);
  if (Number.isFinite(m) && m > 0) {
    const z = base + Math.log2(CELL_FOCUS_TARGET_SCREEN_PX / m);
    if (Number.isFinite(z)) return Math.max(base, Math.min(base + 12, z));
  }
  return CELL_FOCUS_ZOOM_UMAP;
}

/** Spatial scroll zoom (softer than ~0.8 default) */
export const SPATIAL_SCROLL_ZOOM_SPEED = 0.5;
/** UMAP scroll zoom (stronger than ~0.01 default) */
export const UMAP_SCROLL_ZOOM_SPEED = 0.038;

/** Subtract from log2(zoom) on first OME fit to slightly shrink default view */
export const OME_AUTO_FIT_ZOOM_SUB = 0.28;

/** OME spatial marker/box: fixed like UMAP at this slider value (same clamp as umapMatched); ignores Size Control */
export const OME_SPATIAL_IMAGE_SIZE_FIXED = 0.3;
