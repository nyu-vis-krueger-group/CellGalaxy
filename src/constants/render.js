export const RENDER_SPRITES = "sprites";
export const RENDER_POINTS = "points";

/** Cell focus (__focusCell*, click-zoom): deck zoom. Spatial = world pixels; UMAP = normalized coords. */
export const CELL_FOCUS_ZOOM_SPATIAL = 2.25;
export const CELL_FOCUS_ZOOM_UMAP = 14;

/** Spatial scroll zoom (softer than ~0.8 default) */
export const SPATIAL_SCROLL_ZOOM_SPEED = 0.5;
/** UMAP scroll zoom (stronger than ~0.01 default) */
export const UMAP_SCROLL_ZOOM_SPEED = 0.038;

/** Subtract from log2(zoom) on first OME fit to slightly shrink default view */
export const OME_AUTO_FIT_ZOOM_SUB = 0.28;

/** OME spatial marker/box: fixed like UMAP at this slider value (same clamp as umapMatched); ignores Size Control */
export const OME_SPATIAL_IMAGE_SIZE_FIXED = 0.3;
