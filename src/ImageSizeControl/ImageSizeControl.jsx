import React from "react";
import "./ImageSizeControl.css";

export default function ImageSizeControl({ imageSize, setImageSize }) {
  return (
    <div className="control-section">
      <div className="control-section-title">Size Control</div>
      <div className="control-row">
        <input
          className="control-slider"
          type="range"
          min="0"
          max="20"
          step="0.3"
          value={imageSize}
          onChange={(e) => setImageSize(Number(e.target.value))}
        />
        <span className="control-value">{imageSize.toFixed(2)}</span>
      </div>
    </div>
  );
}
