import React, { useEffect, useRef } from "react";
import "./ClusterPreviewThumb.css";
import { drawCellPreviewToCanvas } from "../HoverPreview/HoverPreview";

// Canvas‑based fixed cluster preview thumbnail, sharing the same
// windowing logic as HoverPreview / main viewer.
export default function ClusterPreviewThumb({
  point,
  x,
  y,
  previewSize,
  borderColor,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  channels,
  colors,
  alphas,
  windows,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !point) return;
    let cancelled = false;
    (async () => {
      await drawCellPreviewToCanvas({
        canvas,
        object: point,
        iconMappingsByChunk,
        chunkUV,
        atlasByChannel,
        channels,
        colors,
        alphas,
        windows,
        previewSize,
      });
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [
    point,
    iconMappingsByChunk,
    chunkUV,
    atlasByChannel,
    channels,
    colors,
    alphas,
    windows,
    previewSize,
  ]);

  if (!point) return null;

  return (
    <div
      className="deck-tooltip cluster-preview-thumb"
      style={{
        left: x,
        top: y,
        borderColor,
      }}
    >
      <canvas
        ref={canvasRef}
        className="cluster-preview-thumb-canvas"
        style={{ width: previewSize, height: previewSize }}
      />
    </div>
  );
}


