import React, { useState, useEffect, useCallback, useRef } from "react";
import "./FileUpload.css";

export default function FileUpload({ onRefresh = async () => {} }) {
  const [status, setStatus] = useState({ zarr: false, csv: false, raw: false, feat: false, channels: false, zooming: false, generating: false });
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState({ zarr: false, csv: false, raw: false, feat: false, channels: false, zooming: false });
  const [open, setOpen] = useState(false);
  const [waitingForJson, setWaitingForJson] = useState(false);
  const [jsonReady, setJsonReady] = useState({ coords: false, channelInfo: false });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/upload/status?ts=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) {
        setStatus({ zarr: false, csv: false, raw: false, feat: false });
        return;
      }
      const data = await res.json();
      setStatus({
        zarr: Boolean(data?.zarr),
        csv: Boolean(data?.csv),
        raw: Boolean(data?.raw),
        feat: Boolean(data?.feat),
        channels: Boolean(data?.channels),
        zooming: Boolean(data?.zooming),
        generating: Boolean(data?.generating),
      });
    } catch (err) {
      console.error("status fetch failed", err);
      setStatus({ zarr: false, csv: false, raw: false, feat: false, channels: false, zooming: false, generating: false });
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Polling while generating or processing channels to keep UI in sync until fully done
  const pollRef = useRef(null);
  useEffect(() => {
    const shouldPoll = processing.channels || status.generating || waitingForJson;
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
  }, [processing.channels, status.generating, waitingForJson, fetchStatus]);

  // local polling: only when waiting for JSON, check static files with HEAD
  useEffect(() => {
    if (!waitingForJson) return;
    let aborted = false;
    const headOk = async (path) => {
      try {
        const res = await fetch(`${path}?ts=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
        return res.ok || res.status === 304;
      } catch {
        return false;
      }
    };
    const tick = async () => {
      const needCoords = status.csv;
      const [chOk, coOk] = await Promise.all([
        headOk('/public/channel_info.json'),
        needCoords ? headOk('/public/coords.json') : Promise.resolve(true),
      ]);
      if (aborted) return;
      setJsonReady({ coords: coOk, channelInfo: chOk });
      if (chOk && coOk) {
        setWaitingForJson(false);
        // refresh global status
        await fetchStatus();
        await onRefresh();
      }
    };
    const id = setInterval(tick, 800);
    // check immediately to avoid waiting for the first cycle
    tick();
    return () => { aborted = true; clearInterval(id); };
  }, [waitingForJson, status.csv, fetchStatus, onRefresh]);

  // When generating switches from true -> false, refresh once to pick up new files
  const prevGeneratingRef = useRef(false);
  useEffect(() => {
    const prev = prevGeneratingRef.current;
    if (prev && !status.generating) {
      // generation just finished
      (async () => {
        await fetchStatus();
        await onRefresh();
      })();
    }
    prevGeneratingRef.current = status.generating;
  }, [status.generating, fetchStatus, onRefresh]);

  // close menu on outside click
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
      // start waiting for two JSON files to be ready
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
        
        // If it's a CSV file, show processing status
        if (fileType === 'csv' || fileType === 'channels') {
          // Wait for a while to let user see processing status
          await new Promise(resolve => setTimeout(resolve, 1000));
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

  const handleClear = async (fileType) => {
    setBusy(true);
    // delete channels will trigger rebuild of channel_info.json and coords.json
    if (fileType !== 'channels') {
      setProcessing(prev => ({ ...prev, [fileType]: true }));
    }
    try {
      const response = await fetch(`/upload/${fileType}`, { method: 'DELETE' });
      if (response.ok) {
        console.log(`${fileType} file cleared`);
        await fetchStatus();
        await onRefresh();
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
      {(processing.csv || processing.zarr || processing.raw || processing.feat || processing.channels || processing.zooming || status.generating || (waitingForJson && !(jsonReady.channelInfo && (status.csv ? jsonReady.coords : true)))) && (
        <div className="fullscreen-processing-overlay">
          <div className="processing-content">
            <div className="processing-spinner"></div>
            {processing.csv && <div className="processing-text">uploading Raw Data...</div>}
            {processing.zarr && <div className="processing-text">uploading Image Data...</div>}
            {processing.raw && <div className="processing-text">uploading Meta Data...</div>}
            {processing.feat && <div className="processing-text">uploading Features...</div>}
            {processing.zooming && <div className="processing-text">uploading Zooming Data...</div>}
            {(processing.channels || status.generating || (waitingForJson && !(jsonReady.channelInfo && (status.csv ? jsonReady.coords : true)))) && <div className="processing-text">Generating channel_info.json and coords.json...</div>}
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
            {processing.csv || processing.zarr || processing.raw || processing.feat || processing.channels || processing.zooming ? 'Uploading...' : 'Upload'}
          </button>
          {open && (
            <div className="upload-menu" role="menu">
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
    </div>
    </>
  );
}
