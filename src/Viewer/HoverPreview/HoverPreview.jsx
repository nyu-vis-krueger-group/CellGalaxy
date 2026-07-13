import React, { useEffect, useRef, useState } from "react";
import "./HoverPreview.css";
import {
  projectItemsToScreen,
  tileWorldSpanToScreenPx,
  mapLogicalChannelsToZarr,
} from "../../utils/utils";
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
import { loadImageCached } from "../../utils/loadImageCached";

const PREVIEW_SIZE = 128;

/** deck.gl pickObject radius (px from cursor) matching on-screen tile half-extent. */
export function pickRadiusFromTileScreenPx(tileScreenPx) {
  const d = Number(tileScreenPx);
  if (!Number.isFinite(d) || d <= 0) return 4;
  return Math.max(2, Math.ceil(d / 2));
}

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
  channelZarrIndexById = null,
  omePixelRangeByChannelId = {},
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
    const { winMin01, winMax01 } = windowFromChannel(
      ch,
      windows,
      omePixelRangeByChannelId,
    );

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
      const combo = combinedRawWindow(chList, windows, omePixelRangeByChannelId);
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
      const zarrChList = mapLogicalChannelsToZarr(chList, channelZarrIndexById);
      const zarrWindows =
        channelZarrIndexById && Object.keys(channelZarrIndexById).length > 0
          ? Object.fromEntries(
              chList
                .map((logicalId) => {
                  const z = channelZarrIndexById[logicalId];
                  if (z == null || !windows?.[logicalId]) return null;
                  return [z, windows[logicalId]];
                })
                .filter(Boolean),
            )
          : windows;
      const previewUrl =
        zarrChList.length > 0 && Number.isFinite(resolved.id)
          ? cellPreviewURL(resolved.id, zarrChList, zarrWindows, previewSize)
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
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL,
  channels,
  colors,
  alphas,
  windows,
  cellTypeAnnotationOn = false,
  neighNamesAnnotationOn = false,
  rawAnnotationById = new Map(),
  filteredIds = null,
  displayCoordById = null,
  channelZarrIndexById = null,
  omePixelRangeByChannelId = {},
}) {
  // Canvas 2D only — avoid a second DeckGL/WebGL context on hover (context-loss crashes).
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !info?.object) return undefined;
    let cancelled = false;
    (async () => {
      // Draw off-screen first so a cancelled hover never paints a stale cell.
      const tmp = document.createElement("canvas");
      await drawCellPreviewToCanvas({
        canvas: tmp,
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
        channelZarrIndexById,
        omePixelRangeByChannelId,
      });
      if (cancelled) return;
      canvas.width = tmp.width;
      canvas.height = tmp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tmp, 0, 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [
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
    channelZarrIndexById,
    omePixelRangeByChannelId,
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
        <canvas ref={canvasRef} className="hover-preview-canvas" />
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
  iconMappingsByChunk,
  chunkUV,
  atlasByChannel,
  atlasURL = {},
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
  displayCoordById = null,
  channelZarrIndexById = {},
  omePixelRangeByChannelId = {},
  getWorldPosition = null,
  pickRadius = null,
  hoverRingScale = 1,
  outlineSize = null,
  rawUsesOmeTiff = false,
  tilePx = 16,
}) {
  const toWorld =
    typeof getWorldPosition === "function"
      ? getWorldPosition
      : (p) => [p.x, p.y, p.z ?? 0];

  // Same on-screen tile size as the hover ring / zarr sprite (not an inflated UMAP radius).
  const tileScreenPx = outlineSize ?? computedImageSize;
  const effectivePickRadius =
    Number.isFinite(pickRadius) && pickRadius > 0
      ? pickRadius
      : pickRadiusFromTileScreenPx(tileScreenPx);

  const [hoverInfo, setHoverInfo] = useState(null);
  const [outlineRect, setOutlineRect] = useState(null);

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return undefined;

    let raf = 0;
    let pendingEvent = null;
    const blockerCache = { rects: [], at: 0 };
    const BLOCKER_TTL_MS = 250;

    const refreshBlockerRects = () => {
      const now = performance.now();
      if (now - blockerCache.at <= BLOCKER_TTL_MS) return blockerCache.rects;
      try {
        const nodes = document.querySelectorAll(
          ".cluster-preview-thumb, .cluster-annotation-title",
        );
        blockerCache.rects = Array.from(nodes, (el) => el.getBoundingClientRect());
      } catch {
        blockerCache.rects = [];
      }
      blockerCache.at = now;
      return blockerCache.rects;
    };

    const runPick = (e) => {
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
      const blockers = refreshBlockerRects();
      for (let i = 0; i < blockers.length; i++) {
        const rect = blockers[i];
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
      const deckInstance = deckRef.current?.deck;
      const canvas = deckInstance?.canvas;
      if (!deckInstance || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Prefer live viewport span for OME (world tilePx → screen), else sprite pixel size.
      let radius = effectivePickRadius;
      if (rawUsesOmeTiff && Number.isFinite(tilePx) && tilePx > 0) {
        const viewport = deckInstance.getViewports?.()?.[0];
        if (viewport) {
          const center =
            typeof viewport.unproject === "function"
              ? viewport.unproject([x, y])
              : null;
          const span =
            center != null
              ? tileWorldSpanToScreenPx(viewport, center, tilePx)
              : null;
          if (span != null) radius = pickRadiusFromTileScreenPx(span);
        }
      }

      const picked = deckInstance.pickObject({ x, y, radius });
      if (picked?.object) {
        setHoverInfo({ ...picked, x: e.clientX, y: e.clientY });
      } else {
        setHoverInfo(null);
      }
    };

    const handleMove = (e) => {
      pendingEvent = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const ev = pendingEvent;
        pendingEvent = null;
        if (ev) runPick(ev);
      });
    };

    const handleLeave = () => {
      pendingEvent = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      setHoverInfo(null);
    };

    containerEl.addEventListener("mousemove", handleMove);
    containerEl.addEventListener("mouseleave", handleLeave);
    return () => {
      pendingEvent = null;
      if (raf) cancelAnimationFrame(raf);
      containerEl.removeEventListener("mousemove", handleMove);
      containerEl.removeEventListener("mouseleave", handleLeave);
    };
  }, [
    deckRef,
    containerRef,
    selectedIds,
    hoverEnabled,
    effectivePickRadius,
    rawUsesOmeTiff,
    tilePx,
  ]);

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
    let size = outlineSize ?? computedImageSize;
    if (rawUsesOmeTiff && Number.isFinite(tilePx) && tilePx > 0) {
      const deckInstance = deckRef.current?.deck;
      const viewport = deckInstance?.getViewports?.()?.[0];
      const world = toWorld(hoverInfo.object);
      const span =
        viewport && world
          ? tileWorldSpanToScreenPx(viewport, world, tilePx)
          : null;
      if (span != null) size = span;
    }
    size = Math.max(6, size * hoverRingScale);
    setOutlineRect({ left: x - size / 2, top: y - size / 2, size });
  }, [
    hoverInfo,
    deckRef,
    containerRef,
    computedImageSize,
    outlineSize,
    rawUsesOmeTiff,
    tilePx,
    toWorld,
    hoverRingScale,
  ]);

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
        iconMappingsByChunk={iconMappingsByChunk}
        chunkUV={chunkUV}
        atlasByChannel={atlasByChannel}
        atlasURL={atlasURL}
        channels={channels}
        colors={colors}
        alphas={alphas}
        windows={windows}
        omePixelRangeByChannelId={omePixelRangeByChannelId}
        cellTypeAnnotationOn={cellTypeAnnotationOn}
        neighNamesAnnotationOn={neighNamesAnnotationOn}
        rawAnnotationById={rawAnnotationById}
        filteredIds={filteredIds}
        displayCoordById={displayCoordById}
        channelZarrIndexById={channelZarrIndexById}
      />
    </>
  );
}
