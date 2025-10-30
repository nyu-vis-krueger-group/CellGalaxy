import React, { useState, useEffect, useCallback } from "react";
import "./FileUpload.css";

export default function FileUpload({ onRefresh = async () => {} }) {
  const [status, setStatus] = useState({ zarr: false, csv: false, raw: false });
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState({ zarr: false, csv: false, raw: false });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/upload/status?ts=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) {
        setStatus({ zarr: false, csv: false });
        return;
      }
      const data = await res.json();
      setStatus({
        zarr: Boolean(data?.zarr),
        csv: Boolean(data?.csv),
        raw: Boolean(data?.raw),
      });
    } catch (err) {
      console.error("status fetch failed", err);
      setStatus({ zarr: false, csv: false, raw: false });
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleFileUpload = async (fileType, file) => {
    if (!file) return;
    setBusy(true);
    setProcessing(prev => ({ ...prev, [fileType]: true }));
    
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
        if (fileType === 'csv') {
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
    input.accept = (fileType === 'csv' || fileType === 'raw') ? '.csv' : '.zarr,.zip,.zarr.zip';
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
    }
  };

  return (
    <>
      {(processing.csv || processing.zarr || processing.raw) && (
        <div className="fullscreen-processing-overlay">
          <div className="processing-content">
            <div className="processing-spinner"></div>
            {processing.csv && <div className="processing-text">uploading CSV...</div>}
            {processing.zarr && <div className="processing-text">uploading Zarr...</div>}
            {processing.raw && <div className="processing-text">uploading Raw...</div>}
          </div>
        </div>
      )}
      <div className="file-upload-section">
        <div className="upload-buttons">
        <div className="upload-row">
          <button
            type="button"
            className="upload-btn upload-zarr"
            onClick={() => handleFileSelect('zarr')}
            disabled={busy || status.zarr}
          >
            {processing.zarr ? 'Processing...' : 'Upload Zarr'}
          </button>
          <button
            type="button"
            className={`clear-upload-btn${status.zarr ? ' has-file' : ''}`}
            onClick={() => handleClear('zarr')}
            disabled={busy}
            title="Clear uploaded Zarr"
            aria-label="Clear uploaded Zarr"
          />
        </div>
        <div className="upload-row">
          <button
            type="button"
            className="upload-btn upload-csv"
            onClick={() => handleFileSelect('csv')}
            disabled={busy || status.csv}
          >
            {processing.csv ? 'Computing...' : 'Upload CSV'}
          </button>
          <button
            type="button"
            className={`clear-upload-btn${status.csv ? ' has-file' : ''}`}
            onClick={() => handleClear('csv')}
            disabled={busy}
            title="Clear uploaded CSV"
            aria-label="Clear uploaded CSV"
          />
        </div>
        <div className="upload-row">
          <button
            type="button"
            className="upload-btn upload-csv"
            onClick={() => handleFileSelect('raw')}
            disabled={busy || status.raw}
          >
            {processing.raw ? 'Processing...' : 'Upload Raw'}
          </button>
          <button
            type="button"
            className={`clear-upload-btn${status.raw ? ' has-file' : ''}`}
            onClick={() => handleClear('raw')}
            disabled={busy}
            title="Clear uploaded Raw"
            aria-label="Clear uploaded Raw"
          />
        </div>
      </div>
    </div>
    </>
  );
}
