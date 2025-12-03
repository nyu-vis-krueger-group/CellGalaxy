import React from "react";
import { VIEW_SINGLE, VIEW_DUAL } from "../constants/view";
import "./ViewModeSelector.css";

export default function ViewModeSelector({ viewMode, setViewMode, useUMAP, setUseUMAP }) {
  const isDual = viewMode === VIEW_DUAL;
  return (
    <div className="viewmode-section">
      <div className="viewmode-title">Viewer</div>
      <div className="viewmode-options">
        {/* Row 1: Single vs Side by side */}
        <div className="vm-row radios">
          <label className="render-option">
            <input
              type="radio"
              name="viewerMode"
              value={VIEW_SINGLE}
              checked={viewMode === VIEW_SINGLE}
              onChange={() => setViewMode(VIEW_SINGLE)}
            />
            <span className="radio-custom"></span>
            Single
          </label>
          <label className="render-option">
            <input
              type="radio"
              name="viewerMode"
              value={VIEW_DUAL}
              checked={viewMode === VIEW_DUAL}
              onChange={() => setViewMode(VIEW_DUAL)}
            />
            <span className="radio-custom"></span>
            Side by side
          </label>
        </div>

        {/* Row 2: Raw vs Umap (disabled in dual mode) */}
        <div className={`vm-row radios ${isDual ? "disabled" : ""}`}>
          <label className="render-option">
            <input
              type="radio"
              name="projMode"
              value="raw"
              checked={!useUMAP}
              disabled={isDual}
              onChange={() => setUseUMAP(false)}
            />
            <span className="radio-custom"></span>
            Raw
          </label>
          <label className="render-option">
            <input
              type="radio"
              name="projMode"
              value="umap"
              checked={!!useUMAP}
              disabled={isDual}
              onChange={() => setUseUMAP(true)}
            />
            <span className="radio-custom"></span>
            Umap
          </label>
        </div>
      </div>
    </div>
  );
}


