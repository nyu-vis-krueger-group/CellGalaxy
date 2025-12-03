import { useEffect } from "react";
import { LinearInterpolator } from "@deck.gl/core";
import { ease } from "../utils/utils";

/**
 * Register on window:
 *  - __focusCell_* / __focusCellUMAP / __focusCell
 *  - __showSimilarityRanking_* / __showSimilarityRankingUMAP / __showSimilarityRanking
 *
 * Used to focus cells and display similarity rankings across viewers,
 * without changing the existing global API.
 */
export default function useGlobalCellFocusAndRanking({
  viewerId,
  useUMAP,
  points,
  setViewState,
  transitionsEnabled,
  setSimilarityRankings,
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Register focus handler for current viewer
    const focusKey = `__focusCell_${viewerId}`;
    window[focusKey] = (cellPos) => {
      if (!cellPos) return;
      let cellX;
      let cellY;
      let cellZ;

      // Support focusing by id: find matching cell in current viewer's points,
      // each viewer uses its own projection coordinates (Raw / UMAP are independent).
      if (typeof cellPos.id === "number" && Array.isArray(points) && points.length > 0) {
        const hit = points.find((p) => p.id === cellPos.id);
        if (!hit) return;
        cellX = hit.x ?? 0;
        cellY = hit.y ?? 0;
        cellZ = hit.z ?? 0;
      } else if (typeof cellPos.x === "number" && typeof cellPos.y === "number") {
        // Backward compatibility: directly pass canvas-space coordinates
        cellX = cellPos.x ?? 0;
        cellY = cellPos.y ?? 0;
        cellZ = cellPos.z ?? 0;
      } else {
        return;
      }

      const targetZoom = 14; // target zoom level for focusing

      setViewState((prev) => ({
        ...prev,
        target: [cellX, cellY, cellZ],
        zoom: targetZoom,
        transitionDuration: transitionsEnabled ? 800 : 0,
        transitionEasing: transitionsEnabled ? ease : undefined,
        transitionInterpolator: transitionsEnabled
          ? new LinearInterpolator(["target", "zoom"])
          : undefined,
      }));
    };

    // Register function to show similarity rankings
    const rankingKey = `__showSimilarityRanking_${viewerId}`;
    window[rankingKey] = (rankings) => {
      if (rankings && typeof rankings === "object") {
        let map = new Map();
        if (Array.isArray(rankings)) {
          // If array: assume first is query (rank 0), rest are neighbors (rank 1-N)
          rankings.forEach((id, index) => {
            if (id != null) {
              map.set(id, index);
            }
          });
        } else if (rankings instanceof Map) {
          map = rankings;
        } else {
          // If plain object: key is id, value is rank
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

    // Also register shared focus functions (used by similarity gallery, etc.),
    // and decide which viewer's focus handler is bound based on viewerId.
    if (viewerId === "raw" || (viewerId === "single" && !useUMAP)) {
      window.__focusCell = window[focusKey];
      window.__showSimilarityRanking = window[rankingKey];
    } else if (viewerId === "umap" || (viewerId === "single" && useUMAP)) {
      window.__focusCellUMAP = window[focusKey];
      window.__showSimilarityRankingUMAP = window[rankingKey];
    }

    return () => {
      // Cleanup
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
  }, [viewerId, useUMAP, setViewState, transitionsEnabled, points, setSimilarityRankings]);
}


