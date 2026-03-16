// =============================
// Viewer.jsx  (screen-space lasso overlay + accurate selection in 2D/3D)
// =============================
import React, { useMemo, useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import DeckGL from "@deck.gl/react";
import AnalysisPopover from "../AnalysisPopover/AnalysisPopover";
import SelectionOverlay from "../SelectionOverlay/SelectionOverlay";
import { defaultRegionColors, makeRegionIndexGetter } from "../SelectionOverlay/selectionUtils";
import { ANALYSIS_SINGLE } from "../constants/analysis";
import { SELECTION_NONE} from "../constants/selection";
import {
  OrthographicView,
  OrbitView,
  OrthographicController,
  OrbitController,
  LinearInterpolator,
} from "@deck.gl/core";
import {
  buildIconMappingsByChunk,
  getEventCoordinates,
  ease,
  projectItemsToScreen,
  computeCenter,
} from "../utils/utils";
import { buildOutlineData2D, clusterColor } from "../utils/clustering";
import "./Viewer.css";
import ClickToolbar from "../ToolBar/ClickToolbar/ClickToolbar";
import GroupToolbarContainer from "../ToolBar/GroupToolbar/GroupToolbarContainer";
import ClusterHoverMask from "../ClusterHoverMask/ClusterHoverMask";
import DeckViewState from "./DeckViewState";
import ImageLayers from "../layers/ImageLayers";
import ClusterOutlines from "../ClusterHoverMask/ClusterOutlines";
import useClusterSelection from "./useClusterSelection";
import useClusterAnnotations from "./useClusterAnnotations";
import SemanticZoomControl from "./SemanticZoomControl/SemanticZoomControl";
import HoverPreview from "./HoverPreview/HoverPreview";
import ClusterPreviewThumb from "./ClusterPreviewThumb/ClusterPreviewThumb";
import ClusterAnnotationOverlay from "./ClusterAnnotationOverlay/ClusterAnnotationOverlay";
import SimilarityRankingOverlay from "./SimilarityRankingOverlay/SimilarityRankingOverlay";
import useGlobalCellFocusAndRanking from "./useGlobalCellFocusAndRanking";
import AnnotationStatsPopover from "../AnnotationStatsPopover/AnnotationStatsPopover";

const Viewer = ({
  viewerId = "viewer",
  meta,
  points,
  chunkUV,
  hoverMaskEnabled = false,
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
  rawImageSize,
  setImageSize = () => {},
  // In single-view mode: whether UMAP is currently shown
  useUMAP = false,

  // Selection
  selectionMode = "none",
  selectedIds = new Set(),
  setSelectedIds = () => {},
  selectedRegions = [],
  setSelectedRegions = () => {},
  clearSelection = () => {},
  filteredIds = new Set(),
  // Clustering overlay
  clusterColorOn = false,
  clusterOpacity = 0.25,
  clusterLineWidth = 1,
  clusterOutlineOn = false,
  // Cluster annotation (LLM titles/descriptions)
  clusterAnnotationOn = false,
  clusterAnnotationModel = "MedGemma",
  // Cluster preview (representative image per cluster, on UMAP view)
  clusterPreviewOn = true,
  // Per-cell annotation from raw (celltype, neigh_names) — only when raw has those columns
  cellTypeAnnotationOn = false,
  neighNamesAnnotationOn = false,
  rawAnnotationColumns = { celltype: false, neigh_names: false },
  // Shared zoom (optional): when provided, viewers sync zoom level
  sharedZoom,
  setSharedZoom,
  // Zoom sensitivity (how strong scroll wheel changes camera distance)
  zoomSpeed = 0.01,
  // Control view and point transition animations (from App)
  transitionsEnabled = true,
}) => {
  const isUMAPView =
    viewerId === "umap" || (viewerId === "single" && !!useUMAP);
  // Size control slider only affects UMAP; raw view uses rawImageSize (from tile+range).
  const effectiveImageSize = isUMAPView ? imageSize : (rawImageSize ?? imageSize);
  const {
    viewState,
    setViewState,
    handleViewStateChange,
    computedImageSize,
    altPressed,
    autoRotate,
  } = DeckViewState({
    points,
    is3D,
    sharedZoom,
    setSharedZoom,
    initialZoom: 8,
    imageSize: effectiveImageSize,
    transitionsEnabled,
  });

  const [semanticLevel, setSemanticLevel] = useState(6); // Default to finest level (1..6)
  const [isSemanticAuto, setIsSemanticAuto] = useState(true);
  // UMAP view: use multi-level cluster columns (cluster_L0...), raw view: use original label
  const clusterLabelKey = isUMAPView
    ? `cluster_L${semanticLevel - 1}`
    : "label";
  // In UMAP view, representative cell ranking fields per level (rank_L0...rank_L5)
  const clusterRankKey = isUMAPView
    ? `rank_L${semanticLevel - 1}`
    : null;

  // Auto-update semantic level based on zoom (only enabled in UMAP view), mapping zoom→level(1..6)
  useEffect(() => {
    if (!isUMAPView || !isSemanticAuto || !viewState) return;
    const z = typeof viewState.zoom === 'number' ? viewState.zoom : 8;
    let lvl = 6;
    if (z < 6) lvl = 1;
    else if (z < 7) lvl = 2;
    else if (z < 8) lvl = 3;
    else if (z < 9) lvl = 4;
    else if (z < 10) lvl = 5;
    else lvl = 6;
    
    setSemanticLevel(lvl);
  }, [isUMAPView, isSemanticAuto, viewState?.zoom]);

  // Sampling budget per semantic level (1..6): level 1 = 5k, level 6 = 100k, levels 2–5 scale linearly.
  const SAMPLING_BUDGETS = useMemo(
    () => [5000, 24000, 43000, 62000, 81000, 100000],
    []
  );

  const samplingThreshold = useMemo(() => {
    if (!points || points.length === 0) return 1.0;
    if (!isUMAPView) return 1.0;

    const idx = Math.max(0, Math.min(SAMPLING_BUDGETS.length - 1, semanticLevel - 1));
    const budget = SAMPLING_BUDGETS[idx];
    const total = points.length;
    return Math.min(1.0, budget / total);
  }, [isUMAPView, semanticLevel, SAMPLING_BUDGETS, points]);

  // For outline/selection/interaction logic, we still want a "visible" subset for CPU calculations,
  // but for rendering (ImageLayers) we pass ALL points and use GPU filtering.
  // ClusterOutlines and interaction still rely on this visiblePoints subset to match visuals.
  const visiblePoints = useMemo(() => {
    if (!points || points.length === 0) return [];
    if (samplingThreshold >= 1.0) return points;

    return points.filter((p) => {
      if (selectedIds.has(p.id)) return true;
      const hash = (p.id * 0.6180339887) % 1;
      return hash < samplingThreshold;
    });
  }, [points, samplingThreshold, selectedIds]);

  const iconMappingsByChunk = useMemo(
    () => buildIconMappingsByChunk(meta, chunkUV),
    [meta, chunkUV]
  );

  const { selectClusterByLabel, selectSingleById } = useClusterSelection({
    points: visiblePoints,
    filteredIds,
    selectedRegions,
    setSelectedRegions,
    setSelectedIds,
    viewerId,
    // Use the same dynamic label key as outlines/colors so Alt+click selects the whole cluster at the current semantic level
    labelKey: clusterLabelKey,
  });

  // —— Selection (using screen coordinates) ——
  const deckRef = useRef(null);
  const containerRef = useRef(null);
  // Defer DeckGL mount until container has valid size, then one more frame, so that
  // luma.gl's internal ResizeObserver does not fire before device.limits is ready
  // (avoids "Cannot read properties of undefined (reading 'maxTextureDimension2D')" on slower machines).
  const [containerReady, setContainerReady] = useState(false);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== el) continue;
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          requestAnimationFrame(() => setContainerReady(true));
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [toolbar, setToolbar] = useState({ show: false, x: 0, y: 0, object: null });
  // Analysis popover state
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverCmd, setPopoverCmd] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverBounds, setPopoverBounds] = useState(null);
  const [annotationStatsOpen, setAnnotationStatsOpen] = useState(false);
  // Zoom-to-selection: restore goes to default initial view (center + zoom 8), not a saved state
  const [isZoomedToSelection, setIsZoomedToSelection] = useState(false);
  // Similarity ranking: Map of cell ID -> rank (0 for query, 1-N for neighbors)
  const [similarityRankings, setSimilarityRankings] = useState(new Map());
  // Distinct highlight colors for up to two regions
  const regionColors = defaultRegionColors;
  const getRegionIndexForId = useMemo(
    () => makeRegionIndexGetter(selectedRegions),
    [selectedRegions]
  );

  // Helper: clear similarity ranking labels in this viewer and, via global
  // helpers, in the paired viewer as well (Raw / UMAP).
  const clearAllSimilarityRankings = () => {
    setSimilarityRankings(new Map());
    try {
      if (typeof window !== "undefined") {
        if (typeof window.__showSimilarityRanking === "function") {
          window.__showSimilarityRanking(null);
        }
        if (typeof window.__showSimilarityRankingUMAP === "function") {
          window.__showSimilarityRankingUMAP(null);
        }
      }
    } catch {
      // ignore
    }
  };

  // Zoom viewer to center on selected region
  const zoomToSelection = useCallback(() => {
    if (!points?.length || !selectedIds?.size) return;
    const selected = points.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of selected) {
      const x = p.x ?? 0, y = p.y ?? 0, z = p.z ?? 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    setIsZoomedToSelection(true);
    setViewState((prev) => ({
      ...prev,
      target: [cx, cy, cz],
      zoom: 12,
      transitionDuration: transitionsEnabled ? 600 : 0,
      transitionEasing: transitionsEnabled ? ease : undefined,
      transitionInterpolator: transitionsEnabled
        ? new LinearInterpolator(["target", "zoom"])
        : undefined,
    }));
  }, [points, selectedIds, setViewState, transitionsEnabled]);

  // Restore to default initial view (data center + zoom 8), not a previously saved state
  const initialTarget = useMemo(() => computeCenter(points || []), [points]);
  const restoreView = useCallback(() => {
    setViewState((prev) => ({
      ...prev,
      target: initialTarget,
      zoom: 8,
      transitionDuration: transitionsEnabled ? 600 : 0,
      transitionEasing: transitionsEnabled ? ease : undefined,
      transitionInterpolator: transitionsEnabled
        ? new LinearInterpolator(["target", "zoom"])
        : undefined,
    }));
    setIsZoomedToSelection(false);
  }, [initialTarget, setViewState, transitionsEnabled]);

  const onClick = (info) => {
    // In box/lasso selection mode, completely disable click-based single selection/deselection;
    // selection can only be changed via box/lasso drag.
    if (selectionMode !== SELECTION_NONE) {
      return;
    }

    // If there are already selected IDs, forbid changing anything via clicks (including clicking empty space to clear);
    // the selection can only be cleared via the toolbar close (X) button.
    if (selectedIds && selectedIds.size > 0) {
      return;
    }
    if (!info?.object) {
      if (toolbar.show) setToolbar({ show: false, x: 0, y: 0, object: null });
      setPopoverOpen(false);
      setPopoverBounds(null);
      clearAllSimilarityRankings(); // clear similarity ranking labels
      return;
    }
    if (altPressed) {
      // Use dynamic label key for selection
      const val = info?.object?.[clusterLabelKey];
      const lbl = Number.isFinite(val) ? val : info?.object?.label;
      if (selectClusterByLabel(lbl)) {
        return;
      }
    }

    selectSingleById(info?.object?.id);
    // Keep the lightweight toolbar (can be closed)
    const { x, y } = getEventCoordinates(info, containerRef);
    setToolbar({ show: true, x, y, object: info.object });

    // Auto-focus to selected cell if current zoom is small (view is far out)
    const currentZoom = typeof viewState?.zoom === "number" ? viewState.zoom : 8;
    const zoomThreshold = 9; // treat zoom < 9 as "small view"
    if (currentZoom < zoomThreshold && info?.object) {
      const cellX = info.object.x ?? 0;
      const cellY = info.object.y ?? 0;
      const cellZ = info.object.z ?? 0;
      const targetZoom = 14; // target zoom level when focusing
      
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
    }
  };

  // Lazily build clustering outlines (convex hulls)
  const outlineData = useMemo(() => {
    if (is3D || !visiblePoints || visiblePoints.length < 3) return [];
    // Pass dynamic label key
    return buildOutlineData2D(visiblePoints, clusterLabelKey);
  }, [is3D, visiblePoints, clusterLabelKey]);

  const screenOutlines = ClusterOutlines({
    is3D,
    clusterOutlineOn,
    forceCompute: clusterAnnotationOn,
    points: visiblePoints,
    filteredIds,
    deckRef,
    viewDeps: [viewState.zoom, viewState.rotationX, viewState.rotationOrbit, viewState.target],
    labelKey: clusterLabelKey,
  });

  // —— Choose one representative cell per cluster (minimum rank) for fixed preview cards ——
  const clusterPreviewPoints = useMemo(() => {
    if (!isUMAPView) return [];
    if (!clusterPreviewOn) return [];
    if (!points || points.length === 0) return [];
    // Only show cluster previews at level 1–5 (coarse to mid levels)
    if (!clusterRankKey || semanticLevel < 1 || semanticLevel > 5) return [];

    const byLabel = new Map();
    for (const p of points) {
      const val = p?.[clusterLabelKey];
      const label = Number.isFinite(val) ? val : (p?.label ?? null);
      if (!Number.isFinite(label)) continue;
      const r = p?.[clusterRankKey];
      if (!Number.isFinite(r)) continue;
      const prev = byLabel.get(label);
      if (!prev || r < prev.rank) {
        byLabel.set(label, { point: p, rank: r });
      }
    }
    return Array.from(byLabel.values()).map((v) => v.point);
  }, [isUMAPView, clusterPreviewOn, points, clusterLabelKey, clusterRankKey, semanticLevel]);

  // Project representative cell positions into screen coordinates for DOM preview card placement
  const [clusterPreviewScreens, setClusterPreviewScreens] = useState([]);

  useEffect(() => {
    if (!isUMAPView || !clusterPreviewOn) {
      setClusterPreviewScreens([]);
      return;
    }
    if (!clusterPreviewPoints || clusterPreviewPoints.length === 0) {
      setClusterPreviewScreens([]);
      return;
    }

    const result = projectItemsToScreen({
      deckRef,
      containerRef,
      items: clusterPreviewPoints,
      getWorldPosition: (p) => [p.x, p.y, p.z ?? 0],
      mapResult: (p, sx, sy, offsetX, offsetY) => ({
        point: p,
        x: sx + offsetX,
        y: sy + offsetY,
        canvasX: sx,
        canvasY: sy,
      }),
    });
    if (result.length === 0) return;
    setClusterPreviewScreens(result);
  }, [isUMAPView, clusterPreviewOn, clusterPreviewPoints, viewState, deckRef, containerRef]);

  // Screen positions for cluster titles (DOM overlay at cluster centroid)
  const [clusterAnnotationScreens, setClusterAnnotationScreens] = useState([]);

  const [hoveredAnnotationLabel, setHoveredAnnotationLabel] = useState(null);
  const descriptionRefs = useRef({});

  // Load raw.json for per-cell annotation (celltype, neigh_names) when any annotation toggle is on
  const [rawAnnotationById, setRawAnnotationById] = useState(() => new Map());
  useEffect(() => {
    if (!cellTypeAnnotationOn && !neighNamesAnnotationOn) {
      setRawAnnotationById(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const base = typeof window !== "undefined" && window.location?.port === "3000" ? "http://localhost:8000" : "";
        const res = await fetch(`${base}/public/raw.json?ts=${Date.now()}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!Array.isArray(data) || cancelled) return;
        const map = new Map();
        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          if (row && typeof row.id === "number" && row.raw && typeof row.raw === "object") {
            const ct = row.raw.celltype;
            const nn = row.raw.neigh_names;
            if (ct != null || nn != null) {
              map.set(row.id, { celltype: ct != null ? String(ct) : "", neigh_names: nn != null ? String(nn) : "" });
            }
          }
        }
        if (!cancelled) setRawAnnotationById(map);
      } catch (e) {
        if (!cancelled) setRawAnnotationById(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [cellTypeAnnotationOn, neighNamesAnnotationOn]);

  // When filter is active: compute dominant celltype/neigh_names per cluster from filtered cells only
  const filteredDominantAnnotations = useMemo(() => {
    if (!filteredIds || filteredIds.size === 0 || !rawAnnotationById || rawAnnotationById.size === 0) return null;
    if (!points || points.length === 0) return null;
    const levels = {};
    const mode = (arr) => {
      if (!arr.length) return null;
      const c = {};
      for (const v of arr) c[v] = (c[v] || 0) + 1;
      let best = "";
      let bestN = 0;
      for (const [v, n] of Object.entries(c)) if (n > bestN) { bestN = n; best = v; }
      return best;
    };
    for (let level = 0; level < 6; level++) {
      const clusterKey = `cluster_L${level}`;
      const byCluster = {};
      for (const p of points) {
        if (!filteredIds.has(p.id)) continue;
        const cid = p[clusterKey];
        if (cid == null) continue;
        const ann = rawAnnotationById.get(p.id);
        if (!ann) continue;
        const cidStr = String(cid);
        if (!byCluster[cidStr]) byCluster[cidStr] = { celltype: [], neigh_names: [] };
        if (ann.celltype != null && String(ann.celltype).trim()) byCluster[cidStr].celltype.push(String(ann.celltype).trim());
        if (ann.neigh_names != null && String(ann.neigh_names).trim()) byCluster[cidStr].neigh_names.push(String(ann.neigh_names).trim());
      }
      const levelOut = {};
      for (const [cid, arr] of Object.entries(byCluster)) {
        levelOut[cid] = {
          celltype: mode(arr.celltype),
          neigh_names: mode(arr.neigh_names),
        };
      }
      levels[String(level)] = levelOut;
    }
    return { levels };
  }, [points, rawAnnotationById, filteredIds]);

  // Cluster annotation (text layer + tooltip data), derived from outlineData (2D) or projected screen outlines (3D)
  const { annotationLayer, clusterAnnotationData } = useClusterAnnotations({
    clusterAnnotationOn,
    clusterAnnotationModel,
    outlineData,
    viewState,
    is3D,
    screenOutlines3D: screenOutlines,
    level: semanticLevel,
    filteredDominantAnnotations,
  });

  // We now always render titles/descriptions via DOM overlays instead of the original DeckGL TextLayer
  const showAnnotationLayer = false;

  useEffect(() => {
    if (!isUMAPView || !clusterAnnotationOn) {
      setClusterAnnotationScreens([]);
      return;
    }
    if (!clusterAnnotationData || clusterAnnotationData.length === 0) {
      setClusterAnnotationScreens([]);
      return;
    }
    const result = projectItemsToScreen({
      deckRef,
      containerRef,
      items: clusterAnnotationData,
      getWorldPosition: (d) => d.position || [0, 0, 0],
      mapResult: (d, sx, sy, offsetX, offsetY) => ({
        ...d,
        x: sx + offsetX,
        y: sy + offsetY,
      }),
    });
    if (result.length === 0) return;
    setClusterAnnotationScreens(result);
  }, [
    isUMAPView,
    clusterAnnotationOn,
    clusterAnnotationData,
    viewState,
    deckRef,
    containerRef,
  ]);

  // Per-cell annotation labels: show at moderate zoom (lower threshold = show when less zoomed in)
  const ZOOM_THRESHOLD_CELL_ANNOTATION = 11;
  const MAX_CELL_ANNOTATIONS_VISIBLE = 400;
  const ANNOTATION_GRID_SIZE = 16; // spatial sampling grid for even distribution
  const [cellAnnotationScreens, setCellAnnotationScreens] = useState([]);
  useEffect(() => {
    if (!(cellTypeAnnotationOn || neighNamesAnnotationOn) || !visiblePoints?.length || !rawAnnotationById?.size) {
      setCellAnnotationScreens([]);
      return;
    }
    const z = typeof viewState?.zoom === "number" ? viewState.zoom : 0;
    if (z < ZOOM_THRESHOLD_CELL_ANNOTATION) {
      setCellAnnotationScreens([]);
      return;
    }
    const projected = projectItemsToScreen({
      deckRef,
      containerRef,
      items: visiblePoints,
      getWorldPosition: (p) => [p.x, p.y, p.z ?? 0],
      mapResult: (p, sx, sy, offsetX, offsetY) => ({ ...p, x: sx + offsetX, y: sy + offsetY }),
    });
    const containerEl = containerRef?.current;
    const w = containerEl?.clientWidth ?? 2000;
    const h = containerEl?.clientHeight ?? 2000;
    const hasFilter = filteredIds && filteredIds.size > 0;
    const inView = projected.filter((p) => {
      if (hasFilter && !filteredIds.has(p.id)) return false;
      const ann = rawAnnotationById.get(p.id);
      if (!ann) return false;
      const show = (cellTypeAnnotationOn && ann.celltype) || (neighNamesAnnotationOn && ann.neigh_names);
      if (!show) return false;
      return p.x >= -50 && p.x <= w + 50 && p.y >= -50 && p.y <= h + 50;
    });
    // When over limit: sample by viewport grid so labels are spread across the view, not clustered in one region
    let limited;
    if (inView.length <= MAX_CELL_ANNOTATIONS_VISIBLE) {
      limited = inView;
    } else {
      const g = ANNOTATION_GRID_SIZE;
      const cellW = (w + 100) / g;
      const cellH = (h + 100) / g;
      const byCell = new Map();
      for (const p of inView) {
        const cx = Math.max(0, Math.min(g - 1, Math.floor((p.x + 50) / cellW)));
        const cy = Math.max(0, Math.min(g - 1, Math.floor((p.y + 50) / cellH)));
        const key = `${cx},${cy}`;
        if (!byCell.has(key)) byCell.set(key, []);
        byCell.get(key).push(p);
      }
      const maxPerCell = Math.max(1, Math.ceil(MAX_CELL_ANNOTATIONS_VISIBLE / (g * g)));
      limited = [];
      const cellKeys = [...byCell.keys()].sort();
      for (const key of cellKeys) {
        const arr = byCell.get(key);
        for (let i = 0; i < Math.min(maxPerCell, arr.length); i++) {
          limited.push(arr[i]);
          if (limited.length >= MAX_CELL_ANNOTATIONS_VISIBLE) break;
        }
        if (limited.length >= MAX_CELL_ANNOTATIONS_VISIBLE) break;
      }
    }
    setCellAnnotationScreens(limited.map((p) => {
      const ann = rawAnnotationById.get(p.id) || {};
      let text = "";
      if (cellTypeAnnotationOn && ann.celltype) text += ann.celltype;
      if (cellTypeAnnotationOn && ann.celltype && neighNamesAnnotationOn && ann.neigh_names) text += " · ";
      if (neighNamesAnnotationOn && ann.neigh_names) text += ann.neigh_names;
      return { ...p, text };
    }));
  }, [
    cellTypeAnnotationOn,
    neighNamesAnnotationOn,
    visiblePoints,
    rawAnnotationById,
    filteredIds,
    viewState,
    deckRef,
    containerRef,
  ]);

  // Screen positions for similarity ranking labels (DOM overlay)
  const [similarityRankingScreens, setSimilarityRankingScreens] = useState([]);

  // Register global focus and similarity ranking handlers,
  // used by similarity gallery or other modules to focus cells across viewers
  useGlobalCellFocusAndRanking({
    viewerId,
    useUMAP,
    points,
    setViewState,
    transitionsEnabled,
    setSimilarityRankings,
  });

  // Screen-space positions for currently selected tiles (white outlines).
  const [selectedTileScreens, setSelectedTileScreens] = useState([]);

  useEffect(() => {
    if (!selectedIds || selectedIds.size === 0 || !visiblePoints || visiblePoints.length === 0) {
      setSelectedTileScreens([]);
      return;
    }
    const selectedPointsForOutline = visiblePoints.filter((p) => selectedIds.has(p.id));
    if (selectedPointsForOutline.length === 0) {
      setSelectedTileScreens([]);
      return;
    }

    const result = projectItemsToScreen({
      deckRef,
      containerRef,
      items: selectedPointsForOutline,
      getWorldPosition: (p) => [p.x, p.y, p.z ?? 0],
      mapResult: (p, sx, sy, offsetX, offsetY) => {
        const rIdx = typeof getRegionIndexForId === "function"
          ? getRegionIndexForId(p.id)
          : -1;
        const col =
          typeof rIdx === "number" && rIdx >= 0 && regionColors && regionColors.length
            ? regionColors[Math.min(rIdx, regionColors.length - 1)]
            : null;
        return {
          id: p.id,
          x: sx + offsetX,
          y: sy + offsetY,
          regionIndex: rIdx,
          color: col,
        };
      },
    });
    if (!result || result.length === 0) {
      setSelectedTileScreens([]);
      return;
    }
    setSelectedTileScreens(result);
  }, [selectedIds, visiblePoints, viewState, deckRef, containerRef, getRegionIndexForId, regionColors]);

  useEffect(() => {
    if (!similarityRankings || similarityRankings.size === 0) {
      setSimilarityRankingScreens([]);
      return;
    }
    // Find all points that should display ranking labels
    const rankedPoints = points.filter((p) => similarityRankings.has(p.id));
    if (rankedPoints.length === 0) {
      setSimilarityRankingScreens([]);
      return;
    }

    const result = projectItemsToScreen({
      deckRef,
      containerRef,
      items: rankedPoints,
      getWorldPosition: (p) => [p.x, p.y, p.z ?? 0],
      mapResult: (p, sx, sy, offsetX, offsetY) => ({
        id: p.id,
        x: sx + offsetX,
        y: sy + offsetY,
        rank: similarityRankings.get(p.id),
      }),
    });
    if (result.length === 0) return;
    setSimilarityRankingScreens(result);
  }, [similarityRankings, points, viewState, deckRef, containerRef]);

  const layers = ImageLayers({
    meta,
    renderMode,
    points,  // Pass ALL points to ImageLayers for GPU filtering
    atlasURL,
    atlasByChannel,
    iconMappingsByChunk,
    channels,
    colors,
    alphas,
    windows,
    is3D,
    filteredIds,
    clusterColorOn,
    clusterOpacity,
    clusterLineWidth,
    clusterOutlineOn,
    outlineData,
    computedImageSize,
    getRegionIndexForId,
    regionColors,
    labelKey: clusterLabelKey,
    samplingThreshold,  // New prop for GPU filtering
    selectedIds,        // Needed to exclude selected items from filtering
    transitionsEnabled,
  });

  const controller =
    selectionMode === SELECTION_NONE
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
            scrollZoomSpeed: zoomSpeed,
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
            scrollZoomSpeed: zoomSpeed,
            // Smooth zoom
            smoothZoom: true,
            smoothZoomDuration: 200
          }
      : false;

  return (
    <div className="viewer-root" ref={containerRef}>
      {!containerReady ? (
        <div style={{ width: "100%", height: "100%" }} aria-hidden="true" />
      ) : (
      <>
      <SelectionOverlay
        containerRef={containerRef}
        deckRef={deckRef}
        viewerId={viewerId}
        selectionMode={selectionMode}
        points={visiblePoints}
        filteredIds={filteredIds}
        selectedRegions={selectedRegions}
        setSelectedRegions={setSelectedRegions}
        setSelectedIds={setSelectedIds}
        onBeginSelection={() => {
          if (toolbar.show) setToolbar({ show: false, x: 0, y: 0, object: null });
        }}
      >
        {({ onDragStart, onDrag, onDragEnd, isSelecting }) => (
          <>
            <ClusterHoverMask
              outlineData={outlineData}
              is3D={is3D}
              deckRef={deckRef}
              containerRef={containerRef}
              active={hoverMaskEnabled && clusterOutlineOn}
              altPressed={altPressed}
              screenOutlines3D={screenOutlines}
            >
              {({ onHover, layers: hoverLayers }) => (
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
                  layers={layers
                    .concat(showAnnotationLayer && annotationLayer ? [annotationLayer] : [])
                    .concat(hoverLayers)}
                  onClick={onClick}
                  onHover={onHover}
                  onDragStart={onDragStart}
                  onDrag={onDrag}
                  onDragEnd={onDragEnd}
                  getTooltip={null}
                  getCursor={() => "default"}
                  pickingRadius={6}
                />
              )}
            </ClusterHoverMask>

            {/* 3D mode clustering outlines: screen-space SVG overlay */}
            {is3D && clusterOutlineOn && screenOutlines.length > 0 && (
              <svg className="cluster-outline-svg">
                {screenOutlines.map((s, i) => (
                  <path key={i} d={s.d} fill="none" stroke={s.color} strokeWidth={clusterLineWidth} />
                ))}
              </svg>
            )}

            {/* 3D mode: spacebar toggles auto-rotate hint */}
            {is3D && (
              <div className="viewer-3d-autorotate-hint" aria-hidden="true">
                Space: auto-rotate {autoRotate ? "On" : "Off"}
              </div>
            )}

            {/* Group analysis toolbar */}
            <GroupToolbarContainer
              viewerId={viewerId}
              isSelecting={isSelecting}
              selectedIds={selectedIds}
              selectedRegions={selectedRegions}
              points={visiblePoints}
              deckRef={deckRef}
              containerRef={containerRef}
              toolbar={toolbar}
              setPopoverCmd={setPopoverCmd}
              setPopoverPos={setPopoverPos}
              setPopoverBounds={setPopoverBounds}
              setPopoverOpen={setPopoverOpen}
              clearSelection={clearSelection}
              clearSimilarityRankings={clearAllSimilarityRankings}
              rawAnnotationColumns={rawAnnotationColumns}
              onShowAnnotationStats={() => setAnnotationStatsOpen(true)}
              onCloseAnnotationStats={() => setAnnotationStatsOpen(false)}
              onZoomToSelection={zoomToSelection}
              onRestoreView={restoreView}
              isZoomedToSelection={isZoomedToSelection}
            />
          </>
        )}
      </SelectionOverlay>

      {/* Fixed cluster representative previews (levels 1–4), reusing hover tooltip styles */}
      {isUMAPView &&
        clusterPreviewOn &&
        semanticLevel >= 1 &&
        semanticLevel <= 5 &&
        clusterPreviewScreens &&
        clusterPreviewScreens.length > 0 &&
        clusterPreviewScreens.map(({ point, x, y }) => {
          if (!point) return null;
          // Fixed preview size to avoid recomputing thumbnails during zoom for smoother interaction.
          const previewSize = 64;
          const val = point?.[clusterLabelKey];
          const lbl = Number.isFinite(val) ? val : (point.label ?? 0);
          const rgb = clusterColor(lbl);
          const borderColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.9)`;

          return (
            <ClusterPreviewThumb
              key={`cluster-preview-${point.id}`}
              point={point}
              x={x}
              y={y}
              previewSize={previewSize}
              borderColor={borderColor}
              iconMappingsByChunk={iconMappingsByChunk}
              chunkUV={chunkUV}
              atlasByChannel={atlasByChannel}
              channels={channels}
              colors={colors}
              alphas={alphas}
              windows={windows}
            />
          );
        })}

      {/* Cluster titles: rendered at cluster centers (DOM); description is only shown on hover */}
      {isUMAPView &&
        clusterAnnotationOn &&
        semanticLevel >= 1 &&
        semanticLevel <= 6 &&
        clusterAnnotationScreens &&
        clusterAnnotationScreens.length > 0 && (
          <ClusterAnnotationOverlay
            annotations={clusterAnnotationScreens}
            viewStateZoom={viewState?.zoom}
            altPressed={altPressed}
            clusterColor={clusterColor}
            hoveredAnnotationLabel={hoveredAnnotationLabel}
            setHoveredAnnotationLabel={setHoveredAnnotationLabel}
            descriptionRefs={descriptionRefs}
            cellTypeAnnotationOn={cellTypeAnnotationOn}
            neighNamesAnnotationOn={neighNamesAnnotationOn}
          />
        )}

      {/* Similarity ranking labels (DOM overlay) */}
      {similarityRankingScreens && similarityRankingScreens.length > 0 && (
        <SimilarityRankingOverlay items={similarityRankingScreens} />
      )}

      {/* Per-cell annotation labels when zoomed in (celltype / neigh_names) */}
      {cellAnnotationScreens && cellAnnotationScreens.length > 0 && (
        <div className="cell-annotation-overlay" aria-hidden="true">
          {cellAnnotationScreens.map((item) => (
            <div
              key={`cell-ann-${item.id}`}
              className="cell-annotation-label"
              style={{ left: item.x, top: item.y }}
            >
              {item.text}
            </div>
          ))}
        </div>
      )}

      {/* Click toolbar */}
      <ClickToolbar
        show={toolbar.show}
        x={toolbar.x}
        y={toolbar.y}
        onClose={() => {
          setToolbar({ show: false, x: 0, y: 0, object: null });
          clearSelection();
          clearAllSimilarityRankings(); // clear similarity ranking labels
        }}
        // In "single" mode, disable the navigation button that jumps to the other view:
        // do not pass onViewRaw so ClickToolbar renders the button as disabled.
        onViewRaw={
          viewerId === "single"
            ? undefined
            : () => {
                // When clicking the "eye" button, ask the other projection view (Raw/UMAP)
                // to focus by id using its own projection coordinates.
                const obj = toolbar.object;
                if (!obj || typeof window === "undefined") return;

                if (isUMAPView) {
                  // Currently in UMAP view → notify Raw view to focus by id
                  if (typeof window.__focusCell === "function") {
                    window.__focusCell({ id: obj.id });
                  }
                } else {
                  // Currently in Raw view → notify UMAP view to focus by id
                  if (typeof window.__focusCellUMAP === "function") {
                    window.__focusCellUMAP({ id: obj.id });
                  }
                }
                // Note: do not hide the toolbar here so the user can still click the X to clear selection
              }
        }
        onFindTopK={() => {
          try {
            const id = toolbar.object?.id;
            if (id != null) {
              setPopoverCmd({ type: ANALYSIS_SINGLE, q: id });
              // Convert internal viewer coordinates to global viewport coordinates
              // so the popover can span across the two viewers.
              const container = containerRef.current;
              const rect = container?.getBoundingClientRect
                ? container.getBoundingClientRect()
                : { left: 0, top: 0 };
              const gx = (rect.left || 0) + toolbar.x;
              const gy = (rect.top || 0) + toolbar.y;
              setPopoverPos({ x: gx, y: gy });
              const r = 60;
              setPopoverBounds({
                x0: gx - r,
                y0: gy - r,
                x1: gx + r,
                y1: gy + r,
              });
              setPopoverOpen(true);
            }
          } finally {
            setToolbar((t) => ({ ...t, show: false }));
          }
        }}
      />
      {/* Analysis popover (floating window near selection) */}
      <AnalysisPopover
        open={popoverOpen}
        command={popoverCmd}
        x={popoverPos.x}
        y={popoverPos.y}
        selectionBounds={popoverBounds}
        onClose={() => {
          setPopoverOpen(false);
          setPopoverBounds(null);
        }}
        meta={meta}
        chunkUV={chunkUV}
        atlasURL={atlasURL}
        atlasByChannel={atlasByChannel}
        channels={channels}
        colors={colors}
        alphas={alphas}
        windows={windows}
        pointsRaw={points}
        pointsUMAP={points}
        useUMAP={false}
        viewerId={viewerId}
        selectedIds={selectedIds}
        setSelectedIds={setSelectedIds}
      />

      <AnnotationStatsPopover
        open={annotationStatsOpen}
        onClose={() => setAnnotationStatsOpen(false)}
        selectedIds={selectedIds}
      />

      <HoverPreview
        deckRef={deckRef}
        containerRef={containerRef}
        iconMappingsByChunk={iconMappingsByChunk}
        chunkUV={chunkUV}
        atlasByChannel={atlasByChannel}
        channels={channels}
        colors={colors}
        alphas={alphas}
        windows={windows}
        computedImageSize={computedImageSize}
        hoverEnabled={selectionMode === SELECTION_NONE}
        selectedIds={selectedIds}
        cellTypeAnnotationOn={cellTypeAnnotationOn}
        neighNamesAnnotationOn={neighNamesAnnotationOn}
        rawAnnotationById={rawAnnotationById}
        filteredIds={filteredIds}
      />

      {/* Persistent selection outlines (slightly thinner than hover outline). */}
      {selectedTileScreens &&
        selectedTileScreens.length > 0 &&
        selectedTileScreens.map(({ id, x, y, color }) => {
          // Match the actual tile size; do not enlarge on selection
          const size = Math.max(6, computedImageSize);
          let borderColor = "rgba(255, 255, 255, 0.9)";
          if (Array.isArray(color) && color.length >= 3) {
            const [r, g, b, a] = color;
            const alpha =
              typeof a === "number" && a >= 0 && a <= 255 ? a / 255 : 0.95;
            borderColor = `rgba(${r},${g},${b},${alpha})`;
          }
          return (
            <div
              key={`selected-outline-${id}`}
              className="selected-tile-outline"
              style={{
                left: x - size / 2,
                top: y - size / 2,
                width: size,
                height: size,
                borderColor,
              }}
            />
          );
        })}

      {/* Semantic Zoom Slider (Manual Control) */}
      {isUMAPView && (
        <SemanticZoomControl
          level={semanticLevel}
          setLevel={setSemanticLevel}
          maxLevel={6}
          isAuto={isSemanticAuto}
          setIsAuto={setIsSemanticAuto}
        />
      )}
      </>
      )}
    </div>
  );
};

export default Viewer;
