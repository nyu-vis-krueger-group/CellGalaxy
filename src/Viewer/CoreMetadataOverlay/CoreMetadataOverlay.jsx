import React from "react";
import "./CoreMetadataOverlay.css";

export default function CoreMetadataOverlay({ items = [] }) {
  if (!items.length) return null;

  return (
    <div className="core-metadata-overlay" aria-hidden="true">
      {items.map((item) => (
        <div
          key={`core-meta-${item.id}`}
          className="core-metadata-label"
          style={{ left: item.x, top: item.y }}
        >
          {item.lines.map((line, idx) => (
            <div key={`${item.id}-${idx}`} className="core-metadata-line">
              {line}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
