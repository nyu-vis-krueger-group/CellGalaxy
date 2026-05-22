import React, { useEffect, useMemo, useRef, useState } from "react";
import "./HoverPreview.css";
import { projectItemsToScreen } from "../../utils/utils";
import {
  HOVER_ICON_SUPERSAMPLE,
  TONE_GAIN,
  applyIntensityWindow01,
  clampAccumulatedRgb,
  combinedRawWindow,
  maskModeChannelRgb255,
  rawWindowToNormalized01,
  sampleIconIntensityGrid,
  windowFromChannel,
} from "../../utils/intensityWindow";
import { cellPreviewURL } from "../../api/api";
import HoverDeckPreview from "./HoverDeckPreview";

const PREVIEW_SIZE = 128;

export function resolveDisplayObject(object, displayCoordById) {
  if (!object) return null;
  const disp =
    displayCoordById &&
    typeof displayCoordById.get === "function" &&
    Number.isFinite(object.id)
      ? displayCoordById.get(object.id)
      : null;
  if (disp && disp.chunk_id != null && disp.local_index != null) {
    return { ...object, chunk_id: disp.chunk_id, local_index: disp.local_index };
  }
  return object;
}

function canUseDeckSpritePreview({
  object,
  displayCoordById,
  meta,
  renderMode,
  suppressSpriteAtlases,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL,
  channels,
}) {
  if (suppressSpriteAtlases || renderMode !== "sprites" || !meta || !object) return false;
  const resolved = resolveDisplayObject(object, displayCoordById);
  const chunkId = resolved?.chunk_id;
  const localIndex = resolved?.local_index;
  if (!Number.isFinite(chunkId) || !Number.isFinite(localIndex)) return false;
  if (!chunkUV?.[chunkId] || !iconMappingsByChunk?.[chunkId]?.[`t_${localIndex}`]) {
    return false;
  }
  const chList = Array.isArray(channels) && channels.length > 0 ? channels : [];
  if (chList.length === 0) return false;
  const byCh = atlasByChannel?.[chunkId] || {};
  return chList.some((ch) => byCh?.[ch]) || Boolean(atlasURL?.[chunkId]);
}

const _previewImageCache = new Map();

function loadImageCached(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const cached = _previewImageCache.get(src);
    if (cached) {
      if (cached.complete && cached.naturalWidth > 0) {
        resolve(cached);
      } else {
        cached.addEventListener("load", () => resolve(cached), { once: true });
        cached.addEventListener("error", () => resolve(null), { once: true });
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

async function drawCellPreviewFromUrl(canvas, url, previewSize = 128) {
  if (!canvas || !url) return;
  const img = await loadImageCached(url);
  const finalCtx = canvas.getContext("2d");
  if (!finalCtx || !img) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = previewSize * dpr;
  canvas.height = previewSize * dpr;
  finalCtx.setTransform(1, 0, 0, 1, 0, 0);
  finalCtx.scale(dpr, dpr);
  finalCtx.imageSmoothingEnabled = false;
  finalCtx.clearRect(0, 0, previewSize, previewSize);
  finalCtx.fillStyle = "black";
  finalCtx.fillRect(0, 0, previewSize, previewSize);
  finalCtx.drawImage(img, 0, 0, previewSize, previewSize);
}

function drawMergedAtlasTile(octx, img, mapping, tile, winMin01, winMax01) {
  const bgX = mapping.x || 0;
  const bgY = mapping.y || 0;
  const ss = HOVER_ICON_SUPERSAMPLE;
  const sw = tile * ss;
  const sh = tile * ss;
  const samp = document.createElement("canvas");
  samp.width = sw;
  samp.height = sh;
  const sctx = samp.getContext("2d");
  if (!sctx) return null;
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(img, bgX, bgY, tile, tile, 0, 0, sw, sh);
  const bigData = sctx.getImageData(0, 0, sw, sh);
  const iconGrid = sampleIconIntensityGrid(bigData, tile, tile, ss);
  const outImg = octx.createImageData(tile, tile);
  const dst = outImg.data;
  for (let i = 0; i < tile * tile; i++) {
    const iconA = iconGrid[i];
    const t = applyIntensityWindow01(iconA, winMin01, winMax01);
    const v = Math.min(255, 255 * t * TONE_GAIN);
    const base = i * 4;
    dst[base] = v;
    dst[base + 1] = v;
    dst[base + 2] = v;
    dst[base + 3] = v > 0 ? 255 : 0;
  }
  return outImg;
}

export async function drawCellPreviewToCanvas({
  canvas,
  object,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL = {},
  channels,
  colors,
  alphas,
  windows,
  displayCoordById = null,
  previewSize = 128,
}) {
  if (!canvas || !object) return;
  const resolved = resolveDisplayObject(object, displayCoordById);
  const chunkId = resolved.chunk_id;
  const localIndex = resolved.local_index;
  const mapping = iconMappingsByChunk?.[chunkId]?.[`t_${localIndex}`];
  const uvMeta = chunkUV?.[chunkId];

  const tile = uvMeta?.tile || mapping?.width || 16;
  const bgX = mapping?.x || 0;
  const bgY = mapping?.y || 0;

  const off = document.createElement("canvas");
  off.width = tile;
  off.height = tile;
  const octx = off.getContext("2d");
  if (!octx) return;
  octx.imageSmoothingEnabled = false;

  const outW = tile;
  const outH = tile;
  const out = new Float32Array(outW * outH * 4);

  const chList =
    Array.isArray(channels) && channels.length > 0
      ? channels
      : Object.keys(atlasByChannel?.[chunkId] || {}).map((v) => Number(v));

  const byCh = atlasByChannel?.[chunkId] || {};
  let usedAccum = false;
  const ss = HOVER_ICON_SUPERSAMPLE;

  for (const ch of chList) {
    const src = byCh?.[ch];
    if (!src) continue;
    const img = await loadImageCached(src);
    if (!img) continue;
    usedAccum = true;

    const col = colors?.[ch] || [255, 255, 255];
    const alpha01 = Math.min(1, Math.max(0, alphas?.[ch] ?? 1));
    const { winMin01, winMax01 } = windowFromChannel(ch, windows);

    const sw = outW * ss;
    const sh = outH * ss;
    const samp = document.createElement("canvas");
    samp.width = sw;
    samp.height = sh;
    const sctx = samp.getContext("2d");
    if (!sctx) continue;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(img, bgX, bgY, tile, tile, 0, 0, sw, sh);
    const iconGrid = sampleIconIntensityGrid(sctx.getImageData(0, 0, sw, sh), outW, outH, ss);

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const idx = (y * outW + x) * 4;
        const iconA = iconGrid[y * outW + x];
        const t = applyIntensityWindow01(iconA, winMin01, winMax01);
        const v = t * alpha01;
        if (v <= 0) continue;
        const chRgb = maskModeChannelRgb255(col, v);
        out[idx] += chRgb.r;
        out[idx + 1] += chRgb.g;
        out[idx + 2] += chRgb.b;
        out[idx + 3] = Math.min(255, out[idx + 3] + v * 255);
      }
    }
  }

  let drewPreview = usedAccum;

  if (!usedAccum && mapping && atlasURL?.[chunkId]) {
    const merged = await loadImageCached(atlasURL[chunkId]);
    if (merged) {
      const combo = combinedRawWindow(chList, windows);
      const { winMin01, winMax01 } = rawWindowToNormalized01(combo.min, combo.max);
      const outImg = drawMergedAtlasTile(octx, merged, mapping, tile, winMin01, winMax01);
      if (outImg) {
        octx.putImageData(outImg, 0, 0);
        drewPreview = true;
      }
    }
  }

  if (!drewPreview) {
    if (!mapping || !uvMeta) {
      const previewUrl =
        chList.length > 0 && Number.isFinite(resolved.id)
          ? cellPreviewURL(resolved.id, chList, windows, previewSize)
          : null;
      if (previewUrl) {
        await drawCellPreviewFromUrl(canvas, previewUrl, previewSize);
        return;
      }
    }
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  if (usedAccum) {
    const outImg = octx.createImageData(outW, outH);
    const dst = outImg.data;
    for (let i = 0; i < outW * outH; i++) {
      const base = i * 4;
      const clamped = clampAccumulatedRgb(
        out[base],
        out[base + 1],
        out[base + 2],
        out[base + 3],
      );
      dst[base] = clamped.r;
      dst[base + 1] = clamped.g;
      dst[base + 2] = clamped.b;
      dst[base + 3] = clamped.a;
    }
    octx.putImageData(outImg, 0, 0);
  }

  const finalCtx = canvas.getContext("2d");
  if (!finalCtx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = previewSize * dpr;
  canvas.height = previewSize * dpr;
  finalCtx.setTransform(1, 0, 0, 1, 0, 0);
  finalCtx.scale(dpr, dpr);
  finalCtx.imageSmoothingEnabled = false;
  finalCtx.clearRect(0, 0, previewSize, previewSize);
  finalCtx.fillStyle = "black";
  finalCtx.fillRect(0, 0, previewSize, previewSize);
  finalCtx.drawImage(off, 0, 0, previewSize, previewSize);
}

function HoverCellTooltip({
  info,
  containerRef,
  meta,
  renderMode,
  suppressSpriteAtlases,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL,
  channels,
  colors,
  alphas,
  windows,
  clusterColorOn,
  clusterOpacity,
  clusterLineWidth,
  clusterOutlineOn,
  labelKey,
  isUMAPView,
  computedImageSize,
  cellTypeAnnotationOn = false,
  neighNamesAnnotationOn = false,
  rawAnnotationById = new Map(),
  filteredIds = null,
  displayCoordById = null,
}) {
  const canvasRef = useRef(null);
  const resolved = resolveDisplayObject(info?.object, displayCoordById);

  const useDeckPreview = useMemo(
    () =>
      canUseDeckSpritePreview({
        object: info?.object,
        displayCoordById,
        meta,
        renderMode,
        suppressSpriteAtlases,
        iconMappingsByChunk,
        chunkUV,
        atlasByChannel,
        atlasURL,
        channels,
      }),
    [
      info?.object,
      displayCoordById,
      meta,
      renderMode,
      suppressSpriteAtlases,
      iconMappingsByChunk,
      chunkUV,
      atlasByChannel,
      atlasURL,
      channels,
    ],
  );

  useEffect(() => {
    if (useDeckPreview) return undefined;
    const canvas = canvasRef.current;
    if (!canvas || !info?.object) return undefined;
    let cancelled = false;
    (async () => {
      await drawCellPreviewToCanvas({
        canvas,
        object: info.object,
        iconMappingsByChunk,
        chunkUV,
        atlasByChannel,
        atlasURL,
        channels,
        colors,
        alphas,
        windows,
        displayCoordById,
        previewSize: PREVIEW_SIZE,
      });
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [
    useDeckPreview,
    info,
    iconMappingsByChunk,
    chunkUV,
    atlasByChannel,
    atlasURL,
    channels,
    colors,
    alphas,
    windows,
    displayCoordById,
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
        {useDeckPreview && resolved ? (
          <HoverDeckPreview
            point={resolved}
            previewSize={PREVIEW_SIZE}
            meta={meta}
            atlasURL={atlasURL}
            atlasByChannel={atlasByChannel}
            iconMappingsByChunk={iconMappingsByChunk}
            chunkUV={chunkUV}
            channels={channels}
            colors={colors}
            alphas={alphas}
            windows={windows}
            clusterColorOn={clusterColorOn}
            clusterOpacity={clusterOpacity}
            clusterLineWidth={clusterLineWidth}
            clusterOutlineOn={clusterOutlineOn}
            labelKey={labelKey}
            isUMAPView={isUMAPView}
            computedImageSize={computedImageSize}
          />
        ) : (
          <canvas ref={canvasRef} className="hover-preview-canvas" />
        )}
      </div>
      {(showCellType || showNeighNames) && (
        <div className="hover-preview-annotation">
          {showCellType && (
            <div className="hover-preview-annotation-row">
              <span className="hover-preview-annotation-label">Cell type:</span> {ann.celltype}
            </div>
          )}
          {showNeighNames && (
            <div className="hover-preview-annotation-row">
              <span className="hover-preview-annotation-label">Neigh names:</span> {ann.neigh_names}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function HoverPreview({
  deckRef,
  containerRef,
  meta,
  renderMode = "sprites",
  suppressSpriteAtlases = false,
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL = {},
  channels,
  colors,
  alphas,
  windows,
  clusterColorOn = false,
  clusterOpacity = 0.25,
  clusterLineWidth = 1,
  clusterOutlineOn = false,
  labelKey = "label",
  computedImageSize = 16,
  hoverEnabled = true,
  selectedIds = new Set(),
  cellTypeAnnotationOn = false,
  neighNamesAnnotationOn = false,
  rawAnnotationById = new Map(),
  filteredIds = null,
  displayCoordById = null,
  getWorldPosition = null,
  pickRadius = 6,
  hoverRingScale = 1,
  isUMAPView = false,
}) {
  const toWorld =
    typeof getWorldPosition === "function"
      ? getWorldPosition
      : (p) => [p.x, p.y, p.z ?? 0];

  const effectivePickRadius = isUMAPView
    ? Math.max(pickRadius, Math.ceil(Math.max(8, computedImageSize * 1.8)))
    : pickRadius;

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
      if (selectedIds?.size > 0) {
        setHoverInfo(null);
        return;
      }
      const target = e.target;
      if (target?.closest?.(".analysis-popover")) {
        setHoverInfo(null);
        return;
      }
      const xClient = e.clientX;
      const yClient = e.clientY;
      try {
        const blockers = document.querySelectorAll(
          ".cluster-preview-thumb, .cluster-annotation-title",
        );
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
        /* ignore */
      }
      const deckInstance = deckRef.current?.deck;
      const canvas = deckInstance?.canvas;
      if (!deckInstance || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const picked = deckInstance.pickObject({ x, y, radius: effectivePickRadius });
      if (picked?.object) {
        setHoverInfo({ ...picked, x: e.clientX, y: e.clientY });
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
  }, [deckRef, containerRef, selectedIds, hoverEnabled, effectivePickRadius]);

  useEffect(() => {
    if (!hoverInfo?.object) {
      setOutlineRect(null);
      return;
    }
    const projected = projectItemsToScreen({
      deckRef,
      containerRef,
      items: [hoverInfo.object],
      getWorldPosition: (p) => toWorld(p),
      mapResult: (p, sx, sy, offsetX, offsetY) => ({
        x: sx + offsetX,
        y: sy + offsetY,
      }),
    });
    if (!projected?.length) {
      setOutlineRect(null);
      return;
    }
    const { x, y } = projected[0];
    const baseSize = computedImageSize * hoverRingScale;
    const size = Math.max(6, baseSize);
    setOutlineRect({ left: x - size / 2, top: y - size / 2, size });
  }, [hoverInfo, deckRef, containerRef, computedImageSize, toWorld, hoverRingScale]);

  if (!hoverInfo?.object) return null;

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
        meta={meta}
        renderMode={renderMode}
        suppressSpriteAtlases={suppressSpriteAtlases}
        iconMappingsByChunk={iconMappingsByChunk}
        chunkUV={chunkUV}
        atlasByChannel={atlasByChannel}
        atlasURL={atlasURL}
        channels={channels}
        colors={colors}
        alphas={alphas}
        windows={windows}
        clusterColorOn={clusterColorOn}
        clusterOpacity={clusterOpacity}
        clusterLineWidth={clusterLineWidth}
        clusterOutlineOn={clusterOutlineOn}
        labelKey={labelKey}
        isUMAPView={isUMAPView}
        computedImageSize={computedImageSize}
        cellTypeAnnotationOn={cellTypeAnnotationOn}
        neighNamesAnnotationOn={neighNamesAnnotationOn}
        rawAnnotationById={rawAnnotationById}
        filteredIds={filteredIds}
        displayCoordById={displayCoordById}
      />
    </>
  );
}
