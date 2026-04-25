import React, { useState, useEffect, useCallback, useRef } from "react";
import "./FileUpload.css";
import {
  supportsOmeTiffHandlePersistence,
  saveOmeTiffFileHandle,
  clearOmeTiffFileHandle,
} from "../utils/omeTiffLocalPersistence";

export default function FileUpload({
  onRefresh = async () => {},
  refreshUploadStatus = async () => {},
  /** Local OME-TIFF (browser File) — no upload API */
  omeTiffFile = null,
  setOmeTiffFile = () => {},
  /** Clear local OME-TIFF and remove persisted FileSystemFileHandle from IndexedDB */
  onClearLocalOmeTiff,
  omeTiffRestoreNeedsClick = false,
  onRestoreOmeTiffFromDisk = async () => {},
}) {
  const CHANNEL_OVERLAY_LOCK_KEY = "cg_channel_overlay_lock";
  const [status, setStatus] = useState({ zarr: false, csv: false, raw: false, raw_annotation_columns: { celltype: false, neigh_names: false }, feat: false, channels: false, zooming: false, ome_tiff: false, generating: false });
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState({ zarr: false, csv: false, raw: false, feat: false, channels: false, zooming: false });
  const [open, setOpen] = useState(false);
  const [waitingForJson, setWaitingForJson] = useState(false);
  const [jsonReady, setJsonReady] = useState({ coords: false, channelInfo: false });
  const [channelPipelineActive, setChannelPipelineActive] = useState(false);
  const [channelOverlayLocked, setChannelOverlayLocked] = useState(false);
  const [channelGeneratingSeen, setChannelGeneratingSeen] = useState(false);
  const [generatingMarkerPresent, setGeneratingMarkerPresent] = useState(false);
  const channelPipelineRef = useRef(false);
  const channelUploadStartMsRef = useRef(0);
  const channelFinishStableCountRef = useRef(0);

  const persistChannelOverlayLock = useCallback((locked) => {
    try {
      if (locked) {
        window.sessionStorage.setItem(CHANNEL_OVERLAY_LOCK_KEY, "1");
      } else {
        window.sessionStorage.removeItem(CHANNEL_OVERLAY_LOCK_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/upload/status?ts=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) {
        return null;
      }
      const data = await res.json();
      setStatus({
        zarr: Boolean(data?.zarr),
        csv: Boolean(data?.csv),
        raw: Boolean(data?.raw),
        raw_annotation_columns: data?.raw_annotation_columns || { celltype: false, neigh_names: false },
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

  useEffect(() => {
    try {
      const locked = window.sessionStorage.getItem(CHANNEL_OVERLAY_LOCK_KEY) === "1";
      if (locked) {
        setChannelOverlayLocked(true);
        setWaitingForJson(true);
        setChannelPipelineActive(true);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  // Poll while generating / channel pipeline
  const pollRef = useRef(null);
  useEffect(() => {
    const shouldPoll = processing.channels || status.generating || generatingMarkerPresent || waitingForJson || channelPipelineActive;
    if (shouldPoll && !pollRef.current) {
      pollRef.current = setInterval(() => {
        fetchStatus();
      }, 1000);
    } else if (!shouldPoll && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [processing.channels, status.generating, generatingMarkerPresent, waitingForJson, channelPipelineActive, fetchStatus]);

  useEffect(() => {
    if (channelPipelineActive && status.generating) {
      setChannelGeneratingSeen(true);
    }
  }, [channelPipelineActive, status.generating]);

  // HEAD coords/channel_info while waitingForJson
  useEffect(() => {
    if (!waitingForJson) return;
    let aborted = false;
    const headInfo = async (path) => {
      try {
        const res = await fetch(`${path}?ts=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
        if (!(res.ok || res.status === 304)) return { ok: false, fresh: false };
        const lmRaw = res.headers?.get?.("last-modified");
        const lm = lmRaw ? Date.parse(lmRaw) : NaN;
        const start = channelUploadStartMsRef.current || 0;
        const fresh = start <= 0 || !Number.isFinite(lm) || lm >= (start - 1000);
        return { ok: true, fresh };
      } catch {
        return { ok: false, fresh: false };
      }
    };
    const headExists = async (path) => {
      try {
        const res = await fetch(`${path}?ts=${Date.now()}`, { method: "HEAD", cache: "no-store" });
        return Boolean(res.ok || res.status === 304);
      } catch {
        return false;
      }
    };
    const tick = async () => {
      if (channelPipelineRef.current) return;
      const statusData = await fetchStatus();
      const statusFetched = Boolean(statusData);
      const generatingNow = Boolean(statusData?.generating);
      const needCoords = status.csv;
      const [chInfo, coInfo] = await Promise.all([
        headInfo('/public/channel_info.json'),
        needCoords ? headInfo('/public/coords.json') : Promise.resolve({ ok: true, fresh: true }),
      ]);
      const markerNow = await headExists('/public/.generating');
      if (aborted) return;
      setGeneratingMarkerPresent(markerNow);
      const chOk = Boolean(chInfo.ok && chInfo.fresh);
      const coOk = Boolean(coInfo.ok && coInfo.fresh);
      setJsonReady({ coords: coOk, channelInfo: chOk });
      const elapsed = Date.now() - (channelUploadStartMsRef.current || 0);
      const stableEnough = channelGeneratingSeen || elapsed > 1500;
      const completeNow = chOk && coOk && stableEnough && statusFetched && !generatingNow && !markerNow && !processing.channels;
      if (completeNow) {
        channelFinishStableCountRef.current += 1;
      } else {
        channelFinishStableCountRef.current = 0;
      }
      if (channelFinishStableCountRef.current >= 3) {
        setWaitingForJson(false);
        setChannelPipelineActive(false);
        setChannelOverlayLocked(false);
        persistChannelOverlayLock(false);
        channelFinishStableCountRef.current = 0;
        await fetchStatus();
        await onRefresh();
      }
    };
    const id = setInterval(tick, 800);
    tick();
    return () => { aborted = true; clearInterval(id); };
  }, [waitingForJson, status.csv, status.generating, channelGeneratingSeen, processing.channels, fetchStatus, onRefresh, persistChannelOverlayLock]);

  // generating true→false: refresh
  const prevGeneratingRef = useRef(false);
  useEffect(() => {
    const prev = prevGeneratingRef.current;
    if (prev && !status.generating) {
      (async () => {
        await fetchStatus();
        await onRefresh();
      })();
    }
    prevGeneratingRef.current = status.generating;
  }, [status.generating, fetchStatus, onRefresh]);

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
    setBusy(true);
    setProcessing(prev => ({ ...prev, [fileType]: true }));
    if (fileType === 'channels') {
      channelPipelineRef.current = true;
      setChannelPipelineActive(true);
      setChannelOverlayLocked(true);
      persistChannelOverlayLock(true);
      channelFinishStableCountRef.current = 0;
      setChannelGeneratingSeen(false);
      setGeneratingMarkerPresent(true);
      channelUploadStartMsRef.current = Date.now();
      setWaitingForJson(true);
      setJsonReady({ coords: false, channelInfo: false });
    }
    
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`/upload/${fileType}`, {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        console.log(`${fileType} file uploaded successfully`);

        if (fileType === 'csv' || fileType === 'channels') {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await fetchStatus();
        await onRefresh(fileType === 'channels' ? { blockingAtlasPrefetch: true } : undefined);
        // For channels, keep waitingForJson true until HEAD polling confirms new files are ready.
        if (fileType === 'channels') await fetchStatus();
      } else {
        console.error(`${fileType} file upload failed:`, response.statusText);
        if (fileType === 'channels') {
          setChannelPipelineActive(false);
          setChannelOverlayLocked(false);
          persistChannelOverlayLock(false);
          setWaitingForJson(false);
        }
      }
    } catch (error) {
      console.error(`${fileType} file upload error:`, error);
      if (fileType === 'channels') {
        setChannelPipelineActive(false);
        setChannelOverlayLocked(false);
        persistChannelOverlayLock(false);
        setWaitingForJson(false);
      }
    } finally {
      if (fileType === 'channels') channelPipelineRef.current = false;
      setBusy(false);
      setProcessing(prev => ({ ...prev, [fileType]: false }));
    }
  };

  const handleFileSelect = (fileType) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = fileType === 'zarr'
      ? '.zarr,.zip,.zarr.zip'
      : (fileType === 'feat' ? '.npy' : '.csv');
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        handleFileUpload(fileType, file);
      }
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
    if (fileType !== 'channels') {
      setProcessing(prev => ({ ...prev, [fileType]: true }));
    }
    try {
      const response = await fetch(`/upload/${fileType}`, { method: 'DELETE' });
      if (response.ok) {
        console.log(`${fileType} file cleared`);
        await fetchStatus();
        await onRefresh();
        if (fileType === 'channels') {
          setWaitingForJson(false);
          setChannelPipelineActive(false);
          setChannelOverlayLocked(false);
          persistChannelOverlayLock(false);
          setGeneratingMarkerPresent(false);
          await fetchStatus();
        }
      } else {
        console.error(`${fileType} file clear failed:`, response.statusText);
      }
    } catch (error) {
      console.error(`${fileType} file clear error:`, error);
    } finally {
      setBusy(false);
      if (fileType !== 'channels') {
        setProcessing(prev => ({ ...prev, [fileType]: false }));
      }
    }
  };

  return (
    <>
      {(busy || processing.csv || processing.zarr || processing.raw || processing.feat || processing.channels || processing.zooming || status.generating || generatingMarkerPresent || channelPipelineActive || channelOverlayLocked || (waitingForJson && !(jsonReady.channelInfo && (status.csv ? jsonReady.coords : true)))) && (
        <div className="fullscreen-processing-overlay">
          <div className="processing-content">
            <div className="processing-spinner"></div>
            {busy && !processing.csv && !processing.zarr && !processing.raw && !processing.feat && !processing.zooming && !processing.channels && <div className="processing-text">Processing...</div>}
            {processing.csv && <div className="processing-text">uploading Raw Data...</div>}
            {processing.zarr && <div className="processing-text">uploading Image Data...</div>}
            {processing.raw && <div className="processing-text">uploading Meta Data...</div>}
            {processing.feat && <div className="processing-text">uploading Features...</div>}
            {processing.zooming && <div className="processing-text">uploading Zooming Data...</div>}
            {(processing.channels || status.generating || generatingMarkerPresent || channelPipelineActive || channelOverlayLocked || (waitingForJson && !(jsonReady.channelInfo && (status.csv ? jsonReady.coords : true)))) && <div className="processing-text">Generating channel_info.json and coords.json...</div>}
          </div>
        </div>
      )}
      <div className="file-upload-section">
        <div className="upload-single">
          <button
            type="button"
            className="upload-main-btn"
            onClick={() => setOpen((v) => !v)}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            {processing.csv || processing.zarr || processing.raw || processing.feat || processing.channels || processing.zooming || channelPipelineActive ? 'Uploading...' : 'Upload'}
          </button>
          {open && (
            <div className="upload-menu" role="menu">
              <div className="upload-menu-item" role="menuitem">
                <button
                  className="upload-menu-action"
                  onClick={() => { setOpen(false); handleOmeTiffLocalPick(); }}
                  disabled={busy || omeTiffBound}
                >
                  OME-TIFF
                </button>
                <button
                  className={`upload-menu-clear${omeTiffBound ? " has-file" : ""}`}
                  onClick={() => { setOpen(false); handleClearLocalOmeTiff(); }}
                  disabled={busy || !omeTiffBound}
                  title="Clear Local OME-TIFF"
                  aria-label="Clear Local OME-TIFF"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button className="upload-menu-action" onClick={() => { setOpen(false); handleFileSelect('zarr'); }} disabled={busy || status.zarr}>
                  Zarr Image (zip)
                </button>
                <button
                  className={`upload-menu-clear${status.zarr ? ' has-file' : ''}`}
                  onClick={() => handleClear('zarr')}
                  disabled={busy}
                  title="Clear Zarr"
                  aria-label="Clear Zarr"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button className="upload-menu-action" onClick={() => { setOpen(false); handleFileSelect('csv'); }} disabled={busy || status.csv}>
                  Raw Data (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.csv ? ' has-file' : ''}`}
                  onClick={() => handleClear('csv')}
                  disabled={busy}
                  title="Clear CSV"
                  aria-label="Clear CSV"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button className="upload-menu-action" onClick={() => { setOpen(false); handleFileSelect('zooming'); }} disabled={busy || status.zooming}>
                  Zooming Cluster (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.zooming ? ' has-file' : ''}`}
                  onClick={() => handleClear('zooming')}
                  disabled={busy}
                  title="Clear Zooming Data"
                  aria-label="Clear Zooming Data"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button className="upload-menu-action" onClick={() => { setOpen(false); handleFileSelect('channels'); }} disabled={busy || status.channels}>
                  Channel List (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.channels ? ' has-file' : ''}`}
                  onClick={() => handleClear('channels')}
                  disabled={busy}
                  title="Clear Channels"
                  aria-label="Clear Channels"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button className="upload-menu-action" onClick={() => { setOpen(false); handleFileSelect('feat'); }} disabled={busy || status.feat}>
                  Features (npy)
                </button>
                <button
                  className={`upload-menu-clear${status.feat ? ' has-file' : ''}`}
                  onClick={() => handleClear('feat')}
                  disabled={busy}
                  title="Clear Features"
                  aria-label="Clear Features"
                />
              </div>
              <div className="upload-menu-item" role="menuitem">
                <button className="upload-menu-action" onClick={() => { setOpen(false); handleFileSelect('raw'); }} disabled={busy || status.raw}>
                  Meta Data (csv)
                </button>
                <button
                  className={`upload-menu-clear${status.raw ? ' has-file' : ''}`}
                  onClick={() => handleClear('raw')}
                  disabled={busy}
                  title="Clear Raw"
                  aria-label="Clear Raw"
                />
              </div>
            </div>
          )}
        </div>
        {omeTiffRestoreNeedsClick && !omeTiffFile && (
          <div className="ome-tiff-restore-hint" role="status">
            <span className="ome-tiff-restore-text">
              OME-TIFF path saved. After reload, grant access again to read.
            </span>
            <button
              type="button"
              className="ome-tiff-restore-btn"
              disabled={busy}
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
