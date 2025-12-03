import React from "react";
import "./ClusterAnnotationOverlay.css";

export default function ClusterAnnotationOverlay({
  annotations,
  viewStateZoom,
  altPressed,
  clusterColor,
  hoveredAnnotationLabel,
  setHoveredAnnotationLabel,
  descriptionRefs,
}) {
  if (
    !annotations ||
    annotations.length === 0
  ) {
    return null;
  }

  const z = typeof viewStateZoom === "number" ? viewStateZoom : 8;
  const baseSize = 14;
  const scale = 1 + (z - 8) * 0.1;
  const size = Math.max(10, Math.min(32, baseSize * scale));

  return annotations.map((ann) => {
    const { label, title, description, x, y } = ann;
    if (!title) return null;
    const rgb = clusterColor(label);

    return (
      <div
        key={`cluster-annotation-title-${label}`}
        className="cluster-annotation-title"
        style={{
          left: x,
          top: y,
          pointerEvents: altPressed ? "auto" : "none",
          zIndex: hoveredAnnotationLabel === label ? 100 : 10,
        }}
        onMouseEnter={(e) => {
          // Only show description when Option (Alt) is pressed
          if (altPressed || e.altKey) {
            setHoveredAnnotationLabel(label);
          }
        }}
        onMouseLeave={() =>
          setHoveredAnnotationLabel((cur) => (cur === label ? null : cur))
        }
        onWheel={(e) => {
          const el = descriptionRefs.current[label];
          if (el) {
            el.scrollTop += e.deltaY;
            e.preventDefault();
          }
        }}
      >
        <div
          className="cluster-annotation-title-text"
          style={{
            backgroundColor: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.67)`,
            fontSize: `${size}px`,
          }}
        >
          {title}
        </div>
        {hoveredAnnotationLabel === label && description && altPressed && (
          <div
            className="deck-tooltip cluster-annotation-description"
            ref={(el) => {
              if (el) {
                descriptionRefs.current[label] = el;
              } else {
                delete descriptionRefs.current[label];
              }
            }}
          >
            {description}
          </div>
        )}
      </div>
    );
  });
}


