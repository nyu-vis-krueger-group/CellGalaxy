import { useEffect } from "react";
import { LinearInterpolator } from "@deck.gl/core";
import {
  CELL_FOCUS_ZOOM_SPATIAL,
  CELL_FOCUS_ZOOM_UMAP,
} from "../constants/render";
import { ease } from "../utils/utils";

// window.__focusCell*, __showSimilarityRanking* for cross-viewer focus + rank overlay
export default function useGlobalCellFocusAndRanking({
  viewerId,
  useUMAP,
  points,
  setViewState,
  transitionsEnabled,
  setSimilarityRankings,
  /** (p) => [x,y,z] in Deck world space (incl. raw+OME y-flip) */
  mapWorldPosition = null,
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const toWorld =
      typeof mapWorldPosition === "function"
        ? mapWorldPosition
        : (p) => [p.x ?? 0, p.y ?? 0, p.z ?? 0];

    const isUmapViewer =
      viewerId === "umap" || (viewerId === "single" && useUMAP);
    const cellFocusZoom = isUmapViewer
      ? CELL_FOCUS_ZOOM_UMAP
      : CELL_FOCUS_ZOOM_SPATIAL;

    const focusKey = `__focusCell_${viewerId}`;
    window[focusKey] = (cellPos) => {
      if (!cellPos) return;
      let raw;

      // By id: use this viewer's coords; or legacy x,y,z
      if (typeof cellPos.id === "number" && Array.isArray(points) && points.length > 0) {
        const hit = points.find((p) => p.id === cellPos.id);
        if (!hit) return;
        raw = hit;
      } else if (typeof cellPos.x === "number" && typeof cellPos.y === "number") {
        raw = {
          x: cellPos.x ?? 0,
          y: cellPos.y ?? 0,
          z: cellPos.z ?? 0,
        };
      } else {
        return;
      }

      const [cellX, cellY, cellZ] = toWorld(raw);

      setViewState((prev) => ({
        ...prev,
        target: [cellX, cellY, cellZ],
        zoom: cellFocusZoom,
        transitionDuration: transitionsEnabled ? 800 : 0,
        transitionEasing: transitionsEnabled ? ease : undefined,
        transitionInterpolator: transitionsEnabled
          ? new LinearInterpolator(["target", "zoom"])
          : undefined,
      }));
    };

    const rankingKey = `__showSimilarityRanking_${viewerId}`;
    window[rankingKey] = (rankings) => {
      if (rankings && typeof rankings === "object") {
        let map = new Map();
        if (Array.isArray(rankings)) {
          rankings.forEach((id, index) => {
            if (id != null) {
              map.set(id, index);
            }
          });
        } else if (rankings instanceof Map) {
          map = rankings;
        } else {
          Object.entries(rankings).forEach(([id, rank]) => {
            const numId = Number(id);
            const numRank = Number(rank);
            if (!Number.isNaN(numId) && !Number.isNaN(numRank)) {
              map.set(numId, numRank);
            }
          });
        }
        setSimilarityRankings(map);
      } else {
        setSimilarityRankings(new Map());
      }
    };

    // Map raw/umap/single → global aliases
    if (viewerId === "raw" || (viewerId === "single" && !useUMAP)) {
      window.__focusCell = window[focusKey];
      window.__showSimilarityRanking = window[rankingKey];
    } else if (viewerId === "umap" || (viewerId === "single" && useUMAP)) {
      window.__focusCellUMAP = window[focusKey];
      window.__showSimilarityRankingUMAP = window[rankingKey];
    }

    return () => {
      if (window[focusKey]) {
        delete window[focusKey];
      }
      if (window[rankingKey]) {
        delete window[rankingKey];
      }
      if (viewerId === "raw" || (viewerId === "single" && !useUMAP)) {
        if (window.__focusCell === window[focusKey]) {
          delete window.__focusCell;
        }
        if (window.__showSimilarityRanking === window[rankingKey]) {
          delete window.__showSimilarityRanking;
        }
      } else if (viewerId === "umap" || (viewerId === "single" && useUMAP)) {
        if (window.__focusCellUMAP === window[focusKey]) {
          delete window.__focusCellUMAP;
        }
        if (window.__showSimilarityRankingUMAP === window[rankingKey]) {
          delete window.__showSimilarityRankingUMAP;
        }
      }
    };
  }, [
    viewerId,
    useUMAP,
    setViewState,
    transitionsEnabled,
    points,
    setSimilarityRankings,
    mapWorldPosition,
  ]);
}


