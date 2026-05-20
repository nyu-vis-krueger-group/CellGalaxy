import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  getEventCoordinates,
  computeSelectionBounds,
  performBoxSelection,
  performGeometricBoxSelection,
  performLassoSelection,
} from "../utils/utils";
import { SELECTION_NONE, SELECTION_BOX, SELECTION_LASSO } from "../constants/selection";

export default function SelectionOverlay({
  containerRef,
  deckRef,
  viewerId = "viewer",
  selectionMode = "none", // 'none' | 'box' | 'lasso'
  points = [],
  /** Full point list for geometric box/lasso (e.g. all UMAP coords). Falls back to `points`. */
  selectionPoints = null,
  /** When true, box/lasso use world-space geometry instead of deck.pickObjects. */
  useGeometricSelection = false,
  /** Optional: world coords like Deck scatter (e.g. raw+OME y-flip) */
  getWorldPositionForSelection,
  filteredIds = new Set(),
  selectedRegions = [],
  setSelectedRegions = () => {},
  setSelectedIds = () => {},
  onBeginSelection = () => {},
  // Children get drag handlers + isSelecting
  children,
}) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [dragStart, setDragStart] = useState(null); // {x,y}
  const [dragEnd, setDragEnd] = useState(null); // {x,y}
  const [lassoPts, setLassoPts] = useState([]); // [[x,y],...]
  const additiveRef = useRef(false);
  const shiftDownRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === "Shift") shiftDownRef.current = true; };
    const onKeyUp = (e) => { if (e.key === "Shift") shiftDownRef.current = false; };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const getXY = (info) => getEventCoordinates(info, containerRef);

  const onDragStart = (info) => {
    if (selectionMode === SELECTION_NONE) return;
    onBeginSelection();
    const se = info?.srcEvent || info?.sourceEvent || info?.event || info?.nativeEvent;
    additiveRef.current = !!((se && se.shiftKey) || shiftDownRef.current);
    const { x, y } = getXY(info);
    setIsSelecting(true);
    setDragStart({ x, y });
    setDragEnd({ x, y });
    if (selectionMode === SELECTION_LASSO) setLassoPts([[x, y]]);
  };

  const onDrag = (info) => {
    if (!isSelecting) return;
    const { x, y } = getXY(info);
    setDragEnd({ x, y });
    if (selectionMode === SELECTION_LASSO) {
      setLassoPts((prev) =>
        prev.length &&
        prev[prev.length - 1][0] === x &&
        prev[prev.length - 1][1] === y
          ? prev
          : [...prev, [x, y]]
      );
    }
  };

  const onDragEnd = (info) => {
    if (!isSelecting) return;
    const deck = deckRef.current?.deck;
    const viewport = deck?.getViewports()[0];
    const ids = new Set();
    const isAdditive = !!additiveRef.current;
    const geomPoints =
      Array.isArray(selectionPoints) && selectionPoints.length > 0
        ? selectionPoints
        : points;

    if (selectionMode === SELECTION_BOX && dragStart && dragEnd) {
      const bounds = computeSelectionBounds(dragStart, dragEnd);
      const activeFilter = filteredIds && filteredIds.size > 0;
      if (useGeometricSelection && viewport) {
        const boxIds = performGeometricBoxSelection(
          geomPoints,
          viewport,
          bounds,
          getWorldPositionForSelection,
        );
        for (const id of boxIds) {
          if (activeFilter && !filteredIds.has(id)) continue;
          ids.add(id);
        }
      } else {
        const picked = performBoxSelection(deck, bounds);
        for (const p of picked) {
          const id = p?.object?.id;
          if (id == null) continue;
          if (activeFilter && !filteredIds.has(id)) continue;
          ids.add(id);
        }
      }
    }
    if (selectionMode === SELECTION_LASSO && lassoPts.length >= 3 && viewport) {
      const lassoIds = performLassoSelection(
        geomPoints,
        viewport,
        lassoPts,
        getWorldPositionForSelection,
      );
      const activeFilter = filteredIds && filteredIds.size > 0;
      if (activeFilter) {
        for (const id of lassoIds) { if (filteredIds.has(id)) ids.add(id); }
      } else {
        lassoIds.forEach(id => ids.add(id));
      }
    }

    let newRegions;
    if (isAdditive) {
      const prev = Array.isArray(selectedRegions) ? selectedRegions : [];
      if (prev.length >= 2) {
        newRegions = [prev[1], ids];
      } else {
        newRegions = [...prev, ids];
      }
    } else {
      newRegions = [ids];
    }

    const union = new Set();
    for (const r of newRegions) {
      if (!r) continue;
      for (const id of r) union.add(id);
    }
    setSelectedRegions(newRegions);
    setSelectedIds(union);
    try { window.__selectionOwner = viewerId; } catch {}

    setIsSelecting(false);
    additiveRef.current = false;
    setDragStart(null);
    setDragEnd(null);
    setLassoPts([]);
  };

  const lassoPath = useMemo(
    () => (lassoPts.length ? lassoPts.map(([x, y]) => `${x},${y}`).join(" ") : ""),
    [lassoPts]
  );

  return (
    <>
      {typeof children === "function" ? children({ onDragStart, onDrag, onDragEnd, isSelecting }) : null}
      {/* Box selection rectangle */}
      {isSelecting && selectionMode === SELECTION_BOX && dragStart && dragEnd && (
        <div
          className="selection-rect"
          style={{
            left: Math.min(dragStart.x, dragEnd.x),
            top: Math.min(dragStart.y, dragEnd.y),
            width: Math.abs(dragStart.x - dragEnd.x),
            height: Math.abs(dragStart.y - dragEnd.y),
          }}
        />
      )}
      {/* Lasso visualization (screen space SVG) */}
      {isSelecting && selectionMode === SELECTION_LASSO && lassoPts.length > 1 && (
        <svg className="lasso-svg">
          <polyline className="lasso-polyline" points={lassoPath} />
          <polygon className="lasso-fill" points={lassoPath} />
        </svg>
      )}
    </>
  );
}


