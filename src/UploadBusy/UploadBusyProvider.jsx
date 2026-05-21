import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api/api";
import {
  beginChannelUpload,
  endChannelUpload,
  getChannelUploadDepth,
  subscribeChannelUpload,
} from "../channelUploadLock";
import "../FileUpload/FileUpload.css";

const MESSAGE = "Generating coords & channel_info… (please wait)";
const POLL_MS = 300;

const UploadBusyContext = createContext(null);

async function fetchMarkerActive() {
  const ts = Date.now();
  const urls = [
    `${API_BASE || ""}/upload/generating?ts=${ts}`,
    `/upload/generating?ts=${ts}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (typeof data?.generating === "boolean") {
        return data.generating;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export function UploadBusyProvider({ children }) {
  const [channelDepth, setChannelDepth] = useState(getChannelUploadDepth);
  const [markerActive, setMarkerActive] = useState(false);

  useEffect(() => subscribeChannelUpload(setChannelDepth), []);

  const refreshMarker = useCallback(async () => {
    const active = await fetchMarkerActive();
    if (active === null) return false;
    setMarkerActive(active);
    return active;
  }, []);

  const beginChannelPipeline = useCallback(() => {
    beginChannelUpload();
    setMarkerActive(true);
  }, []);

  const endChannelPipeline = useCallback(() => {
    endChannelUpload();
    void refreshMarker();
  }, [refreshMarker]);

  /** No-op: server holds POST open until .generating is cleared. */
  const waitUntilIdle = useCallback(async () => true, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (getChannelUploadDepth() > 0) return;
      const active = await fetchMarkerActive();
      if (cancelled || active === null) return;
      setMarkerActive(active);
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const showOverlay = channelDepth > 0 || markerActive;

  const value = useMemo(
    () => ({
      isGenerating: showOverlay,
      refreshGenerating: refreshMarker,
      waitUntilIdle,
      beginChannelPipeline,
      endChannelPipeline,
    }),
    [showOverlay, refreshMarker, waitUntilIdle, beginChannelPipeline, endChannelPipeline]
  );

  return (
    <UploadBusyContext.Provider value={value}>
      {showOverlay &&
        typeof document !== "undefined" &&
        createPortal(
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
        )}
      {children}
    </UploadBusyContext.Provider>
  );
}

export function useUploadBusy() {
  const ctx = useContext(UploadBusyContext);
  if (!ctx) {
    throw new Error("useUploadBusy must be used within UploadBusyProvider");
  }
  return ctx;
}
