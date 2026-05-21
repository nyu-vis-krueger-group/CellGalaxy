import React, { useState, useEffect, useCallback } from "react";
import "./FileUpload.css";
import { setUploadOverlay } from "../uploadOverlay";
import {
  supportsOmeTiffHandlePersistence,
  saveOmeTiffFileHandle,
  clearOmeTiffFileHandle,
} from "../utils/omeTiffLocalPersistence";

const POLL_MS = 500;
const POLL_MAX_MS = 60 * 60 * 1000;

async function waitUntilServerNotGenerating() {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`/upload/status?ts=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (!data?.generating) return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

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

  const runChannelPipeline = useCallback(
    async (file) => {
      setBusy(true);
      setProcessing((prev) => ({ ...prev, channels: true }));
      setUploadOverlay(true, "Uploading channel list…");

      try {
        const formData = new FormData();
        formData.append("file", file);
        setUploadOverlay(true, "Generating coords & channel_info… (may take several minutes)");
        const response = await fetch("/upload/channels", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`upload failed: ${response.status} ${text}`);
        }

        setUploadOverlay(true, "Loading channels & atlases…");
        await fetchStatus();
        await onRefresh({ blockingAtlasPrefetch: true });
        await fetchStatus();
      } catch (err) {
        console.error("channel pipeline error", err);
        setUploadOverlay(true, "Waiting for server to finish generating…");
      } finally {
        setBusy(false);
        setProcessing((prev) => ({ ...prev, channels: false }));
        await fetchStatus();
        if (!(await waitUntilServerNotGenerating())) {
          console.warn("Timed out waiting for server .generating to clear");
        }
        setUploadOverlay(false);
      }
    },
    [fetchStatus, onRefresh]
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

  const refreshAfterLightUpload = useCallback(async () => {
    await fetchStatus();
    await onRefresh({ uploadOnly: true, skipLoading: true });
  }, [fetchStatus, onRefresh]);

  const handleFileUpload = async (fileType, file) => {
    if (!file) return;
    if (fileType === "channels") {
      await runChannelPipeline(file);
      return;
    }

    setBusy(true);
    setProcessing((prev) => ({ ...prev, [fileType]: true }));
    const labels = {
      zarr: "Uploading Zarr…",
      csv: "Uploading Raw Data…",
      raw: "Uploading Meta Data…",
      feat: "Uploading Features…",
      zooming: "Uploading Zooming Data…",
    };
    setUploadOverlay(true, labels[fileType] || "Uploading…");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`/upload/${fileType}`, {
        method: "POST",
        body: formData,
      });
      if (response.ok) {
        await refreshAfterLightUpload();
      } else {
        console.error(`${fileType} file upload failed:`, response.statusText);
      }
    } catch (error) {
      console.error(`${fileType} file upload error:`, error);
    } finally {
      setUploadOverlay(false);
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
  const uploadBusy =
    busy ||
    processing.csv ||
    processing.zarr ||
    processing.raw ||
    processing.feat ||
    processing.channels ||
    processing.zooming;

  const handleClear = async (fileType) => {
    setBusy(true);
    if (fileType !== "channels") {
      setProcessing((prev) => ({ ...prev, [fileType]: true }));
    }
    setUploadOverlay(true, "Clearing…");
    try {
      const response = await fetch(`/upload/${fileType}`, { method: "DELETE" });
      if (response.ok) {
        if (fileType === "channels") {
          setUploadOverlay(true, "Refreshing…");
          await fetchStatus();
          await onRefresh({ blockingAtlasPrefetch: true });
        } else {
          await refreshAfterLightUpload();
        }
      } else {
        console.error(`${fileType} file clear failed:`, response.statusText);
      }
    } catch (error) {
      console.error(`${fileType} file clear error:`, error);
    } finally {
      setUploadOverlay(false);
      setBusy(false);
      if (fileType !== "channels") {
        setProcessing((prev) => ({ ...prev, [fileType]: false }));
      }
    }
  };

  return (
    <div className="file-upload-section">
      <div className="upload-toolbar-row">
        <div className="upload-single">
          <button
            type="button"
            className="upload-main-btn"
            onClick={() => setOpen((v) => !v)}
            disabled={uploadBusy}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            {uploadBusy ? "Uploading…" : "Upload"}
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
                  disabled={uploadBusy || omeTiffBound}
                >
                  OME-TIFF
                </button>
                <button
                  className={`upload-menu-clear${omeTiffBound ? " has-file" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    handleClearLocalOmeTiff();
                  }}
                  disabled={uploadBusy || !omeTiffBound}
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
                  disabled={uploadBusy || status.zarr}
                >
                  Zarr Image (zip)
                </button>
                <button
                  className={`upload-menu-clear${status.zarr ? " has-file" : ""}`}
                  onClick={() => handleClear("zarr")}
                  disabled={uploadBusy}
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
                  disabled={uploadBusy || status.csv}
                >
                  Raw Data (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.csv ? " has-file" : ""}`}
                  onClick={() => handleClear("csv")}
                  disabled={uploadBusy}
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
                  disabled={uploadBusy || status.zooming}
                >
                  Zooming Cluster (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.zooming ? " has-file" : ""}`}
                  onClick={() => handleClear("zooming")}
                  disabled={uploadBusy}
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
                  disabled={uploadBusy || status.channels}
                >
                  Channel List (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.channels ? " has-file" : ""}`}
                  onClick={() => handleClear("channels")}
                  disabled={uploadBusy}
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
                  disabled={uploadBusy || status.feat}
                >
                  Features (npy)
                </button>
                <button
                  className={`upload-menu-clear${status.feat ? " has-file" : ""}`}
                  onClick={() => handleClear("feat")}
                  disabled={uploadBusy}
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
                  disabled={uploadBusy || status.raw}
                >
                  Meta Data (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.raw ? " has-file" : ""}`}
                  onClick={() => handleClear("raw")}
                  disabled={uploadBusy}
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
            disabled={uploadBusy}
            onClick={() => onRestoreOmeTiffFromDisk()}
          >
            Restore file
          </button>
        </div>
      )}
    </div>
  );
}
