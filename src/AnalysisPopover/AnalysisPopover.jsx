import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./AnalysisPopover.css";
import {
  fetchT1,
  fetchT2,
  fetchViolinSelectionCellKDE,
  fetchRegionRepresentatives,
} from "../api/api";
import CellAnalysisPanel from "../FeaturePanel/LocalFeaturePanel/LocalFeaturePanel";
import GroupAnalysisPanel from "../FeaturePanel/GroupFeaturePanel/GroupFeaturePanel";
import CompareAnalysisPanel from "../FeaturePanel/CompareFeaturePanel/CompareFeaturePanel";
import {
  ANALYSIS_SINGLE,
  ANALYSIS_GROUP,
  ANALYSIS_COMPARE,
  SIMILARITY_GALLERY_K,
  SIMILARITY_FETCH_K,
} from "../constants/analysis";
import {
  buildIconMappingsByChunk,
  clampPositionToViewport,
  mapLogicalChannelsToZarr,
  pickDisplayableNeighbors,
} from "../utils/utils";

export default function AnalysisPopover({
  open,
  command,
  x = 0,
  y = 0,
  selectionBounds = null,
  onClose = () => {},
  meta,
  chunkUV,
  atlasURL,
  atlasByChannel,
  channels,
  channelZarrIndexById = {},
  colors,
  alphas,
  windows,
  pointsRaw = [],
  pointsUMAP = [],
  useUMAP = false,
  viewerId = "raw",
  selectedIds = new Set(),
  setSelectedIds = () => {},
}) {
  const iconMappingsByChunk = useMemo(
    () => buildIconMappingsByChunk(meta, chunkUV),
    [meta, chunkUV]
  );
  const rootRef = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [mode, setMode] = useState("none");
  const [t1, setT1] = useState(null);
  const [t2, setT2] = useState(null);
  const [tCompare, setTCompare] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const clampIntoViewport = () => {
    const node = rootRef.current;
    if (!node) return;
    const clamped = clampPositionToViewport(node, pos.x, pos.y, 12);
    if (clamped.x !== pos.x || clamped.y !== pos.y) setPos(clamped);
  };
  useLayoutEffect(() => {
    if (!open) return;
    clampIntoViewport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, t1, t2, tCompare]);
  useEffect(() => {
    const onResize = () => clampIntoViewport();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!open) {
      setMode("none");
      setT1(null);
      setT2(null);
      setTCompare(null);
      setBusy(false);
    }
  }, [open]);

  const handleDragMouseDown = (e) => {
    e.preventDefault();
    const node = rootRef.current;
    if (!node) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = { ...pos };
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const next = clampPositionToViewport(node, startPos.x + dx, startPos.y + dy, 12);
      setPos(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    const run = async () => {
      if (!open || !command) return;
      try {
        const viewportW = window.innerWidth || 1920;
        const viewportH = window.innerHeight || 1080;
        const approxWidth = Math.min(520, viewportW * 0.6);
        const approxHeight = Math.min(360, viewportH * 0.55);

        let nx = x;
        let ny = y;

        if (selectionBounds && typeof selectionBounds.x0 === "number" && typeof selectionBounds.y0 === "number") {
          const sb = selectionBounds;
          const cxSel = (sb.x0 + sb.x1) / 2;
          const cySel = (sb.y0 + sb.y1) / 2;
          const margin = 16;
          const candidates = [
            { x: cxSel - approxWidth / 2, y: sb.y0 - approxHeight - margin },
            { x: cxSel - approxWidth / 2, y: sb.y1 + margin },
            { x: sb.x0 - approxWidth - margin, y: cySel - approxHeight / 2 },
            { x: sb.x1 + margin, y: cySel - approxHeight / 2 },
          ];
          const score = (cand) => {
            const x0 = cand.x;
            const y0 = cand.y;
            const x1 = cand.x + approxWidth;
            const y1 = cand.y + approxHeight;
            const ix0 = Math.max(x0, sb.x0);
            const iy0 = Math.max(y0, sb.y0);
            const ix1 = Math.min(x1, sb.x1);
            const iy1 = Math.min(y1, sb.y1);
            const w = ix1 - ix0;
            const h = iy1 - iy0;
            const overlap = w > 0 && h > 0 ? w * h : 0;
            const outLeft = Math.max(0, -x0);
            const outRight = Math.max(0, x1 - viewportW);
            const outTop = Math.max(0, -y0);
            const outBottom = Math.max(0, y1 - viewportH);
            const overflow = outLeft + outRight + outTop + outBottom;
            return overlap + overflow * 1000;
          };
          let best = candidates[0];
          let bestScore = score(best);
          for (let i = 1; i < candidates.length; i++) {
            const s = score(candidates[i]);
            if (s < bestScore) {
              bestScore = s;
              best = candidates[i];
            }
          }
          nx = best.x;
          ny = best.y;
        } else {
          const preferRight = x < viewportW / 2;
          const preferBelow = y < viewportH / 2;
          nx = preferRight ? x + 24 : x - approxWidth - 24;
          ny = preferBelow ? y + 24 : y - approxHeight - 24;
        }
        if (!Number.isFinite(nx)) nx = 40;
        if (!Number.isFinite(ny)) ny = 40;
        setPos({ x: Math.round(nx), y: Math.round(ny) });
      } catch {
        setPos({ x: Math.round(x + 24), y: Math.round(Math.max(24, y - 80)) });
      }
      setBusy(true);
      try {
        if (command.type === ANALYSIS_SINGLE && Number.isFinite(command.q)) {
          setMode("single");
          setT2(null);
          setTCompare(null);
          const res = await fetchT1(Number(command.q), SIMILARITY_FETCH_K, undefined, "embedding");
          if (!openRef.current) return;
          if (!res || res.error) return;
          const neighbors = pickDisplayableNeighbors(
            res.neighbors,
            [pointsRaw, pointsUMAP],
            SIMILARITY_GALLERY_K,
          );
          setT1({ ...res, neighbors, k: neighbors.length });
          try {
            const neighborIds = neighbors.map((n) => n.id);
            const all = new Set([Number(command.q), ...neighborIds]);
            setSelectedIds(all);
          } catch {}
        } else if (command.type === ANALYSIS_GROUP && Array.isArray(command.ids)) {
          setMode("group");
          setT1(null);
          setTCompare(null);
          let ids = command.ids.map((v) => Number(v)).filter((v) => Number.isFinite(v));
          if (ids.length === 0) return;

          const total = ids.length;
          let maxGroup = 2500;
          if (total > 8000) {
            maxGroup = 5000;
          } else if (total > 2500) {
            maxGroup = 4000;
          }
          if (total > maxGroup) {
            const tmp = ids.slice();
            for (let i = tmp.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              const t = tmp[i];
              tmp[i] = tmp[j];
              tmp[j] = t;
            }
            ids = tmp.slice(0, maxGroup);
          }

          const res = await fetchT2(ids, undefined);
          if (!openRef.current) return;
          if (!res || res.error) return;
          setT2(res);
        } else if (command.type === ANALYSIS_COMPARE && Array.isArray(command.regions)) {
          setMode("compare");
          setT1(null);
          setT2(null);
          setTCompare(null);
          const regions = command.regions
            .map((arr) => (Array.isArray(arr) ? arr.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : []))
            .filter((arr) => arr.length > 0);
          if (regions.length < 2) return;
          const idsA = regions[regions.length - 2];
          const idsB = regions[regions.length - 1];
          const activeChs = mapLogicalChannelsToZarr(
            Array.isArray(channels) ? channels : [],
            channelZarrIndexById,
          );
          if (activeChs.length === 0) return;
          const [selA, selB, reps] = await Promise.all([
            fetchViolinSelectionCellKDE(idsA, 400, activeChs, 192, undefined),
            fetchViolinSelectionCellKDE(idsB, 400, activeChs, 192, undefined),
            fetchRegionRepresentatives([idsA, idsB], "cosine_centered", undefined),
          ]);
          if (!selA || selA.error || !selB || selB.error) return;
          if (!openRef.current) return;
          const repsArr = Array.isArray(reps?.regions) ? reps.regions : [];
          setTCompare({
            regions: [
              {
                ids: idsA,
                sel_kde: selA,
                representative: repsArr[0]?.representative ?? null,
                representative_similarity: repsArr[0]?.representative_similarity ?? null,
                compactness: repsArr[0]?.compactness ?? null,
                size: repsArr[0]?.size ?? idsA.length,
              },
              {
                ids: idsB,
                sel_kde: selB,
                representative: repsArr[1]?.representative ?? null,
                representative_similarity: repsArr[1]?.representative_similarity ?? null,
                compactness: repsArr[1]?.compactness ?? null,
                size: repsArr[1]?.size ?? idsB.length,
              },
            ],
          });
        } else {
          setMode("none");
          setT1(null);
          setT2(null);
          setTCompare(null);
        }
      } finally {
        setBusy(false);
      }
    };
    run();
  }, [open, command, setSelectedIds, channels, channelZarrIndexById, pointsRaw, pointsUMAP]);

  if (!open || mode === "none") return null;
  const points = useUMAP ? pointsUMAP : pointsRaw;

  return (
    <div
      ref={rootRef}
      className="analysis-popover"
      style={{ left: pos.x, top: pos.y }}
      onMouseEnter={(e) => {
        try {
          e.stopPropagation();
        } catch (_) {}
      }}
    >
      <button
        type="button"
        className="analysis-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label="Close"
      >
        ×
      </button>
      <div className="analysis-drag-handle" onMouseDown={handleDragMouseDown}>
        <div className="analysis-drag-pill" />
      </div>
      <div className="analysis-body">
        {busy ? (
          <div className="loading">Calculating...</div>
        ) : mode === "single" ? (
          <CellAnalysisPanel
            data={t1}
            iconMappingsByChunk={iconMappingsByChunk}
            chunkUV={chunkUV}
            atlasByChannel={atlasByChannel}
            channels={channels}
            colors={colors}
            alphas={alphas}
            windows={windows}
            points={points}
            viewerId={viewerId}
          />
        ) : mode === "group" ? (
          <GroupAnalysisPanel
            data={t2}
            iconMappingsByChunk={iconMappingsByChunk}
            chunkUV={chunkUV}
            atlasByChannel={atlasByChannel}
            atlasURL={atlasURL}
            channels={channels}
            channelZarrIndexById={channelZarrIndexById}
            colors={colors}
            alphas={alphas}
            points={points}
          />
        ) : (
          <CompareAnalysisPanel
            data={tCompare}
            iconMappingsByChunk={iconMappingsByChunk}
            chunkUV={chunkUV}
            atlasByChannel={atlasByChannel}
            atlasURL={atlasURL}
            channels={channels}
            channelZarrIndexById={channelZarrIndexById}
            colors={colors}
            alphas={alphas}
            windows={windows}
            points={points}
          />
        )}
      </div>
    </div>
  );
}
