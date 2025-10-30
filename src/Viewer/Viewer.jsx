// =============================
// Viewer.jsx  (screen-space lasso overlay + accurate selection in 2D/3D)
// =============================
import React, { useMemo, useState, useEffect, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import WindowedIconLayer from "../layers/WindowedIconLayer";
import {
  OrthographicView,
  OrbitView,
  OrthographicController,
  OrbitController,
  LinearInterpolator,
} from "@deck.gl/core";
import {
  computeCenter,
  ease,
  buildIconMappingsByChunk,
  getEventCoordinates,
  computeSelectionBounds,
  performBoxSelection,
  performLassoSelection,
} from "../utils";
import "./Viewer.css";

const Viewer = ({
  meta,
  points,
  chunkUV,
  atlasURL,
  atlasByChannel,
  channels = [],
  colors = {},
  alphas = {},
  // Window (min/max for each channel, unit: raw values, e.g. 0..65535)
  windows = {},
  renderMode = "sprites",
  is3D = false,
  imageSize = 4,
  setImageSize = () => {},

  // Selection
  selectionMode = "none",
  selectedIds = new Set(),
  setSelectedIds = () => {},
  clearSelection = () => {},
  filteredIds = new Set(),
  // Shared zoom (optional): when provided, viewers sync zoom level
  sharedZoom,
  setSharedZoom,
}) => {
  const center = useMemo(() => computeCenter(points), [points]);

  const [viewState, setViewState] = useState(() => ({
    target: [0, 0, 0],
    zoom: typeof sharedZoom === 'number' ? sharedZoom : 8,
    rotationX: 0,
    rotationOrbit: 0,
    transitionDuration: 0,
    transitionEasing: undefined,
    transitionInterpolator: undefined,
  }));

  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current && points.length) {
      setViewState((prev) => ({ ...prev, target: center }));
      initialized.current = true;
    }
  }, [center, points.length]);

  // If parent provides sharedZoom, keep local viewState.zoom in sync
  useEffect(() => {
    if (typeof sharedZoom === 'number' && sharedZoom !== viewState.zoom) {
      setViewState((prev) => ({ ...prev, zoom: sharedZoom }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedZoom]);

  // Clean up timer
  useEffect(() => {
    return () => {
      if (zoomTimeoutRef.current) {
        clearTimeout(zoomTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setViewState((prev) => ({
      ...prev,
      rotationX: is3D ? 45 : 0,
      transitionDuration: 600,
      transitionEasing: ease,
      // Exclude 'zoom' from transitions to avoid post-gesture wobble
      transitionInterpolator: new LinearInterpolator([
        "rotationX",
        "rotationOrbit",
        "target",
      ]),
    }));
  }, [is3D]);

  // Zoom sensitivity control - improved trackpad support
  // const zoomSensitivity = 0.8; // Reduce zoom sensitivity for smoother trackpad
  // Note: keep sprite size independent from camera zoom to avoid double scaling
  const zoomTimeoutRef = useRef(null);
  
  const handleViewStateChange = ({ viewState: next }) => {
    const isZoomChange = next.zoom !== viewState.zoom;
    setViewState((prev) => ({
      ...next,
      // Avoid animating zoom updates; other transitions remain
      transitionDuration: isZoomChange ? 0 : (next.transitionDuration ?? prev.transitionDuration),
    }));

    // Propagate zoom to shared state if provided
    if (typeof setSharedZoom === 'function' && next.zoom !== sharedZoom) {
      setSharedZoom(next.zoom);
    }
  };

  const iconMappingsByChunk = useMemo(
    () => buildIconMappingsByChunk(meta, chunkUV),
    [meta, chunkUV]
  );

  // —— Selection (using screen coordinates) ——
  const deckRef = useRef(null);
  const containerRef = useRef(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [dragStart, setDragStart] = useState(null); // {x,y} screen
  const [dragEnd, setDragEnd] = useState(null); // {x,y} screen
  const [lassoPts, setLassoPts] = useState([]); // [[x,y],...] screen

  // Get unified screen coordinates (relative to canvas top-left)
  const getXY = (info) => getEventCoordinates(info, containerRef);

  const onDragStart = (info) => {
    if (selectionMode === "none") return;
    const { x, y } = getXY(info);
    setIsSelecting(true);
    setDragStart({ x, y });
    setDragEnd({ x, y });
    if (selectionMode === "lasso") setLassoPts([[x, y]]);
  };

  const onDrag = (info) => {
    if (!isSelecting) return;
    const { x, y } = getXY(info);
    setDragEnd({ x, y });
    if (selectionMode === "lasso") {
      setLassoPts((prev) =>
        prev.length &&
        prev[prev.length - 1][0] === x &&
        prev[prev.length - 1][1] === y
          ? prev
          : [...prev, [x, y]]
      );
    }
  };

  const onDragEnd = () => {
    if (!isSelecting) return;

    const deck = deckRef.current?.deck;
    const viewport = deck?.getViewports()[0];
    const ids = new Set();

    if (selectionMode === "box" && dragStart && dragEnd) {
      // Use utils function to calculate selection bounds
      const bounds = computeSelectionBounds(dragStart, dragEnd);
      // Use utils function to perform box selection
      const picked = performBoxSelection(deck, bounds);
      
      const activeFilter = filteredIds && filteredIds.size > 0;
      for (const p of picked) {
        const id = p?.object?.id;
        if (id == null) continue;
        if (activeFilter && !filteredIds.has(id)) continue; // ignore filtered-out items
        ids.add(id);
      }
    }

    if (selectionMode === "lasso" && lassoPts.length >= 3 && viewport) {
      // Use utils function to perform lasso selection
      const lassoIds = performLassoSelection(points, viewport, lassoPts);
      const activeFilter = filteredIds && filteredIds.size > 0;
      if (activeFilter) {
        for (const id of lassoIds) { if (filteredIds.has(id)) ids.add(id); }
      } else {
        lassoIds.forEach(id => ids.add(id));
      }
    }

    setSelectedIds(ids);
    setIsSelecting(false);
    setDragStart(null);
    setDragEnd(null);
    setLassoPts([]);
  };

  const onClick = (info) => {
    if (!info?.object) clearSelection();
  };

  // Establish a baseline zoom the first time we render. We map size by 2^(zoom-delta)
  const baseZoomRef = useRef(null);
  if (baseZoomRef.current == null) baseZoomRef.current = viewState.zoom;
  const zoomScale = Math.pow(2, (viewState.zoom ?? 0) - (baseZoomRef.current ?? 0));
  const computedImageSize = Math.max(1, Math.min(2048, imageSize * zoomScale));

  // Create base layer configuration
  const createBaseLayerConfig = (chunkId, arr, mapping) => ({
    data: arr.map((d) => ({ ...d, icon: `t_${d.local_index}` })),
    iconMapping: mapping,
    getIcon: (d) => d.icon,
    getPosition: (d) => [d.x, d.y, d.z ?? 0],
    // Keep sprite size synchronized with camera zoom
    getSize: computedImageSize,
    sizeScale: 1,
    fovy: 45,
    near: 0.1,
    far: 1000,
    distanceFadeEnabled: is3D,
    sizeUnits: "pixels",
    billboard: true,
    pickable: true,
    autoHighlight: true,
    loadOptions: { image: { type: 'imagebitmap' } },
    transitions: {
      getPosition: { duration: 600, easing: ease },
      getSize: { duration: 300, easing: ease },
    },
    updateTriggers: {
      getSize: [computedImageSize]
    }
  });

  const layers = useMemo(() => {
    if (!meta) return [];

    if (renderMode === "sprites") {
      const byChunk = new Map();
      for (const p of points ?? []) {
        const cid = p.chunk_id ?? 0;
        const arr = byChunk.get(cid) ?? [];
        arr.push(p);
        byChunk.set(cid, arr);
      }

      const all = [];
      for (const [chunkId, arr] of byChunk.entries()) {
        const mapping = iconMappingsByChunk?.[chunkId];
        if (!mapping) continue;

        const baseConfig = createBaseLayerConfig(chunkId, arr, mapping);
        let addedGray = false;

        // Overlay by channel
        for (const ch of channels) {
          const atlasGray = atlasByChannel?.[chunkId]?.[ch];
          if (!atlasGray) continue;
          addedGray = true;

          const col = colors?.[ch] || [255, 255, 255];
          const alpha01 = Math.min(1, Math.max(0, alphas?.[ch] ?? 1));
          const a = Math.round(alpha01 * 255);

          const w = windows?.[ch];
          const wMin = w && Number.isFinite(w.min) ? w.min : 0;
          const wMax = w && Number.isFinite(w.max) ? w.max : 65535;
          const winMin01 = Math.max(0, Math.min(1, wMin / 65535));
          const winMax01 = Math.max(0, Math.min(1, wMax / 65535));

          all.push(
            new WindowedIconLayer({
              ...baseConfig,
              id: `icon-ch${ch}-${chunkId}`,
              iconAtlas: String(atlasGray),
              parameters: { depthTest: false, blend: true, blendFunc: [1, 1], blendEquation: 32774 },
              windowMin: winMin01,
              windowMax: winMax01,
              premultiply: true,
              getColor: (d) => {
                if (selectedIds.has(d.id)) return [255, 140, 0, 255];
                const activeFilter = filteredIds && filteredIds.size > 0;
                if (activeFilter && !filteredIds.has(d.id)) {
                  const dimA = Math.min(a, 24);
                  return [col[0] ?? 255, col[1] ?? 255, col[2] ?? 255, dimA];
                }
                return [col[0] ?? 255, col[1] ?? 255, col[2] ?? 255, a];
              },
            })
          );
        }

        // Compatible with old approach
        const atlasMerged = !addedGray ? atlasURL?.[chunkId] : null;
        if (atlasMerged) {
          all.push(
            new WindowedIconLayer({
              ...baseConfig,
              id: `icon-merged-${chunkId}`,
              iconAtlas: String(atlasMerged),
              parameters: { depthTest: true, blend: true, blendFunc: [1, 1], blendEquation: 32774 },
              windowMin: 0.0,
              windowMax: 1.0,
              getColor: (d) => {
                if (selectedIds.has(d.id)) return [255, 140, 0, 255];
                const activeFilter = filteredIds && filteredIds.size > 0;
                if (activeFilter && !filteredIds.has(d.id)) return [255,255,255,30];
                return [255,255,255,255];
              },
            })
          );
        }
      }
      return all;
    } else {
      return [
        new ScatterplotLayer({
          id: "scatter",
          data: points ?? [],
          getPosition: (d) => [d.x, d.y, d.z ?? 0],
          getFillColor: (d) => {
            if (selectedIds.has(d.id)) return [255,140,0,255];
            const activeFilter = filteredIds && filteredIds.size > 0;
            if (activeFilter && !filteredIds.has(d.id)) return [255,255,255,30];
            return [255,255,255,255];
          },
          stroked: false,
          // Sync point radius with zoom the same way
          getRadius: computedImageSize*0.75,
          radiusScale: 1,
          radiusUnits: "pixels",
          pickable: true,
          autoHighlight: true,
          parameters: { depthTest: true },
          transitions: {
            getPosition: { duration: 600, easing: ease },
            getRadius: { duration: 300, easing: ease },
          },
          updateTriggers: {
            getFillColor: [selectedIds, filteredIds],
            getRadius: [computedImageSize]
          },
        })
      ];
    }
  }, [
    points,
    atlasURL,
    atlasByChannel,
    iconMappingsByChunk,
    meta,
    renderMode,
    imageSize,
    viewState.zoom,
    selectedIds,
    channels,
    colors,
    alphas,
    windows,
    is3D,
    filteredIds,
  ]);


  const controller =
    selectionMode === "none"
      ? is3D
        ? { 
            type: OrbitController,
            // Improved trackpad support
            scrollZoom: true,
            doubleClickZoom: true,
            inertia: true,
            inertiaFriction: 0.95,
            inertiaDeceleration: 0.95,
            // Trackpad zoom sensitivity
            scrollZoomSpeed: 0.8,
            // Smooth zoom
            smoothZoom: true,
            smoothZoomDuration: 200
          }
        : { 
            type: OrthographicController,
            // Improved trackpad support
            scrollZoom: true,
            doubleClickZoom: true,
            inertia: true,
            inertiaFriction: 0.95,
            inertiaDeceleration: 0.95,
            // Trackpad zoom sensitivity
            scrollZoomSpeed: 0.8,
            // Smooth zoom
            smoothZoom: true,
            smoothZoomDuration: 200
          }
      : false;

  // Place lasso visualization in screen-space SVG for WYSIWYG
  const lassoPath = lassoPts.length
    ? lassoPts.map(([x, y]) => `${x},${y}`).join(" ")
    : "";

  return (
    <div className="viewer-root" ref={containerRef}>
      <DeckGL
        ref={deckRef}
        views={
          is3D
            ? [new OrbitView({ id: "3d", orbitAxis: "Y", flipY: false })]
            : [new OrthographicView({ id: "2d", flipY: false })]
        }
        controller={controller}
        viewState={{ ...viewState, zoom: typeof sharedZoom === 'number' ? sharedZoom : viewState.zoom }}
        onViewStateChange={handleViewStateChange}
        layers={layers}
        onClick={onClick}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        getTooltip={({ object }) => {
          if (!object) return null;
          const activeFilter = filteredIds && filteredIds.size > 0;
          if (activeFilter && !filteredIds.has(object.id)) return null;
          return `id: ${object.id}\nlabel: ${object.label ?? object.id % 11}`;
        }}
        getCursor={() => "default"}
        pickingRadius={6}
      />

      {/* Box selection rectangle (screen space) */}
      {isSelecting && selectionMode === "box" && dragStart && dragEnd && (
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
      {isSelecting && selectionMode === "lasso" && lassoPts.length > 1 && (
        <svg className="lasso-svg">
          <polyline className="lasso-polyline" points={lassoPath} />
          {/* Optional: light fill for closed area */}
          <polygon className="lasso-fill" points={lassoPath} />
        </svg>
      )}
    </div>
  );
};

export default Viewer;
