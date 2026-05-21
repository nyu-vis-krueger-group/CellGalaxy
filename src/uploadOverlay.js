/**
 * Imperative full-screen upload overlay (immune to React HMR / remount).
 * Also polls /upload/status while server .generating exists.
 */

import "./FileUpload/FileUpload.css";

const POLL_MS = 500;

let manualVisible = false;
let manualMessage = "Processing…";
let serverGenerating = false;
let overlayEl = null;
let pollTimer = null;

function ensureOverlayElement() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "fullscreen-processing-overlay";
  overlayEl.setAttribute("role", "alert");
  overlayEl.setAttribute("aria-busy", "true");
  const inner = document.createElement("div");
  inner.className = "processing-content";
  const spinner = document.createElement("div");
  spinner.className = "processing-spinner";
  const text = document.createElement("div");
  text.className = "processing-text";
  inner.appendChild(spinner);
  inner.appendChild(text);
  overlayEl.appendChild(inner);
  return overlayEl;
}

function currentMessage() {
  if (serverGenerating) {
    return "Generating coords & channel_info… (please wait)";
  }
  return manualMessage || "Processing…";
}

function paintOverlay() {
  const show = manualVisible || serverGenerating;
  const el = ensureOverlayElement();
  el.querySelector(".processing-text").textContent = currentMessage();
  if (show) {
    if (!el.isConnected) document.body.appendChild(el);
  } else if (el.isConnected) {
    el.remove();
  }
}

async function pollServerGenerating() {
  try {
    const res = await fetch(`/upload/status?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const next = Boolean(data?.generating);
    if (next !== serverGenerating) {
      serverGenerating = next;
      paintOverlay();
    } else if (serverGenerating) {
      paintOverlay();
    }
  } catch {
    /* ignore */
  }
}

function startPolling() {
  if (pollTimer != null) return;
  pollServerGenerating();
  pollTimer = window.setInterval(pollServerGenerating, POLL_MS);
}

export function getUploadOverlayState() {
  return {
    visible: manualVisible || serverGenerating,
    message: currentMessage(),
  };
}

export function setUploadOverlay(visible, message = "Processing…") {
  manualVisible = Boolean(visible);
  manualMessage = message || "Processing…";
  paintOverlay();
}

/** @deprecated React hook path; use setUploadOverlay */
export function subscribeUploadOverlay(listener) {
  listener(getUploadOverlayState());
  return () => {};
}

if (typeof window !== "undefined") {
  startPolling();
}
