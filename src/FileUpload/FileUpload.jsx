import React, { useState, useEffect, useCallback, useRef } from "react";
import "./FileUpload.css";
import {
  supportsOmeTiffHandlePersistence,
  saveOmeTiffFileHandle,
  clearOmeTiffFileHandle,
} from "../utils/omeTiffLocalPersistence";

const CHANNEL_OVERLAY_MIN_MS = 2000;
const CHANNEL_POLL_MS = 400;
const CHANNEL_POLL_MAX_MS = 120000;

export default function FileUpload({
  onRefresh = async () => {},
  refreshUploadStatus = async () => {},
  omeTiffFile = null,
  setOmeTiffFile = () => {},
  onClearLocalOmeTiff,
  omeTiffRestoreNeedsClick = false,
  onRestoreOmeTiffFromDisk = async () => {},
  renderClusterFilter = null,
}) {
  const [status, setStatus] = useState({
    zarr: false,
    csv: false,
    raw: false,
    raw_annotation_columns: { celltype: false, neigh_names: false },
    feat: false,
    channels: false,
    zooming: false,
    ome_tiff: false,
    generating: false,
  });
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState({
    zarr: false,
    csv: false,
    raw: false,
    feat: false,
    channels: false,
    zooming: false,
  });
  const [open, setOpen] = useState(false);
  /** Full-screen overlay for channel list pipeline (upload → generate → refresh). */
  const [channelOverlayVisible, setChannelOverlayVisible] = useState(false);
  const [channelOverlayMessage, setChannelOverlayMessage] = useState(
    "Generating channel_info.json…"
  );
  const channelPipelineRunningRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/upload/status?ts=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      setStatus({
        zarr: Boolean(data?.zarr),
        csv: Boolean(data?.csv),
        raw: Boolean(data?.raw),
        raw_annotation_columns: data?.raw_annotation_columns || {
          celltype: false,
          neigh_names: false,
        },
        feat: Boolean(data?.feat),
        channels: Boolean(data?.channels),
        zooming: Boolean(data?.zooming),
        ome_tiff: Boolean(data?.ome_tiff),
        generating: Boolean(data?.generating),
      });
      return data;
    } catch (err) {
      console.error("status fetch failed", err);
      return null;
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const channelInfoSignature = useCallback(async () => {
    try {
      const res = await fetch(`/public/channel_info.json?ts=${Date.now()}`, {
        method: "HEAD",
        cache: "no-store",
      });
      if (!(res.ok || res.status === 304)) return null;
      const lm = res.headers?.get?.("last-modified") || "";
      const len = res.headers?.get?.("content-length") || "";
      return `${lm}|${len}`;
    } catch {
      return null;
    }
  }, []);

  const waitForChannelPipeline = useCallback(
    async (priorSignature) => {
      const deadline = Date.now() + CHANNEL_POLL_MAX_MS;
      while (Date.now() < deadline) {
        const statusData = await fetchStatus();
        const sig = await channelInfoSignature();
        const infoChanged = sig != null && sig !== priorSignature;
        const generating = Boolean(statusData?.generating);
        if (infoChanged && !generating) return true;
        await new Promise((r) => setTimeout(r, CHANNEL_POLL_MS));
      }
      const sig = await channelInfoSignature();
      return sig != null && sig !== priorSignature;
    },
    [fetchStatus, channelInfoSignature]
  );

  const runChannelPipeline = useCallback(
    async (file) => {
      if (channelPipelineRunningRef.current) return;
      channelPipelineRunningRef.current = true;
      const startedAt = Date.now();
      const priorSignature = await channelInfoSignature();
      setChannelOverlayVisible(true);
      setChannelOverlayMessage("Uploading channel list…");
      setProcessing((prev) => ({ ...prev, channels: true }));
      setBusy(true);

      try {
        const formData = new FormData();
        formData.append("file", file);
        const response = await fetch("/upload/channels", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          throw new Error(`upload failed: ${response.statusText}`);
        }

        setChannelOverlayMessage("Generating channel_info.json…");
        await waitForChannelPipeline(priorSignature);

        const elapsed = Date.now() - startedAt;
        const remain = Math.max(0, CHANNEL_OVERLAY_MIN_MS - elapsed);
        if (remain > 0) {
          await new Promise((r) => setTimeout(r, remain));
        }

        setChannelOverlayMessage("Loading channels…");
        await fetchStatus();
        await onRefresh({ blockingAtlasPrefetch: true });
        await fetchStatus();
      } catch (err) {
        console.error("channel pipeline error", err);
      } finally {
        channelPipelineRunningRef.current = false;
        setChannelOverlayVisible(false);
        setProcessing((prev) => ({ ...prev, channels: false }));
        setBusy(false);
      }
    },
    [channelInfoSignature, fetchStatus, waitForChannelPipeline, onRefresh]
  );

  useEffect(() => {
    const onDocClick = (e) => {
      if (!open) return;
      if (e.target.closest(".upload-menu") || e.target.closest(".upload-main-btn")) return;
      setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  const handleFileUpload = async (fileType, file) => {
    if (!file) return;
    if (fileType === "channels") {
      await runChannelPipeline(file);
      return;
    }

    setBusy(true);
    setProcessing((prev) => ({ ...prev, [fileType]: true }));
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`/upload/${fileType}`, {
        method: "POST",
        body: formData,
      });
      if (response.ok) {
        if (fileType === "csv") {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        await fetchStatus();
        await onRefresh();
      } else {
        console.error(`${fileType} file upload failed:`, response.statusText);
      }
    } catch (error) {
      console.error(`${fileType} file upload error:`, error);
    } finally {
      setBusy(false);
      setProcessing((prev) => ({ ...prev, [fileType]: false }));
    }
  };

  const handleFileSelect = (fileType) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept =
      fileType === "zarr"
        ? ".zarr,.zip,.zarr.zip"
        : fileType === "feat"
          ? ".npy"
          : ".csv";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) handleFileUpload(fileType, file);
    };
    input.click();
  };

  const handleOmeTiffLocalPick = async () => {
    if (supportsOmeTiffHandlePersistence()) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [
            {
              description: "OME-TIFF",
              accept: {
                "image/tiff": [".tif", ".tiff", ".ome.tif", ".ome.tiff"],
              },
            },
          ],
          multiple: false,
        });
        await saveOmeTiffFileHandle(handle);
        const file = await handle.getFile();
        setOmeTiffFile(file);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
        console.warn("OME-TIFF: File System Access picker failed, using file input", e);
      }
    }
    try {
      await clearOmeTiffFileHandle();
    } catch {
      /* ignore */
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".tif,.tiff,.ome.tif,.ome.tiff";
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (file) setOmeTiffFile(file);
    };
    input.click();
  };

  const handleClearLocalOmeTiff = () => {
    if (typeof onClearLocalOmeTiff === "function") {
      onClearLocalOmeTiff();
    } else {
      setOmeTiffFile(null);
    }
  };

  const omeTiffBound = Boolean(omeTiffFile) || omeTiffRestoreNeedsClick;

  const handleClear = async (fileType) => {
    setBusy(true);
    if (fileType !== "channels") {
      setProcessing((prev) => ({ ...prev, [fileType]: true }));
    }
    try {
      const response = await fetch(`/upload/${fileType}`, { method: "DELETE" });
      if (response.ok) {
        await fetchStatus();
        await onRefresh();
      } else {
        console.error(`${fileType} file clear failed:`, response.statusText);
      }
    } catch (error) {
      console.error(`${fileType} file clear error:`, error);
    } finally {
      setBusy(false);
      if (fileType !== "channels") {
        setProcessing((prev) => ({ ...prev, [fileType]: false }));
      }
    }
  };

  const showOverlay =
    channelOverlayVisible ||
    busy ||
    processing.csv ||
    processing.zarr ||
    processing.raw ||
    processing.feat ||
    processing.channels ||
    processing.zooming ||
    status.generating;

  return (
    <>
      {showOverlay && (
        <div className="fullscreen-processing-overlay">
          <div className="processing-content">
            <div className="processing-spinner"></div>
            {channelOverlayVisible && (
              <div className="processing-text">{channelOverlayMessage}</div>
            )}
            {!channelOverlayVisible && busy && !processing.csv && !processing.zarr && !processing.raw && !processing.feat && !processing.zooming && !processing.channels && (
              <div className="processing-text">Processing…</div>
            )}
            {processing.csv && <div className="processing-text">uploading Raw Data…</div>}
            {processing.zarr && <div className="processing-text">uploading Image Data…</div>}
            {processing.raw && <div className="processing-text">uploading Meta Data…</div>}
            {processing.feat && <div className="processing-text">uploading Features…</div>}
            {processing.zooming && <div className="processing-text">uploading Zooming Data…</div>}
            {!channelOverlayVisible && status.generating && (
              <div className="processing-text">Generating channel_info.json…</div>
            )}
          </div>
        </div>
      )}
      <div className="file-upload-section">
        <div className="upload-toolbar-row">
        <div className="upload-single">
          <button
            type="button"
            className="upload-main-btn"
            onClick={() => setOpen((v) => !v)}
            disabled={busy || channelOverlayVisible}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            {processing.csv ||
            processing.zarr ||
            processing.raw ||
            processing.feat ||
            processing.channels ||
            processing.zooming ||
            channelOverlayVisible
              ? "Uploading…"
              : "Upload"}
          </button>
          {open && (
            <div className="upload-menu" role="menu">
              <div className="upload-menu-item" role="menuitem">
                <button
                  className="upload-menu-action"
                  onClick={() => {
                    setOpen(false);
                    handleOmeTiffLocalPick();
                  }}
                  disabled={busy || omeTiffBound || channelOverlayVisible}
                >
                  OME-TIFF
                </button>
                <button
                  className={`upload-menu-clear${omeTiffBound ? " has-file" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    handleClearLocalOmeTiff();
                  }}
                  disabled={busy || !omeTiffBound || channelOverlayVisible}
                  title="Clear Local OME-TIFF"
                  aria-label="Clear Local OME-TIFF"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button
                  className="upload-menu-action"
                  onClick={() => {
                    setOpen(false);
                    handleFileSelect("zarr");
                  }}
                  disabled={busy || status.zarr || channelOverlayVisible}
                >
                  Zarr Image (zip)
                </button>
                <button
                  className={`upload-menu-clear${status.zarr ? " has-file" : ""}`}
                  onClick={() => handleClear("zarr")}
                  disabled={busy || channelOverlayVisible}
                  title="Clear Zarr"
                  aria-label="Clear Zarr"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button
                  className="upload-menu-action"
                  onClick={() => {
                    setOpen(false);
                    handleFileSelect("csv");
                  }}
                  disabled={busy || status.csv || channelOverlayVisible}
                >
                  Raw Data (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.csv ? " has-file" : ""}`}
                  onClick={() => handleClear("csv")}
                  disabled={busy || channelOverlayVisible}
                  title="Clear CSV"
                  aria-label="Clear CSV"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button
                  className="upload-menu-action"
                  onClick={() => {
                    setOpen(false);
                    handleFileSelect("zooming");
                  }}
                  disabled={busy || status.zooming || channelOverlayVisible}
                >
                  Zooming Cluster (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.zooming ? " has-file" : ""}`}
                  onClick={() => handleClear("zooming")}
                  disabled={busy || channelOverlayVisible}
                  title="Clear Zooming Data"
                  aria-label="Clear Zooming Data"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button
                  className="upload-menu-action"
                  onClick={() => {
                    setOpen(false);
                    handleFileSelect("channels");
                  }}
                  disabled={busy || status.channels || channelOverlayVisible}
                >
                  Channel List (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.channels ? " has-file" : ""}`}
                  onClick={() => handleClear("channels")}
                  disabled={busy || channelOverlayVisible}
                  title="Clear Channels"
                  aria-label="Clear Channels"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button
                  className="upload-menu-action"
                  onClick={() => {
                    setOpen(false);
                    handleFileSelect("feat");
                  }}
                  disabled={busy || status.feat || channelOverlayVisible}
                >
                  Features (npy)
                </button>
                <button
                  className={`upload-menu-clear${status.feat ? " has-file" : ""}`}
                  onClick={() => handleClear("feat")}
                  disabled={busy || channelOverlayVisible}
                  title="Clear Features"
                  aria-label="Clear Features"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button
                  className="upload-menu-action"
                  onClick={() => {
                    setOpen(false);
                    handleFileSelect("raw");
                  }}
                  disabled={busy || status.raw || channelOverlayVisible}
                >
                  Meta Data (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.raw ? " has-file" : ""}`}
                  onClick={() => handleClear("raw")}
                  disabled={busy || channelOverlayVisible}
                  title="Clear Raw"
                  aria-label="Clear Raw"
                />
              </div>
            </div>
          )}
        </div>
        {typeof renderClusterFilter === "function" ? renderClusterFilter() : null}
        </div>
        {omeTiffRestoreNeedsClick && !omeTiffFile && (
          <div className="ome-tiff-restore-hint" role="status">
            <span className="ome-tiff-restore-text">
              OME-TIFF path saved. After reload, grant access again to read.
            </span>
            <button
              type="button"
              className="ome-tiff-restore-btn"
              disabled={busy || channelOverlayVisible}
              onClick={() => onRestoreOmeTiffFromDisk()}
            >
              Restore file
            </button>
          </div>
        )}
      </div>
    </>
  );
}
