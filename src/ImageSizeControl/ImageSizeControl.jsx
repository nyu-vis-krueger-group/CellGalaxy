import React from "react";
import "./ImageSizeControl.css";

const MIN_SIZE = 0.3;
const MAX_SIZE = 6;

export default function ImageSizeControl({ imageSize, setImageSize }) {
  const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, imageSize));
  return (
    <div className="control-section">
      <div className="control-section-title">Size Control (UMAP)</div>
      <div className="control-row">
        <input
          className="control-slider"
          type="range"
          min={MIN_SIZE}
          max={MAX_SIZE}
          step="0.1"
          value={clamped}
          onChange={(e) => setImageSize(Number(e.target.value))}
        />
        <span className="control-value">{clamped.toFixed(2)}</span>
      </div>
    </div>
  );
}
