// Main deck view: lasso/box selection, overlays, 2D/3D.
import React, { useMemo, useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import DeckGL from "@deck.gl/react";
import AnalysisPopover from "../AnalysisPopover/AnalysisPopover";
import SelectionOverlay from "../SelectionOverlay/SelectionOverlay";
import {
  defaultRegionColors,
  makeRegionIndexGetter,
} from "../SelectionOverlay/selectionUtils";
import { ANALYSIS_SINGLE } from "../constants/analysis";
import { SELECTION_NONE} from "../constants/selection";
import {
  cellFocusZoomForView,
  OME_AUTO_FIT_ZOOM_SUB,
  OME_SPATIAL_IMAGE_SIZE_FIXED,
} from "../constants/render";
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
  passesDisplaySampling,
  getSelectionOwner,
  isSelectionOwnerSpatial,
  isSelectionOwnerUmap,
  resolveTileOutlineSize,
  resolveZarrLogicalChannels,
} from "../utils/utils";
import { buildOutlineData2D, clusterColor } from "../utils/clustering";
import "./Viewer.css";
import ClickToolbar from "../ToolBar/ClickToolbar/ClickToolbar";
import GroupToolbarContainer from "../ToolBar/GroupToolbar/GroupToolbarContainer";
import ClusterHoverMask from "../ClusterHoverMask/ClusterHoverMask";
import DeckViewState from "./DeckViewState";
import ImageLayers from "../layers/ImageLayers";
import { MultiscaleImageLayer } from "@hms-dbmi/viv";
import {
  openOmeTiffAsPixelSources,
  openOmeTiffFromFile,
  buildMultiscaleImageLayerProps,
  MAX_CHANNELS,
} from "../ome/omeVivLoader";
import ClusterOutlines from "../ClusterHoverMask/ClusterOutlines";
import useClusterSelection from "./useClusterSelection";
import useClusterAnnotations from "./useClusterAnnotations";
import SemanticZoomControl from "./SemanticZoomControl/SemanticZoomControl";
import HoverPreview from "./HoverPreview/HoverPreview";
import ClusterPreviewThumb from "./ClusterPreviewThumb/ClusterPreviewThumb";
import ClusterAnnotationOverlay from "./ClusterAnnotationOverlay/ClusterAnnotationOverlay";
import SimilarityRankingOverlay from "./SimilarityRankingOverlay/SimilarityRankingOverlay";
import useGlobalCellFocusAndRanking from "./useGlobalCellFocusAndRanking";
import useCoreMetadataLayer from "./useCoreMetadataLayer";
import AnnotationStatsPopover from "../AnnotationStatsPopover/AnnotationStatsPopover";
import CoreMetadataOverlay from "./CoreMetadataOverlay/CoreMetadataOverlay";

const Viewer = ({
  viewerId = "viewer",
  meta,
  points,
  pointsRawPick = null,
  pointsUMAPPick = null,
  displayCoordById = null,
  chunkUV,
  hoverMaskEnabled = false,
  atlasURL,
  atlasByChannel,
  channels = [],
  colors = {},
  alphas = {},
  // Per-channel window in raw units (~0..65535)
  windows = {},
  renderMode = "sprites",
  is3D = false,
  imageSize = 4,
  rawImageSize,
  setImageSize = () => {},
  // Single view: UMAP vs raw
  useUMAP = false,

  // Selection
  selectionMode = "none",
  setSelectionMode = () => {},
  selectedIds = new Set(),
  setSelectedIds = () => {},
  selectedRegions = [],
  setSelectedRegions = () => {},
  clearSelection = () => {},
  filteredIds = new Set(),
  highlightedClusters = new Set(),
  resolveClusterIds = null,
  ensureLabelColumn = () => Promise.resolve([]),
  getLabelForId = null,
  // Clustering overlay
  clusterColorOn = false,
  clusterOpacity = 0.25,
  clusterLineWidth = 1,
  clusterOutlineOn = false,
  // LLM cluster titles/descriptions
  clusterAnnotationOn = false,
  clusterAnnotationModel = "MedGemma",
  // UMAP: per-cluster preview thumb
  clusterPreviewOn = true,
  // Raw columns celltype / neigh_names when present
  cellTypeAnnotationOn = false,
  neighNamesAnnotationOn = false,
  rawAnnotationColumns = { celltype: false, neigh_names: false },
  // CORE_ID metadata labels (OME spatial only)
  coreMetadataActive = false,
  coreMetadataSelectedFields = [],
  coreMetadataRows = [],
  // Optional synced zoom across viewers
  sharedZoom,
  setSharedZoom,
  // Scroll zoom strength
  zoomSpeed = 0.01,
  // Camera/point transition animations
  transitionsEnabled = true,
  /** When set, raw / spatial view uses Viv multiscale OME-TIFF instead of Zarr tile atlases */
  omeTiffUrl = null,
  /** Local OME-TIFF file (browser) — takes precedence over omeTiffUrl */
  omeTiffFile = null,
  /** channel_id → OME 0-based c (from channel_info.json). */
  channelOmeIndexById = {},
  /** channel_id → Zarr 0-based c; missing = OME-only. */
  channelZarrIndexById = {},
}) => {
  const isUMAPView =
    viewerId === "umap" || (viewerId === "single" && !!useUMAP);
  const rawUsesOmeTiff = Boolean(omeTiffUrl || omeTiffFile) && !isUMAPView;

  const zarrChannels = useMemo(
    () => resolveZarrLogicalChannels(channels, channelZarrIndexById),
    [channels, channelZarrIndexById],
  );

  const hasActiveChannels = useMemo(
    () => {
      if (!Array.isArray(channels) || channels.length === 0) return false;
      if (isUMAPView) {
        return zarrChannels.length > 0;
      }
      if (rawUsesOmeTiff) return true;
      return zarrChannels.length > 0;
    },
    [channels, isUMAPView, rawUsesOmeTiff, zarrChannels],
  );
  // Raw space is always 2D; only UMAP respects the global 3D toggle.
  const viewIs3D = isUMAPView && is3D;
  // UMAP: same Image size slider as dual view. OME spatial: fixed as OME_SPATIAL_IMAGE_SIZE_FIXED (~0.3), not slider-driven.
  const UMAP_SLIDER_MIN = 0.3;
  const UMAP_SLIDER_MAX = 6;
  const markerViewportScale = 1;
  const umapMatchedMarkerSize = Math.max(
    UMAP_SLIDER_MIN,
    Math.min(UMAP_SLIDER_MAX, imageSize * markerViewportScale),
  );
  const omeSpatialFixedMarkerSize = Math.max(
    UMAP_SLIDER_MIN,
    Math.min(
      UMAP_SLIDER_MAX,
      OME_SPATIAL_IMAGE_SIZE_FIXED * markerViewportScale,
    ),
  );
  const effectiveImageSize = isUMAPView
    ? umapMatchedMarkerSize
    : rawUsesOmeTiff
      ? omeSpatialFixedMarkerSize
      : (rawImageSize ?? imageSize);
  // Spatial+OME: points on Viv; UMAP: sprites (decoupled from global points/sprites toggle).
  const effectiveRenderMode = rawUsesOmeTiff
    ? "points"
    : isUMAPView
      ? "sprites"
      : renderMode;

  /** Single-view Spatial↔UMAP: id so Deck camera re-centers on coordinate change. */
  const cameraSpaceId =
    viewerId === "single"
      ? isUMAPView
        ? "single-umap"
        : rawUsesOmeTiff
          ? "single-spatial-ome"
          : "single-spatial"
      : viewerId;

  const [omeTiffSource, setOmeTiffSource] = useState(null);
  const [omeTiffLoadError, setOmeTiffLoadError] = useState(null);
  const omeFittedRef = useRef(false);
  /** Bump after OME fit so marker size zoom baseline matches post-fit camera. */
  const [omeMarkerZoomBaselineSeq, setOmeMarkerZoomBaselineSeq] = useState(0);

  useEffect(() => {
    omeFittedRef.current = false;
    setOmeMarkerZoomBaselineSeq(0);
  }, [omeTiffUrl, omeTiffFile, rawUsesOmeTiff]);

  useEffect(() => {
    let cancelled = false;
    if (!rawUsesOmeTiff || (!omeTiffFile && !omeTiffUrl)) {
      setOmeTiffSource(null);
      setOmeTiffLoadError(null);
      return undefined;
    }
    (async () => {
      try {
        const src = omeTiffFile
          ? await openOmeTiffFromFile(omeTiffFile)
          : await openOmeTiffAsPixelSources(omeTiffUrl);
        if (!cancelled) {
          setOmeTiffSource(src);
          setOmeTiffLoadError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setOmeTiffSource(null);
          setOmeTiffLoadError(e?.message || String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawUsesOmeTiff, omeTiffFile, omeTiffUrl]);

  const omePixelYFlip =
    rawUsesOmeTiff &&
    omeTiffSource?.imageHeight != null &&
    Number.isFinite(omeTiffSource.imageHeight)
      ? omeTiffSource.imageHeight
      : null;

  const rawToWorld = useCallback(
    (p) => {
      const z = p.z ?? 0;
      if (omePixelYFlip == null) return [p.x, p.y, z];
      return [p.x, omePixelYFlip - p.y, z];
    },
    [omePixelYFlip],
  );

  const {
    viewState,
    setViewState,
    handleViewStateChange,
    computedImageSize,
    altPressed,
    autoRotate,
  } = DeckViewState({
    points,
    is3D: viewIs3D,
    sharedZoom,
    setSharedZoom,
    initialZoom: isUMAPView && viewerId === "single" ? 9 : 8,
    imageSize: effectiveImageSize,
    transitionsEnabled,
    pixelYFlipHeight: omePixelYFlip,
    cameraSpaceId,
    markerZoomBaselineSeq:
      rawUsesOmeTiff && omeMarkerZoomBaselineSeq > 0
        ? omeMarkerZoomBaselineSeq
        : undefined,
  });

  const prevCameraSpaceIdRef = useRef(null);
  useEffect(() => {
    const prev = prevCameraSpaceIdRef.current;
    prevCameraSpaceIdRef.current = cameraSpaceId;
    if (cameraSpaceId !== "single-umap") return;
    if (prev === "single-spatial" || prev === "single-spatial-ome") {
      setViewState((p) => ({
        ...p,
        zoom: 9,
        transitionDuration: 0,
      }));
    }
  }, [cameraSpaceId, setViewState]);

  const [semanticLevel, setSemanticLevel] = useState(6); // 1..6, finest default
  const [isSemanticAuto, setIsSemanticAuto] = useState(false);
  // UMAP: cluster_L*; raw: label
  const clusterLabelKey = isUMAPView
    ? `cluster_L${semanticLevel - 1}`
    : "label";
  // UMAP: rank_L* for rep cell per level
  const clusterRankKey = isUMAPView
    ? `rank_L${semanticLevel - 1}`
    : null;

  // UMAP + auto: map zoom → semantic level (debounced + hysteresis to avoid transition thrash while scrolling).
  const zoomForSemanticRef = useRef(viewState?.zoom ?? 8);
  zoomForSemanticRef.current =
    typeof viewState?.zoom === "number" ? viewState.zoom : 8;
  const semanticZoomTimerRef = useRef(null);

  useEffect(() => {
    if (!isUMAPView || !isSemanticAuto) return undefined;

    const applyLevelFromZoom = () => {
      const z = zoomForSemanticRef.current;
      setSemanticLevel((prev) => {
        const h = 0.15;
        let target = 6;
        if (z < 6) target = 1;
        else if (z < 7) target = 2;
        else if (z < 8) target = 3;
        else if (z < 9) target = 4;
        else if (z < 10) target = 5;
        if (target === prev) return prev;
        const boundaries = [6, 7, 8, 9, 10];
        if (target > prev) {
          const boundary = boundaries[prev - 1];
          if (z < boundary + h) return prev;
        } else if (target < prev) {
          const boundary = boundaries[target - 1];
          if (z >= boundary - h) return prev;
        }
        return target;
      });
    };

    if (semanticZoomTimerRef.current) {
      clearTimeout(semanticZoomTimerRef.current);
    }
    semanticZoomTimerRef.current = setTimeout(applyLevelFromZoom, 250);

    return () => {
      if (semanticZoomTimerRef.current) {
        clearTimeout(semanticZoomTimerRef.current);
      }
    };
  }, [isUMAPView, isSemanticAuto, viewState?.zoom]);

  // Max visible points per level (5k..80k linear, step 15k).
  const SAMPLING_BUDGETS = useMemo(
    () => [5000, 20000, 35000, 50000, 65000, 80000],
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

  // UMAP display always respects sampling; full selectedIds still used for spatial cross-view.
  const visiblePoints = useMemo(() => {
    if (!points || points.length === 0) return [];
    if (samplingThreshold >= 1.0) return points;

    return points.filter((p) => passesDisplaySampling(p.id, samplingThreshold));
  }, [points, samplingThreshold]);
  const selectablePoints = useMemo(
    () => (hasActiveChannels ? visiblePoints : []),
    [hasActiveChannels, visiblePoints],
  );

  const umapGeometricSelectionPoints = useMemo(() => {
    if (!isUMAPView) return selectablePoints;
    if (pointsUMAPPick?.length) return pointsUMAPPick;
    return points;
  }, [isUMAPView, pointsUMAPPick, points, selectablePoints]);

  const iconMappingsByChunk = useMemo(
    () => buildIconMappingsByChunk(meta, chunkUV),
    [meta, chunkUV]
  );

  const tilePx = meta?.atlas?.tile ?? 16;

  const tileOutlineSize = useMemo(
    () =>
      resolveTileOutlineSize({
        computedImageSize,
        zoom: viewState?.zoom,
        tilePx,
        rawUsesOmeTiff,
        clusterColorOn,
        renderMode: effectiveRenderMode,
      }),
    [
      computedImageSize,
      viewState?.zoom,
      tilePx,
      rawUsesOmeTiff,
      clusterColorOn,
      effectiveRenderMode,
    ],
  );

  const omeDeckLayer = useMemo(() => {
    if (!rawUsesOmeTiff || !omeTiffSource) return null;
    const chList = (Array.isArray(channels) ? channels : [])
      .map((c) => Number(c))
      .filter((id) => Number.isFinite(id))
      .slice(0, MAX_CHANNELS);
    if (chList.length === 0) return null;
    const map = channelOmeIndexById && typeof channelOmeIndexById === "object" ? channelOmeIndexById : {};
    const props = buildMultiscaleImageLayerProps(omeTiffSource, {
      channels: chList,
      colors,
      windows,
      alphas,
      channelOmeIndexById: map,
    });
    if (!props) return null;
    return new MultiscaleImageLayer({ ...props, pickable: false });
  }, [rawUsesOmeTiff, omeTiffSource, channels, colors, windows, alphas, channelOmeIndexById]);

  const { selectClusterByLabel, selectSingleById } = useClusterSelection({
    points: visiblePoints,
    filteredIds,
    selectedRegions,
    setSelectedRegions,
    setSelectedIds,
    viewerId,
    labelKey: clusterLabelKey,
    resolveClusterIds: (label) =>
      typeof resolveClusterIds === "function"
        ? resolveClusterIds(label, clusterLabelKey)
        : null,
  });

  // Screen-space selection
  const deckRef = useRef(null);
  const containerRef = useRef(null);
  // Defer DeckGL until layout + rAF×2 + 80ms so WebGL limits exist (avoids maxTextureDimension2D errors).
  const [containerReady, setContainerReady] = useState(false);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const readyTimeoutRef = useRef(null);
  const readyOnceRef = useRef(false);
  const containerReadyRef = useRef(false);
  const lastDeckSizeRef = useRef({ width: 0, height: 0 });
  containerReadyRef.current = containerReady;

  const syncDeckToContainer = useCallback(() => {
    const el = containerRef.current;
    const deck = deckRef.current?.deck;
    if (!el || !deck) return;
    const w = Math.round(el.clientWidth);
    const h = Math.round(el.clientHeight);
    if (w <= 0 || h <= 0) return;
    const prev = lastDeckSizeRef.current;
    if (prev.width === w && prev.height === h) return;
    lastDeckSizeRef.current = { width: w, height: h };
    deck.setProps({ width: w, height: h });
    deck.redraw(true);
  }, []);

  const scheduleLayoutEpoch = useCallback(() => {
    setLayoutEpoch((n) => n + 1);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onResize = () => {
      if (containerReadyRef.current) {
        syncDeckToContainer();
        scheduleLayoutEpoch();
      }
      if (readyOnceRef.current) return;
      if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          readyTimeoutRef.current = setTimeout(() => {
            readyOnceRef.current = true;
            setContainerReady(true);
          }, 80);
        });
      });
    };

    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    onResize();
    return () => {
      ro.disconnect();
      if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current);
    };
  }, [syncDeckToContainer, scheduleLayoutEpoch]);

  useLayoutEffect(() => {
    if (!containerReady) return;
    syncDeckToContainer();
  }, [containerReady, syncDeckToContainer]);

  useEffect(() => {
    if (!rawUsesOmeTiff || !omeTiffSource || !containerReady) return;
    if (omeFittedRef.current) return;
    const el = containerRef.current;
    if (!el || el.clientWidth < 24 || el.clientHeight < 24) return;
    const { imageWidth, imageHeight } = omeTiffSource;
    let minX = 0;
    let minY = 0;
    let maxX = imageWidth;
    let maxY = imageHeight;
    if (points?.length) {
      for (const p of points) {
        const [wx, wy] = rawToWorld(p);
        if (typeof wx === "number") {
          minX = Math.min(minX, wx);
          maxX = Math.max(maxX, wx);
        }
        if (typeof wy === "number") {
          minY = Math.min(minY, wy);
          maxY = Math.max(maxY, wy);
        }
      }
    }
    const pad = 48;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const z0 = Math.log2(
      Math.min((vw - 2 * pad) / spanX, (vh - 2 * pad) / spanY),
    );
    const z = z0 - OME_AUTO_FIT_ZOOM_SUB;
    setViewState((prev) => ({
      ...prev,
      target: [(minX + maxX) / 2, (minY + maxY) / 2, 0],
      zoom: z,
      transitionDuration: 0,
    }));
    setOmeMarkerZoomBaselineSeq((n) => n + 1);
    omeFittedRef.current = true;
  }, [rawUsesOmeTiff, omeTiffSource, points, containerReady, setViewState, rawToWorld]);

  const [toolbar, setToolbar] = useState({ show: false, x: 0, y: 0, object: null });
  // Analysis popover
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverCmd, setPopoverCmd] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverBounds, setPopoverBounds] = useState(null);
  const [annotationStatsOpen, setAnnotationStatsOpen] = useState(false);
  // Zoom-to-selection vs default center+zoom 8
  const [isZoomedToSelection, setIsZoomedToSelection] = useState(false);
  // cell id → rank (0 = query)
  const [similarityRankings, setSimilarityRankings] = useState(new Map());
  // Up to 2 region highlight colors
  const regionColors = defaultRegionColors;
  const getRegionIndexForId = useMemo(
    () => makeRegionIndexGetter(selectedRegions),
    [selectedRegions]
  );

  // Clear similarity ranks here + paired Raw/UMAP via window helpers.
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

  // Fit camera to selection bbox
  const zoomToSelection = useCallback(() => {
    if (!selectedIds?.size) return;
    const pool =
      !isUMAPView && pointsRawPick?.length ? pointsRawPick : points;
    if (!pool?.length) return;
    const selected = pool.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of selected) {
      const [x, y, z] = rawToWorld(p);
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
  }, [points, pointsRawPick, isUMAPView, selectedIds, setViewState, transitionsEnabled, rawToWorld]);

  // Back to data center + zoom 8
  const initialTarget = useMemo(() => {
    if (
      omePixelYFlip != null &&
      Number.isFinite(omePixelYFlip) &&
      (points?.length ?? 0) > 0
    ) {
      const h = omePixelYFlip;
      return computeCenter(points.map((p) => ({ ...p, y: h - (p.y ?? 0) })));
    }
    return computeCenter(points || []);
  }, [points, omePixelYFlip]);
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
    // Box/lasso mode: no click pick/clear
    if (selectionMode !== SELECTION_NONE) {
      return;
    }

    // With selection: clicks don't change it (clear via toolbar X).
    if (selectedIds && selectedIds.size > 0) {
      return;
    }
    if (!info?.object) {
      if (toolbar.show) setToolbar({ show: false, x: 0, y: 0, object: null });
      setPopoverOpen(false);
      setPopoverBounds(null);
      clearAllSimilarityRankings();
      return;
    }
    if (altPressed) {
      const val = info?.object?.[clusterLabelKey];
      const lbl = Number.isFinite(val) ? val : info?.object?.label;
      ensureLabelColumn(clusterLabelKey).then((labels) => {
        let override = null;
        if (Array.isArray(labels) && labels.length && lbl != null) {
          override = new Set();
          for (let id = 0; id < labels.length; id++) {
            if (labels[id] === lbl) override.add(id);
          }
        }
        selectClusterByLabel(lbl, override);
      });
      return;
    }

    selectSingleById(info?.object?.id);
    // Toolbar for single-cell actions
    const { x, y } = getEventCoordinates(info, containerRef);
    setToolbar({ show: true, x, y, object: info.object });

    // If zoomed out, focus clicked cell
    const currentZoom = typeof viewState?.zoom === "number" ? viewState.zoom : 8;
    const zoomThreshold = 9;
    if (currentZoom < zoomThreshold && info?.object) {
      const [cellX, cellY, cellZ] = rawToWorld(info.object);
      const cellFocusZoom = cellFocusZoomForView({
        isUMAPView,
        rawUsesOmeTiff,
      });

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
    }
  };

  // 2D cluster hull outlines
  const outlineData = useMemo(() => {
    if (viewIs3D || !visiblePoints || visiblePoints.length < 3) return [];
    return buildOutlineData2D(visiblePoints, clusterLabelKey);
  }, [viewIs3D, visiblePoints, clusterLabelKey]);

  const screenOutlines = ClusterOutlines({
    is3D: viewIs3D,
    clusterOutlineOn,
    forceCompute: clusterAnnotationOn,
    points: visiblePoints,
    filteredIds,
    deckRef,
    viewDeps: [
      viewState.zoom,
      viewState.rotationX,
      viewState.rotationOrbit,
      viewState.target,
      layoutEpoch,
    ],
    labelKey: clusterLabelKey,
  });

  // One rep point per cluster (min rank_L*) for preview cards
  const clusterPreviewPoints = useMemo(() => {
    if (!isUMAPView) return [];
    if (!clusterPreviewOn) return [];
    if (!points || points.length === 0) return [];
    // Previews for semantic levels 1–5 only
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

  // Rep cells → screen for DOM thumbs
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
      getWorldPosition: (p) => rawToWorld(p),
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
  }, [isUMAPView, clusterPreviewOn, clusterPreviewPoints, viewState, deckRef, containerRef, rawToWorld]);

  // Cluster title DOM positions
  const [clusterAnnotationScreens, setClusterAnnotationScreens] = useState([]);

  const [hoveredAnnotationLabel, setHoveredAnnotationLabel] = useState(null);
  const descriptionRefs = useRef({});

  // raw.json → per-id celltype/neigh_names when toggles on
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

  // Filter on: mode celltype/neigh per cluster per level
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

  // LLM annotation props from 2D hulls or 3D screen outlines
  const { annotationLayer, clusterAnnotationData } = useClusterAnnotations({
    clusterAnnotationOn,
    clusterAnnotationModel,
    outlineData,
    viewState,
    is3D: viewIs3D,
    screenOutlines3D: screenOutlines,
    level: semanticLevel,
    filteredDominantAnnotations,
    pixelYFlipHeight: omePixelYFlip,
  });

  // Titles via DOM, not Deck TextLayer
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
      // position already in Deck world space (incl. OME y-flip) from useClusterAnnotations
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

  // Per-cell labels when zoom ≥ threshold
  const ZOOM_THRESHOLD_CELL_ANNOTATION = 11;
  const MAX_CELL_ANNOTATIONS_VISIBLE = 400;
  const ANNOTATION_GRID_SIZE = 16; // grid cap for label spread
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
      getWorldPosition: (p) => rawToWorld(p),
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
    // Over cap: sample by viewport grid
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
    layoutEpoch,
    rawToWorld,
  ]);

  // Similarity rank label positions
  const [similarityRankingScreens, setSimilarityRankingScreens] = useState([]);

  // window.__focusCell* + similarity for cross-viewer APIs
  useGlobalCellFocusAndRanking({
    viewerId,
    useUMAP,
    points,
    setViewState,
    transitionsEnabled,
    setSimilarityRankings,
    mapWorldPosition: rawToWorld,
    rawUsesOmeTiff,
  });

  // Selected tile outline DOM positions
  const [selectedTileScreens, setSelectedTileScreens] = useState([]);

  useEffect(() => {
    if (!selectedIds || selectedIds.size === 0 || !visiblePoints || visiblePoints.length === 0) {
      setSelectedTileScreens([]);
      return;
    }
    let selectedPointsForOutline = visiblePoints.filter((p) => selectedIds.has(p.id));
    if (!isUMAPView && pointsRawPick?.length) {
      const seen = new Set(selectedPointsForOutline.map((p) => p.id));
      for (const p of pointsRawPick) {
        if (selectedIds.has(p.id) && !seen.has(p.id)) {
          selectedPointsForOutline.push(p);
          seen.add(p.id);
        }
      }
    }
    if (selectedPointsForOutline.length === 0) {
      setSelectedTileScreens([]);
      return;
    }

    const result = projectItemsToScreen({
      deckRef,
      containerRef,
      items: selectedPointsForOutline,
      getWorldPosition: (p) => rawToWorld(p),
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
  }, [
    selectedIds,
    visiblePoints,
    viewState,
    deckRef,
    containerRef,
    getRegionIndexForId,
    regionColors,
    rawToWorld,
    isUMAPView,
    pointsRawPick,
  ]);

  useEffect(() => {
    if (!similarityRankings || similarityRankings.size === 0) {
      setSimilarityRankingScreens([]);
      return;
    }
    const rankedPoints = points.filter((p) => similarityRankings.has(p.id));
    if (rankedPoints.length === 0) {
      setSimilarityRankingScreens([]);
      return;
    }

    const result = projectItemsToScreen({
      deckRef,
      containerRef,
      items: rankedPoints,
      getWorldPosition: (p) => rawToWorld(p),
      mapResult: (p, sx, sy, offsetX, offsetY) => ({
        id: p.id,
        x: sx + offsetX,
        y: sy + offsetY,
        rank: similarityRankings.get(p.id),
      }),
    });
    if (result.length === 0) return;
    setSimilarityRankingScreens(result);
  }, [
    similarityRankings,
    points,
    viewState,
    deckRef,
    containerRef,
    layoutEpoch,
    rawToWorld,
  ]);

  const hoverPickAll =
    !isUMAPView &&
    effectiveRenderMode === "sprites" &&
    !rawUsesOmeTiff &&
    hasActiveChannels;
  const effectivePickPoints =
    hoverPickAll && pointsRawPick?.length ? pointsRawPick : points;

  // UMAP multi-cell region select → spatial shows only selected; single-cell pick keeps full context.
  const spatialVisualPoints = useMemo(() => {
    if (isUMAPView || !selectedIds?.size) return points;
    const owner = getSelectionOwner();
    if (!isSelectionOwnerUmap(owner)) return points;
    if (selectedIds.size <= 1) return points;
    const inDisplay = points.filter((p) => selectedIds.has(p.id));
    return inDisplay.length > 0 ? inDisplay : points;
  }, [isUMAPView, points, selectedIds]);

  const umapVisualPoints = useMemo(() => {
    if (!isUMAPView) return points;
    return visiblePoints;
  }, [isUMAPView, points, visiblePoints]);

  // UMAP never bypasses GPU sampling (selected cells included only if they pass hash budget).
  const selectedBypassSampling = !isUMAPView;

  const imageLayerPoints = isUMAPView ? umapVisualPoints : spatialVisualPoints;

  const clusterHighlightPoints = useMemo(() => {
    if (!highlightedClusters?.size) return imageLayerPoints;
    if (isUMAPView || !pointsRawPick?.length) return imageLayerPoints;
    const seen = new Set(imageLayerPoints.map((p) => p.id));
    const merged = [...imageLayerPoints];
    for (const p of pointsRawPick) {
      if (seen.has(p.id)) continue;
      const lbl =
        (typeof getLabelForId === "function" ? getLabelForId(p.id, "label") : null) ??
        p?.label;
      if (Number.isFinite(lbl) && highlightedClusters.has(lbl)) {
        merged.push(p);
        seen.add(p.id);
      }
    }
    return merged;
  }, [
    imageLayerPoints,
    isUMAPView,
    highlightedClusters,
    pointsRawPick,
    getLabelForId,
  ]);

  const imageLayers = ImageLayers({
    meta,
    renderMode: effectiveRenderMode,
    points: imageLayerPoints,
    pickPoints: effectivePickPoints,
    hoverPickAll,
    atlasURL,
    atlasByChannel,
    iconMappingsByChunk,
    channels: zarrChannels,
    colors,
    alphas,
    windows,
    is3D: viewIs3D,
    filteredIds,
    highlightedClusters,
    clusterColorOn,
    clusterOpacity,
    clusterLineWidth,
    clusterOutlineOn,
    outlineData,
    computedImageSize,
    getRegionIndexForId,
    regionColors,
    labelKey: clusterLabelKey,
    clusterHighlightLabelKey: "label",
    getLabelForId,
    clusterHighlightPoints,
    markerZoom: viewState?.zoom ?? 0,
    tilePx,
    rawUsesOmeTiff,
    semanticLevel,
    samplingThreshold,
    selectedIds,
    selectedBypassSampling,
    transitionsEnabled: transitionsEnabled && !isUMAPView,
    dotOutlineForBrightBackground: rawUsesOmeTiff,
    suppressSpriteAtlases: rawUsesOmeTiff,
    hasRenderableChannels: hasActiveChannels,
    pixelYFlipHeight: omePixelYFlip,
    omeSpatialScatterPickOnly: rawUsesOmeTiff && !clusterColorOn,
  });

  const showCoreMetadata =
    !isUMAPView &&
    coreMetadataActive &&
    rawUsesOmeTiff &&
    Number.isFinite(omeTiffSource?.imageWidth) &&
    Number.isFinite(omeTiffSource?.imageHeight);

  const { layer: coreMetadataLayer, worldItems: coreMetadataWorldItems } =
    useCoreMetadataLayer({
      enabled: showCoreMetadata,
      viewerId,
      rows: coreMetadataRows,
      selectedFields: coreMetadataSelectedFields,
      imageWidth: omeTiffSource?.imageWidth,
      imageHeight: omeTiffSource?.imageHeight,
      pixelYFlipHeight: omePixelYFlip,
      viewState,
    });

  const [coreMetadataScreens, setCoreMetadataScreens] = useState([]);
  const updateCoreMetadataScreens = useCallback(() => {
    if (!showCoreMetadata || !coreMetadataWorldItems.length) {
      setCoreMetadataScreens([]);
      return;
    }
    const result = projectItemsToScreen({
      deckRef,
      containerRef,
      items: coreMetadataWorldItems,
      getWorldPosition: (d) => d.position,
      mapResult: (d, sx, sy, offsetX, offsetY) => ({
        id: d.id,
        lines: d.lines,
        x: sx + offsetX,
        y: sy + offsetY,
      }),
    });
    if (result.length > 0) setCoreMetadataScreens(result);
  }, [showCoreMetadata, coreMetadataWorldItems, deckRef, containerRef]);

  useEffect(() => {
    updateCoreMetadataScreens();
  }, [
    updateCoreMetadataScreens,
    viewState,
    layoutEpoch,
    containerReady,
    omeTiffSource,
  ]);

  const layers = [
    ...(omeDeckLayer ? [omeDeckLayer] : []),
    ...imageLayers,
    ...(showCoreMetadata && coreMetadataLayer ? [coreMetadataLayer] : []),
  ].filter(Boolean);

  const controller =
    selectionMode === SELECTION_NONE
      ? viewIs3D
        ? { 
            type: OrbitController,
            scrollZoom: true,
            doubleClickZoom: true,
            inertia: true,
            inertiaFriction: 0.95,
            inertiaDeceleration: 0.95,
            scrollZoomSpeed: zoomSpeed,
            smoothZoom: true,
            smoothZoomDuration: 200
          }
        : {
            type: OrthographicController,
            scrollZoom: true,
            doubleClickZoom: true,
            inertia: true,
            inertiaFriction: 0.95,
            inertiaDeceleration: 0.95,
            scrollZoomSpeed: zoomSpeed,
            // UMAP: instant zoom — smoothZoom + semantic resampling caused continuous sprite transitions.
            smoothZoom: !isUMAPView,
            smoothZoomDuration: isUMAPView ? 0 : 200,
          }
      : false;

  return (
    <div className="viewer-root" ref={containerRef}>
      {rawUsesOmeTiff && omeTiffLoadError && (
        <div
          style={{
            position: "absolute",
            zIndex: 20,
            left: 8,
            top: 8,
            maxWidth: "min(420px, 90%)",
            padding: "8px 10px",
            background: "rgba(40,0,0,0.85)",
            color: "#fff",
            fontSize: 12,
            borderRadius: 6,
          }}
          role="alert"
        >
          OME-TIFF failed to load: {omeTiffLoadError}
        </div>
      )}
      {!containerReady ? (
        <div style={{ width: "100%", height: "100%" }} aria-hidden="true" />
      ) : (
      <>
      <SelectionOverlay
        containerRef={containerRef}
        deckRef={deckRef}
        viewerId={viewerId}
        selectionMode={selectionMode}
        points={selectablePoints}
        selectionPoints={umapGeometricSelectionPoints}
        useGeometricSelection={isUMAPView}
        getWorldPositionForSelection={rawToWorld}
        filteredIds={filteredIds}
        selectedRegions={selectedRegions}
        setSelectedRegions={setSelectedRegions}
        setSelectedIds={setSelectedIds}
        setSelectionMode={setSelectionMode}
        onBeginSelection={() => {
          if (toolbar.show) setToolbar({ show: false, x: 0, y: 0, object: null });
        }}
      >
        {({ onDragStart, onDrag, onDragEnd, isSelecting }) => (
          <>
            <ClusterHoverMask
              outlineData={outlineData}
              is3D={viewIs3D}
              deckRef={deckRef}
              containerRef={containerRef}
              active={hoverMaskEnabled && clusterOutlineOn}
              altPressed={altPressed}
              pixelYFlipHeight={omePixelYFlip}
              screenOutlines3D={screenOutlines}
            >
              {({ onHover, layers: hoverLayers }) => (
                <DeckGL
                  ref={deckRef}
                  views={
                    viewIs3D
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

            {/* 3D cluster outlines (SVG) */}
            {viewIs3D && clusterOutlineOn && screenOutlines.length > 0 && (
              <svg className="cluster-outline-svg">
                {screenOutlines.map((s, i) => (
                  <path key={i} d={s.d} fill="none" stroke={s.color} strokeWidth={clusterLineWidth} />
                ))}
              </svg>
            )}

            {/* Space: auto-rotate */}
            {viewIs3D && (
              <div className="viewer-3d-autorotate-hint" aria-hidden="true">
                Space: auto-rotate {autoRotate ? "On" : "Off"}
              </div>
            )}

            {/* Group toolbar */}
            <GroupToolbarContainer
              viewerId={viewerId}
              isSelecting={isSelecting}
              selectedIds={selectedIds}
              selectedRegions={selectedRegions}
              points={
                isUMAPView
                  ? visiblePoints
                  : pointsRawPick?.length
                    ? pointsRawPick
                    : visiblePoints
              }
              getWorldPosition={rawToWorld}
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

      {/* Cluster rep previews (L1–L5) */}
      {isUMAPView &&
        clusterPreviewOn &&
        semanticLevel >= 1 &&
        semanticLevel <= 5 &&
        clusterPreviewScreens &&
        clusterPreviewScreens.length > 0 &&
        clusterPreviewScreens.map(({ point, x, y }) => {
          if (!point) return null;
          // Fixed thumb size (avoid resize on zoom)
          const previewSize = 48;
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
              channels={zarrChannels}
              colors={colors}
              alphas={alphas}
              windows={windows}
            />
          );
        })}

      {/* Cluster titles DOM; description on hover */}
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

      {/* Similarity ranks */}
      {similarityRankingScreens && similarityRankingScreens.length > 0 && (
        <SimilarityRankingOverlay items={similarityRankingScreens} />
      )}

      {/* Per-cell labels (zoomed) */}
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

      {showCoreMetadata && coreMetadataScreens.length > 0 && (
        <CoreMetadataOverlay items={coreMetadataScreens} />
      )}

      {/* Cell toolbar */}
      <ClickToolbar
        show={toolbar.show}
        x={toolbar.x}
        y={toolbar.y}
        onClose={() => {
          setToolbar({ show: false, x: 0, y: 0, object: null });
          clearSelection();
          clearAllSimilarityRankings();
        }}
        // Single view: omit onViewRaw → eye disabled
        onViewRaw={
          viewerId === "single"
            ? undefined
            : () => {
                // Eye: focus same id in other projection
                const obj = toolbar.object;
                if (!obj || typeof window === "undefined") return;

                if (isUMAPView) {
                  if (typeof window.__focusCell === "function") {
                    window.__focusCell({ id: obj.id });
                  }
                } else {
                  if (typeof window.__focusCellUMAP === "function") {
                    window.__focusCellUMAP({ id: obj.id });
                  }
                }
                // Keep toolbar until X clears selection
              }
        }
        onFindTopK={() => {
          try {
            const id = toolbar.object?.id;
            if (id != null) {
              setPopoverCmd({ type: ANALYSIS_SINGLE, q: id });
              // Viewer-local → viewport for split popover
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
      {/* Analysis popover */}
      <AnalysisPopover
        open={popoverOpen}
        command={popoverCmd}
        x={popoverPos.x}
        y={popoverPos.y}
        selectionBounds={popoverBounds}
        onClose={() => {
          setPopoverOpen(false);
          setPopoverBounds(null);
          setPopoverCmd(null);
          clearAllSimilarityRankings();
        }}
        meta={meta}
        chunkUV={chunkUV}
        atlasURL={atlasURL}
        atlasByChannel={atlasByChannel}
        channels={channels}
        channelZarrIndexById={channelZarrIndexById}
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
        selectedRegions={selectedRegions}
      />

      <HoverPreview
        deckRef={deckRef}
        containerRef={containerRef}
        meta={meta}
        renderMode={effectiveRenderMode}
        suppressSpriteAtlases={rawUsesOmeTiff}
        iconMappingsByChunk={iconMappingsByChunk}
        chunkUV={chunkUV}
        atlasByChannel={atlasByChannel}
        atlasURL={atlasURL}
        channels={isUMAPView ? zarrChannels : channels}
        channelZarrIndexById={channelZarrIndexById}
        colors={colors}
        alphas={alphas}
        windows={windows}
        clusterColorOn={clusterColorOn}
        clusterOpacity={clusterOpacity}
        clusterLineWidth={clusterLineWidth}
        clusterOutlineOn={clusterOutlineOn}
        labelKey={clusterLabelKey}
        computedImageSize={computedImageSize}
        outlineSize={tileOutlineSize}
        rawUsesOmeTiff={rawUsesOmeTiff}
        tilePx={tilePx}
        hoverEnabled={selectionMode === SELECTION_NONE && hasActiveChannels}
        selectedIds={selectedIds}
        cellTypeAnnotationOn={cellTypeAnnotationOn}
        neighNamesAnnotationOn={neighNamesAnnotationOn}
        rawAnnotationById={rawAnnotationById}
        filteredIds={filteredIds}
        displayCoordById={displayCoordById}
        getWorldPosition={rawToWorld}
        pickRadius={rawUsesOmeTiff ? 14 : hoverPickAll ? 10 : 6}
        isUMAPView={isUMAPView}
      />

      {/* Selection outlines */}
      {selectedTileScreens &&
        selectedTileScreens.length > 0 &&
        selectedTileScreens.map(({ id, x, y, color }) => {
          const size = tileOutlineSize;
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

      {/* Semantic zoom slider */}
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
