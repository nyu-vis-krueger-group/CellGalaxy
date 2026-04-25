import React from "react";
import GroupToolbar from "./GroupToolbar";
import { ANALYSIS_GROUP, ANALYSIS_COMPARE } from "../../constants/analysis";

export default function GroupToolbarContainer({
  viewerId,
  isSelecting,
  selectedIds,
  selectedRegions = [],
  points,
  deckRef,
  containerRef,
  toolbar,
  setPopoverCmd,
  setPopoverPos,
  setPopoverBounds,
  setPopoverOpen,
  clearSelection,
  clearSimilarityRankings = () => {},
  rawAnnotationColumns = { celltype: false, neigh_names: false },
  onShowAnnotationStats = () => {},
  onCloseAnnotationStats = () => {},
  onZoomToSelection,
  onRestoreView,
  isZoomedToSelection = false,
  getWorldPosition = null,
}) {
  const toWorld =
    typeof getWorldPosition === "function"
      ? getWorldPosition
      : (p) => [p.x, p.y, p.z ?? 0];
  const hasRawAnnotationColumns =
    rawAnnotationColumns && rawAnnotationColumns.celltype && rawAnnotationColumns.neigh_names;
  const regions = Array.isArray(selectedRegions)
    ? selectedRegions.filter((r) => r && r.size > 0)
    : [];
  const regionCount = regions.length;
  const mode = regionCount >= 2 ? ANALYSIS_COMPARE : ANALYSIS_GROUP;
  const show =
    !isSelecting &&
    selectedIds &&
    selectedIds.size > 1 &&
    (typeof window === "undefined" || window.__selectionOwner === viewerId);

  const onAnalyze = () => {
    try {
      const ids = Array.from(selectedIds || []);
      if (ids.length > 1) {
        const deck = deckRef.current?.deck;
        const viewport = deck?.getViewports?.()[0];
        if (viewport) {
          let cnt = 0,
            sx = 0,
            sy = 0;
          let minX = Infinity,
            maxX = -Infinity,
            minY = Infinity,
            maxY = -Infinity;
          const dpr =
            typeof window !== "undefined" && window.devicePixelRatio
              ? window.devicePixelRatio
              : 1;
          for (const p of points) {
            if (!selectedIds.has(p.id)) continue;
            const [px, py] = viewport.project(toWorld(p));
            sx += px / dpr;
            sy += py / dpr;
            cnt++;
            const sx1 = px / dpr;
            const sy1 = py / dpr;
            if (sx1 < minX) minX = sx1;
            if (sx1 > maxX) maxX = sx1;
            if (sy1 < minY) minY = sy1;
            if (sy1 > maxY) maxY = sy1;
          }
          const container = containerRef.current;
          const cssW = container ? container.clientWidth : deck?.width || 0;
          const cx = cnt ? sx / cnt : cssW / 2;
          const cy = cnt ? sy / cnt : 24;
          const rect = container?.getBoundingClientRect
            ? container.getBoundingClientRect()
            : { left: 0, top: 0 };
          const gx = (rect.left || 0) + cx;
          const gy = (rect.top || 0) + cy;
          setPopoverPos({ x: gx, y: gy });
          if (cnt > 0 && typeof setPopoverBounds === "function" && minX < Infinity && minY < Infinity) {
            const margin = 8;
            const gx0 = (rect.left || 0) + minX - margin;
            const gy0 = (rect.top || 0) + minY - margin;
            const gx1 = (rect.left || 0) + maxX + margin;
            const gy1 = (rect.top || 0) + maxY + margin;
            setPopoverBounds({ x0: gx0, y0: gy0, x1: gx1, y1: gy1 });
          }
        } else {
          const container = containerRef.current;
          const rect = container?.getBoundingClientRect
            ? container.getBoundingClientRect()
            : { left: 0, top: 0 };
          const gx = (rect.left || 0) + (toolbar.x || 20);
          const gy = (rect.top || 0) + (toolbar.y || 20);
          setPopoverPos({ x: gx, y: gy });
          if (typeof setPopoverBounds === "function") {
            const r = 80;
            setPopoverBounds({
              x0: gx - r,
              y0: gy - r,
              x1: gx + r,
              y1: gy + r,
            });
          }
        }
        if (mode === ANALYSIS_COMPARE && regionCount >= 2) {
          const idsA = Array.from(regions[regionCount - 2] || []);
          const idsB = Array.from(regions[regionCount - 1] || []);
          setPopoverCmd({ type: ANALYSIS_COMPARE, regions: [idsA, idsB] });
        } else {
          setPopoverCmd({ type: ANALYSIS_GROUP, ids });
        }
        setPopoverOpen(true);
      }
    } catch {}
  };

  return (
    <GroupToolbar
      show={show}
      mode={mode}
      onAnalyze={onAnalyze}
      onClear={() => {
        // Restore camera only if user had zoomed-to-selection; else clear pick only (avoids bad zoom=8 on OME spatial)
        if (
          isZoomedToSelection &&
          typeof onRestoreView === "function"
        ) {
          onRestoreView();
        }
        clearSelection();
        try {
          clearSimilarityRankings();
        } catch {}
        try {
          onCloseAnnotationStats();
          setPopoverOpen(false);
          if (typeof setPopoverBounds === "function") {
            setPopoverBounds(null);
          }
          if (typeof setPopoverCmd === "function") {
            setPopoverCmd(null);
          }
        } catch {
          // ignore
        }
      }}
      hasRawAnnotationColumns={hasRawAnnotationColumns}
      onShowAnnotationStats={onShowAnnotationStats}
      onZoomToSelection={onZoomToSelection}
      onRestoreView={onRestoreView}
      isZoomedToSelection={isZoomedToSelection}
    />
  );
}

