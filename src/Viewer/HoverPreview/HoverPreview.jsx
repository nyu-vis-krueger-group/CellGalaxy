import React, { useEffect, useRef, useState } from "react";
import "./HoverPreview.css";
import { projectItemsToScreen } from "../../utils/utils";

// Hover tile: windowing like WindowedIconLayer; cached atlas images.
const _previewImageCache = new Map();

function loadImageCached(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const cached = _previewImageCache.get(src);
    if (cached) {
      if (cached.complete && cached.naturalWidth > 0) {
        resolve(cached);
      } else {
        cached.addEventListener(
          "load",
          () => resolve(cached),
          { once: true }
        );
        cached.addEventListener(
          "error",
          () => resolve(null),
          { once: true }
        );
      }
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
    _previewImageCache.set(src, img);
  });
}

export async function drawCellPreviewToCanvas({
  canvas,
  object,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  channels,
  colors,
  alphas,
  windows,
  previewSize = 128,
}) {
  if (!canvas || !object) return;
  const chunkId = object.chunk_id;
  const localIndex = object.local_index;
  const mapping = iconMappingsByChunk?.[chunkId]?.[`t_${localIndex}`];
  const uvMeta = chunkUV?.[chunkId];
  if (!mapping || !uvMeta) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }

  const tile = uvMeta.tile || mapping.width || 16;
  const bgX = mapping.x || 0;
  const bgY = mapping.y || 0;

  // Read gray tile offscreen
  const off = document.createElement("canvas");
  off.width = tile;
  off.height = tile;
  const octx = off.getContext("2d");
  if (!octx) return;

  const outW = tile;
  const outH = tile;
  const out = new Float32Array(outW * outH * 4);

  const chList =
    Array.isArray(channels) && channels.length > 0
      ? channels
      : Object.keys(atlasByChannel?.[chunkId] || {}).map((v) => Number(v));

  const byCh = atlasByChannel?.[chunkId] || {};

  // Per ch: gray → window → tint × α, additive
  for (const ch of chList) {
    const src = byCh?.[ch];
    if (!src) continue;
    const img = await loadImageCached(src);
    if (!img) continue;

    const col = colors?.[ch] || [255, 255, 255];
    const alpha01 = Math.min(1, Math.max(0, alphas?.[ch] ?? 1));

    const w = windows?.[ch] || {};
    const rawMin = Number.isFinite(w.min) ? w.min : 0;
    const rawMax = Number.isFinite(w.max) ? w.max : 65535;
    const winMin01 = Math.max(0, Math.min(1, rawMin / 65535));
    const winMax01 = Math.max(0, Math.min(1, rawMax / 65535));
    const span = Math.max(1e-6, winMax01 - winMin01);

    octx.clearRect(0, 0, outW, outH);
    octx.drawImage(img, bgX, bgY, tile, tile, 0, 0, outW, outH);
    const imageData = octx.getImageData(0, 0, outW, outH);
    const data = imageData.data;

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const idx = (y * outW + x) * 4;
        const gray01 = data[idx] / 255;
        let t;
        if (gray01 <= winMin01) t = 0;
        else if (gray01 >= winMax01) t = 1;
        else t = (gray01 - winMin01) / span;

        const v = t * alpha01;
        if (v <= 0) continue;
        out[idx] += (col[0] ?? 255) * v;
        out[idx + 1] += (col[1] ?? 255) * v;
        out[idx + 2] += (col[2] ?? 255) * v;
        out[idx + 3] = Math.min(255, out[idx + 3] + v * 255);
      }
    }
  }

  const finalCtx = canvas.getContext("2d");
  if (!finalCtx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = previewSize * dpr;
  canvas.height = previewSize * dpr;
  finalCtx.setTransform(1, 0, 0, 1, 0, 0);
  finalCtx.scale(dpr, dpr);
  // imageSmoothing for scaled preview
  finalCtx.imageSmoothingEnabled = true;

  const outImg = octx.createImageData(outW, outH);
  const dst = outImg.data;
  // Tone boost + clamp
  const toneGain = 1.35;
  for (let i = 0; i < outW * outH; i++) {
    const base = i * 4;
    let r = out[base];
    let g = out[base + 1];
    let b = out[base + 2];
    let a = out[base + 3];
    if (a < 5) {
      r = g = b = a = 0;
    } else {
      r = Math.min(255, r * toneGain);
      g = Math.min(255, g * toneGain);
      b = Math.min(255, b * toneGain);
    }
    dst[base] = r;
    dst[base + 1] = g;
    dst[base + 2] = b;
    dst[base + 3] = Math.max(0, Math.min(255, a));
  }
  octx.putImageData(outImg, 0, 0);

  finalCtx.clearRect(0, 0, previewSize, previewSize);
  finalCtx.fillStyle = "black";
  finalCtx.fillRect(0, 0, previewSize, previewSize);
  finalCtx.drawImage(off, 0, 0, previewSize, previewSize);
}

function HoverCellTooltip({
  info,
  containerRef,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  channels,
  colors,
  alphas,
  windows,
  cellTypeAnnotationOn = false,
  neighNamesAnnotationOn = false,
  rawAnnotationById = new Map(),
  filteredIds = null,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !info || !info.object) return;
    let cancelled = false;
    (async () => {
      await drawCellPreviewToCanvas({
        canvas,
        object: info.object,
        iconMappingsByChunk,
        chunkUV,
        atlasByChannel,
        channels,
        colors,
        alphas,
        windows,
        previewSize: 128,
      });
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [
    info,
    iconMappingsByChunk,
    chunkUV,
    atlasByChannel,
    channels,
    colors,
    alphas,
    windows,
  ]);

  if (!info || !info.object) return null;

  const { object } = info;
  const ann = rawAnnotationById.get(object.id);
  const passesFilter = !filteredIds || filteredIds.size === 0 || filteredIds.has(object.id);

  let left = info.x;
  let top = info.y;
  const containerEl = containerRef.current;
  if (containerEl && typeof info.x === "number" && typeof info.y === "number") {
    const rect = containerEl.getBoundingClientRect();
    left = info.x - rect.left + 16;
    top = info.y - rect.top + 16;
  }

  const showCellType = passesFilter && cellTypeAnnotationOn && ann && (ann.celltype != null && ann.celltype !== "");
  const showNeighNames = passesFilter && neighNamesAnnotationOn && ann && (ann.neigh_names != null && ann.neigh_names !== "");

  return (
    <div
      className="deck-tooltip hover-preview-tooltip"
      style={{
        position: "absolute",
        left,
        top,
        transform: "translate(0, 0)",
        pointerEvents: "none",
        zIndex: 20,
      }}
    >
      <div className="hover-preview-canvas-wrapper">
        <canvas
          ref={canvasRef}
          className="hover-preview-canvas"
        />
      </div>
      {(showCellType || showNeighNames) && (
        <div className="hover-preview-annotation">
          {showCellType && <div className="hover-preview-annotation-row"><span className="hover-preview-annotation-label">Cell type:</span> {ann.celltype}</div>}
          {showNeighNames && <div className="hover-preview-annotation-row"><span className="hover-preview-annotation-label">Neigh names:</span> {ann.neigh_names}</div>}
        </div>
      )}
    </div>
  );
}

// Wrapper: hover state from deckRef + containerRef
export default function HoverPreview({
  deckRef,
  containerRef,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  channels,
  colors,
  alphas,
  windows,
  computedImageSize = 16,
  hoverEnabled = true,
  selectedIds = new Set(),
  cellTypeAnnotationOn = false,
  neighNamesAnnotationOn = false,
  rawAnnotationById = new Map(),
  filteredIds = null,
}) {
  const [hoverInfo, setHoverInfo] = useState(null);
  const [outlineRect, setOutlineRect] = useState(null);

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;

    const handleMove = (e) => {
      if (!hoverEnabled) {
        setHoverInfo(null);
        return;
      }
      if (
        selectedIds &&
        typeof selectedIds.size === "number" &&
        selectedIds.size > 0
      ) {
        setHoverInfo(null);
        return;
      }
      // Over analysis popover → no hover tile
      const target = e.target;
      if (target && typeof target.closest === "function") {
        const inAnalysis = target.closest(".analysis-popover");
        if (inAnalysis) {
          setHoverInfo(null);
          return;
        }
      }

      // Over cluster preview/label → no hover
      const xClient = e.clientX;
      const yClient = e.clientY;
      try {
        const blockers = document.querySelectorAll(".cluster-preview-thumb, .cluster-annotation-title");
        for (const el of blockers) {
          const rect = el.getBoundingClientRect();
          if (
            xClient >= rect.left &&
            xClient <= rect.right &&
            yClient >= rect.top &&
            yClient <= rect.bottom
          ) {
            setHoverInfo(null);
            return;
          }
        }
      } catch {
      }
      const deckInstance = deckRef.current && deckRef.current.deck;
      const canvas = deckInstance && deckInstance.canvas;
      if (!deckInstance || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const picked = deckInstance.pickObject({ x, y, radius: 6 });
      if (picked && picked.object) {
        setHoverInfo({
          ...picked,
          x: e.clientX,
          y: e.clientY,
        });
      } else {
        setHoverInfo(null);
      }
    };

    const handleLeave = () => setHoverInfo(null);

    containerEl.addEventListener("mousemove", handleMove);
    containerEl.addEventListener("mouseleave", handleLeave);
    return () => {
      containerEl.removeEventListener("mousemove", handleMove);
      containerEl.removeEventListener("mouseleave", handleLeave);
    };
  }, [deckRef, containerRef, selectedIds, hoverEnabled]);

  // Hovered tile outline in screen px
  useEffect(() => {
    if (!hoverInfo || !hoverInfo.object) {
      setOutlineRect(null);
      return;
    }
    const projected = projectItemsToScreen({
      deckRef,
      containerRef,
      items: [hoverInfo.object],
      getWorldPosition: (p) => [p.x, p.y, p.z ?? 0],
      mapResult: (p, sx, sy, offsetX, offsetY) => ({
        x: sx + offsetX,
        y: sy + offsetY,
      }),
    });
    if (!projected || projected.length === 0) {
      setOutlineRect(null);
      return;
    }
    const { x, y } = projected[0];
    // Outline ≈ tile size
    const baseSize = computedImageSize;
    const size = Math.max(6, baseSize);
    setOutlineRect({
      left: x - size / 2,
      top: y - size / 2,
      size,
    });
  }, [hoverInfo, deckRef, containerRef, computedImageSize]);

  if (!hoverInfo || !hoverInfo.object) return null;

  return (
    <>
      {outlineRect && (
        <div
          className="hover-tile-outline"
          style={{
            left: outlineRect.left,
            top: outlineRect.top,
            width: outlineRect.size,
            height: outlineRect.size,
          }}
        />
      )}
      <HoverCellTooltip
        info={hoverInfo}
        containerRef={containerRef}
        iconMappingsByChunk={iconMappingsByChunk}
        chunkUV={chunkUV}
        atlasByChannel={atlasByChannel}
        channels={channels}
        colors={colors}
        alphas={alphas}
        windows={windows}
        cellTypeAnnotationOn={cellTypeAnnotationOn}
        neighNamesAnnotationOn={neighNamesAnnotationOn}
        rawAnnotationById={rawAnnotationById}
        filteredIds={filteredIds}
      />
    </>
  );
}


