import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api/api";
import "../FileUpload/FileUpload.css";

const MESSAGE = "Generating coords & channel_info… (please wait)";
const POLL_MS = 300;

/** True while server public/.generating marker file exists. */
async function readGeneratingMarker() {
  const ts = Date.now();
  const bases = API_BASE ? [API_BASE, ""] : [""];
  for (const base of bases) {
    const url = `${base}/upload/generating?ts=${ts}`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (typeof data?.generating === "boolean") {
        return data.generating;
      }
    } catch {
      /* try next base */
    }
  }
  return false;
}

/**
 * Fullscreen overlay: visible iff GET /upload/generating → true
 * (backed by public/.generating on disk).
 */
export default function UploadOverlay() {
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const active = await readGeneratingMarker();
      if (!cancelled) setGenerating(Boolean(active));
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!generating) {
    return null;
  }

  return createPortal(
    <div
      className="fullscreen-processing-overlay"
      role="alert"
      aria-busy="true"
      style={{ display: "flex", zIndex: 2147483647 }}
    >
      <div className="processing-content">
        <div className="processing-spinner" aria-hidden="true" />
        <div className="processing-text">{MESSAGE}</div>
      </div>
    </div>,
    document.body
  );
}
