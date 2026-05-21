/**
 * Overlay visibility is driven only by UploadOverlay.jsx polling upload/status.generating.
 * These exports are kept so old imports do not break; they no longer show/hide UI.
 */

export function setUploadOverlay() {
  /* no-op */
}

export function getUploadOverlayState() {
  return { visible: false, message: "" };
}

export function subscribeUploadOverlay(listener) {
  listener(getUploadOverlayState());
  return () => {};
}
