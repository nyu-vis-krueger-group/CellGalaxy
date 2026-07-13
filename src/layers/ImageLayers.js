import { useMemo, useRef } from "react";
import { ScatterplotLayer, PathLayer, IconLayer } from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import WindowedIconLayer from "./WindowedIconLayer";
import { getClusterOutlineIconDescriptor } from "./clusterOutlineIcon";
import { clusterColor } from "../utils/clustering";
import {
  TONE_GAIN,
  windowFromChannel,
} from "../utils/intensityWindow";
import {
  ease,
  resolveMarkerPixelSize,
  semanticMarkerSizeFactor,
  pointToWorld,
  pathToWorld,
  displaySampleHash,
} from "../utils/utils";

/** Shared DataFilterExtension — one instance for sampling filters across layers. */
const SAMPLING_FILTER = new DataFilterExtension({ filterSize: 1 });

function clusterLabelForPoint(d, labelKey = "label", getLabelForId = null) {
  if (typeof getLabelForId === "function" && Number.isFinite(d?.id)) {
    const fromColumn = getLabelForId(d.id, labelKey);
    if (Number.isFinite(fromColumn)) return fromColumn;
  }
  const val = d?.[labelKey];
  if (Number.isFinite(val)) return val;
  const lbl = d?.label;
  return Number.isFinite(lbl) ? lbl : null;
}

function isClusterHighlighted(d, highlightedClusters, labelKey, getLabelForId) {
  if (!highlightedClusters || highlightedClusters.size === 0) return false;
  const lbl = clusterLabelForPoint(d, labelKey, getLabelForId);
  return Number.isFinite(lbl) && highlightedClusters.has(lbl);
}

const CLUSTER_OUTLINE_ICON = getClusterOutlineIconDescriptor();
/** Below this marker px size (2D), cluster highlight renders as a dot; at/above → square frame. */
const CLUSTER_SQUARE_OUTLINE_MIN_PX = 12;
/** 3D orbit: deck zoom reflects navigation better than computedImageSize alone. */
const CLUSTER_SQUARE_OUTLINE_MIN_ZOOM_3D = 9.5;

function samplingFilterValue(d, selectedIds, selectedBypassSampling) {
  if (selectedBypassSampling && selectedIds && selectedIds.has(d.id)) return 0;
  return displaySampleHash(d.id);
}

function markerSizeForOutline({
  computedImageSize,
  markerZoom,
  tilePx,
  rawUsesOmeTiff,
  clusterColorOn,
  renderMode,
  semanticLevel,
  semanticSizeOn,
}) {
  return resolveMarkerPixelSize({
    computedImageSize,
    zoom: markerZoom,
    tilePx,
    rawUsesOmeTiff,
    clusterColorOn,
    renderMode,
    semanticLevel,
    semanticSizeOn,
  });
}

function appendClusterHighlightOutlineLayers(
  target,
  {
    points,
    highlightedClusters,
    clusterHighlightLabelKey,
    getLabelForId,
    sizeStateRef,
    useSquareOutline,
    is3D,
    worldPos,
    samplingThreshold,
    selectedIds,
    selectedBypassSampling,
    filteredIds,
    pixelYFlipHeight,
  },
) {
  if (!highlightedClusters?.size || !points?.length) return;

  const highlightData = points.filter((d) =>
    isClusterHighlighted(d, highlightedClusters, clusterHighlightLabelKey, getLabelForId),
  );
  if (highlightData.length === 0) return;

  const readMarkerSize = () => markerSizeForOutline(sizeStateRef.current);

  const filterExt = {
    extensions: [SAMPLING_FILTER],
    getFilterValue: (d) =>
      samplingFilterValue(d, selectedIds, selectedBypassSampling),
    filterRange: [0, samplingThreshold],
  };

  const clusterHighlightColor = (d) => {
    const activeFilter = filteredIds && filteredIds.size > 0;
    if (activeFilter && !filteredIds.has(d.id)) return [0, 0, 0, 0];
    const lbl = clusterLabelForPoint(d, clusterHighlightLabelKey, getLabelForId) ?? 0;
    const rgb = clusterColor(lbl);
    return [rgb[0], rgb[1], rgb[2], 255];
  };

  const sizeTrigger = () => {
    const s = sizeStateRef.current;
    return [
      s.computedImageSize,
      s.markerZoom,
      s.tilePx,
      s.rawUsesOmeTiff,
      s.clusterColorOn,
      s.renderMode,
      s.semanticLevel,
      s.semanticSizeOn,
      is3D,
      useSquareOutline,
    ];
  };

  if (!useSquareOutline) {
    target.push(
      new ScatterplotLayer({
        id: "cluster-highlight-dot",
        data: highlightData,
        getPosition: (d) => worldPos(d),
        getRadius: () => {
          const markerSize = readMarkerSize();
          return Math.max(1.5, Math.min(3.5, markerSize * 0.3));
        },
        radiusUnits: "pixels",
        billboard: true,
        filled: true,
        stroked: false,
        getFillColor: clusterHighlightColor,
        pickable: false,
        autoHighlight: false,
        ...filterExt,
        parameters: { depthTest: is3D, blend: true },
        updateTriggers: {
          getRadius: sizeTrigger(),
          getFillColor: [
            highlightedClusters,
            filteredIds,
            clusterHighlightLabelKey,
            getLabelForId,
          ],
          getFilterValue: [selectedIds],
          getPosition: [pixelYFlipHeight],
        },
      }),
    );
    return;
  }

  const base = {
    data: highlightData,
    iconAtlas: CLUSTER_OUTLINE_ICON.atlas,
    iconMapping: CLUSTER_OUTLINE_ICON.mapping,
    getIcon: () => "outline",
    getPosition: (d) => worldPos(d),
    getSize: () => readMarkerSize(),
    sizeUnits: "pixels",
    billboard: true,
    pickable: false,
    autoHighlight: false,
    ...filterExt,
    updateTriggers: {
      getSize: sizeTrigger(),
      getColor: [
        highlightedClusters,
        filteredIds,
        clusterHighlightLabelKey,
        getLabelForId,
      ],
      getFilterValue: [selectedIds],
      getPosition: [pixelYFlipHeight],
    },
  };

  target.push(
    new IconLayer({
      ...base,
      id: "cluster-highlight-shadow",
      getSize: () => readMarkerSize() + 1,
      getColor: () => [0, 0, 0, 190],
      parameters: { depthTest: is3D, blend: true },
    }),
  );

  target.push(
    new IconLayer({
      ...base,
      id: "cluster-highlight-square",
      getColor: clusterHighlightColor,
      parameters: { depthTest: is3D, blend: true },
    }),
  );
}

export default function useImageLayers({
  meta,
  renderMode = "sprites",
  points = [],
  atlasByChannel,
  iconMappingsByChunk,
  channels = [],
  colors = {},
  alphas = {},
  windows = {},
  is3D = false,
  filteredIds = new Set(),
  highlightedClusters = null,
  clusterColorOn = false,
  clusterOpacity = 0.25,
  clusterLineWidth = 1,
  clusterOutlineOn = false,
  outlineData = [],
  computedImageSize = 4,
  getRegionIndexForId,
  regionColors,
  semanticLevel = 6.0,
  labelKey = "label",
  /** Cluster Filter checkbox labels (always base `label` column). */
  clusterHighlightLabelKey = "label",
  semanticSizeOn = false,
  samplingThreshold = 1.0,
  /** Points used for invisible pick layer (spatial: all cells; visual may be sampled). */
  pickPoints = null,
  /** When true, sprites are not pickable; transparent scatter handles hover. */
  hoverPickAll = false,
  selectedIds = null,
  /** When false, selected ids still respect samplingThreshold (spatial→UMAP case). */
  selectedBypassSampling = true,
  transitionsEnabled = true,
  /** Stroked cell markers for readability on top of bright OME-TIFF imagery */
  dotOutlineForBrightBackground = false,
  /** When true, never composite Zarr tile atlases (OME-TIFF / Viv is the image source). */
  suppressSpriteAtlases = false,
  /** If set, match OME base: world y = pixelYFlipHeight - raw_y */
  pixelYFlipHeight = null,
  /** OME spatial: invisible scatter for pick/lasso; selection via DOM ring */
  omeSpatialScatterPickOnly = false,
  /** Global guard: render nothing when no active channels */
  hasRenderableChannels = true,
  /** Optional: resolve label from server column (spatial cross-view). */
  getLabelForId = null,
  /** Points for cluster-filter rings; defaults to `points`. */
  clusterHighlightPoints = null,
  /** Deck zoom — OME tile outline sizing */
  markerZoom = 0,
  tilePx = 16,
  rawUsesOmeTiff = false,
  /** Shared OME-derived intensity ranges (same source as Viv contrastLimits). */
  omePixelRangeByChannelId = {},
}) {
  const worldPos = (d) => pointToWorld(d, pixelYFlipHeight);
  const worldPath = (path) => pathToWorld(path, pixelYFlipHeight);

  const effectivePickPoints = pickPoints ?? points;
  const effectiveClusterHighlightPoints = clusterHighlightPoints ?? points;

  const selectedPoints = useMemo(() => {
    if (!points || !getRegionIndexForId) return [];
    const arr = [];
    for (const p of points) {
      const rIdx = getRegionIndexForId(p.id);
      if (typeof rIdx === "number" && rIdx >= 0) arr.push(p);
    }
    return arr;
  }, [points, getRegionIndexForId]);
  const hasSelection = selectedPoints.length > 0;

  // Zoom/size change often during pan-zoom — keep accessors on a ref so layers
  // are not torn down/recreated every scroll tick (GPU thrash / context loss).
  const sizeStateRef = useRef({
    computedImageSize,
    markerZoom,
    tilePx,
    rawUsesOmeTiff,
    clusterColorOn,
    renderMode,
    semanticLevel,
    semanticSizeOn,
  });
  sizeStateRef.current = {
    computedImageSize,
    markerZoom,
    tilePx,
    rawUsesOmeTiff,
    clusterColorOn,
    renderMode,
    semanticLevel,
    semanticSizeOn,
  };

  const markerSizeNow = markerSizeForOutline(sizeStateRef.current);
  const useSquareOutline = is3D
    ? markerZoom >= CLUSTER_SQUARE_OUTLINE_MIN_ZOOM_3D ||
      markerSizeNow >= CLUSTER_SQUARE_OUTLINE_MIN_PX
    : markerSizeNow >= CLUSTER_SQUARE_OUTLINE_MIN_PX;

  const pickScatterLayer = (idSuffix = "") => {
    if (!hoverPickAll || !effectivePickPoints?.length) return null;
    return new ScatterplotLayer({
      id: `spatial-hover-pick${idSuffix}`,
      data: effectivePickPoints,
      getPosition: (d) => worldPos(d),
      getFillColor: () => [255, 255, 255, 0],
      getRadius: () => sizeStateRef.current.computedImageSize * 0.85,
      radiusUnits: "pixels",
      stroked: false,
      pickable: true,
      autoHighlight: false,
      parameters: { depthTest: false },
      updateTriggers: {
        getRadius: [computedImageSize],
        getPosition: [pixelYFlipHeight],
      },
    });
  };

  const layers = useMemo(() => {
    if (!hasRenderableChannels) return [];
    const hasPoints = (points?.length ?? 0) > 0;
    if (!meta && !(suppressSpriteAtlases && hasPoints)) return [];

    if (renderMode === "sprites" && !suppressSpriteAtlases) {
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

        const baseConfig = {
          data: arr,
          iconMapping: mapping,
          getIcon: (d) => `t_${d.local_index}`,
          getPosition: (d) => [d.x, d.y, d.z ?? 0],
          
          extensions: [SAMPLING_FILTER],
          getFilterValue: (d) =>
            samplingFilterValue(d, selectedIds, selectedBypassSampling),
          filterRange: [0, samplingThreshold],
          getSize: () => {
            const s = sizeStateRef.current;
            if (!s.semanticSizeOn) return s.computedImageSize;
            return s.computedImageSize * semanticMarkerSizeFactor(s.semanticLevel);
          },
          sizeScale: 1,
          fovy: 45,
          near: 0.1,
          far: 1000,
          distanceFadeEnabled: is3D,
          sizeUnits: "pixels",
          billboard: true,
          pickable: !hoverPickAll,
          autoHighlight: false,
          // Image (not ImageBitmap) for texture reliability; animate position only
          transitions: transitionsEnabled
            ? {
                getPosition: { duration: 600, easing: ease },
              }
            : undefined,
          updateTriggers: {
            getSize: [computedImageSize, selectedPoints.length, semanticLevel, semanticSizeOn],
            getFilterValue: [selectedPoints.length],
          },
        };
        if (!clusterColorOn) {
          for (const ch of channels) {
            const atlasGray = atlasByChannel?.[chunkId]?.[ch];
            if (!atlasGray) continue;

            const col = colors?.[ch] || [255, 255, 255];
            const alpha01 = Math.min(1, Math.max(0, alphas?.[ch] ?? 1));
            const { winMin01, winMax01 } = windowFromChannel(
              ch,
              windows,
              omePixelRangeByChannelId,
            );

            all.push(
              new WindowedIconLayer({
                ...baseConfig,
                id: `icon-ch${ch}-${chunkId}`,
                iconAtlas: String(atlasGray),
                // Atlas stores raw/65535; dim markers are often << 0.05.
                // Default IconLayer alphaCutoff discards them *before* windowing
                // (hover windows first — that is why hover matched OME and UMAP did not).
                alphaCutoff: 0,
                // Additive blend (multi-channel fluorescence)
                parameters: { depthTest: false, blend: true, blendFunc: [1, 1], blendEquation: 32774 },
                windowMin: winMin01,
                windowMax: winMax01,
                channelAlpha: alpha01,
                toneGain: TONE_GAIN,
                premultiply: false,
                getColor: (d) => {
                  const activeFilter = filteredIds && filteredIds.size > 0;
                  if (activeFilter && !filteredIds.has(d.id)) {
                    return [col[0] ?? 255, col[1] ?? 255, col[2] ?? 255, 0];
                  }
                  return [
                    col[0] ?? 255,
                    col[1] ?? 255,
                    col[2] ?? 255,
                    255,
                  ];
                },
                updateTriggers: {
                  ...baseConfig.updateTriggers,
                  getColor: [
                    filteredIds,
                    colors,
                    alphas,
                    windows,
                    omePixelRangeByChannelId,
                    winMin01,
                    winMax01,
                  ],
                  getFilterValue: [selectedPoints.length],
                  // Ensure intensity window uniforms refresh with tile/OME auto range.
                  windowMin: [winMin01, windows, omePixelRangeByChannelId],
                  windowMax: [winMax01, windows, omePixelRangeByChannelId],
                },
              })
            );
          }
        }

        if (clusterColorOn) {
          const atlasAny = (atlasByChannel?.[chunkId] && Object.values(atlasByChannel[chunkId])[0]) || null;
          if (atlasAny) {
            all.push(
              new WindowedIconLayer({
                ...baseConfig,
                id: `cluster-color-atlas-${chunkId}`,
                iconAtlas: String(atlasAny),
                alphaCutoff: 0,
                parameters: { depthTest: false, blend: false },
                windowMin: 0.0,
                windowMax: 1.0,
                flatColor: true,
                channelAlpha: 1.0,
                toneGain: 1.0,
                premultiply: false,
                getColor: (d) => {
                  const rIdx = getRegionIndexForId?.(d.id);
                  if (hasSelection && !(typeof rIdx === "number" && rIdx >= 0)) {
                    return [0, 0, 0, 0];
                  }
                  const activeFilter = filteredIds && filteredIds.size > 0;
                  if (activeFilter && !filteredIds.has(d.id)) return [0, 0, 0, 0];

                  // Color by labelKey (semantic level)
                  const val = d[labelKey];
                  const l = Number.isFinite(val) ? val : (d.label ?? 0);
                  const rgb = clusterColor(l);
                  const a = Math.round(Math.min(1, Math.max(0, clusterOpacity)) * 255);
                  return [rgb[0], rgb[1], rgb[2], a];
                },
                updateTriggers: {
                  ...baseConfig.updateTriggers,
                  getColor: [filteredIds, clusterOpacity, selectedPoints.length, labelKey],
                  getFilterValue: [selectedPoints.length],
                },
              })
            );
          } else {
            const a = Math.round(Math.min(1, Math.max(0, clusterOpacity)) * 255);
            all.push(
              new ScatterplotLayer({
                id: `cluster-color-${chunkId}`,
                data: arr,
                getPosition: (d) => [d.x, d.y, d.z ?? 0],
                stroked: false,
                extensions: [SAMPLING_FILTER],
                getFilterValue: (d) =>
                  samplingFilterValue(d, selectedIds, selectedBypassSampling),
                filterRange: [0, samplingThreshold],
                getFillColor: (d) => {
                  const rIdx = getRegionIndexForId?.(d.id);
                  if (hasSelection && !(typeof rIdx === "number" && rIdx >= 0)) return [0, 0, 0, 0];
                  const activeFilter = filteredIds && filteredIds.size > 0;
                  if (activeFilter && !filteredIds.has(d.id)) return [0, 0, 0, 0];

                  const val = d[labelKey];
                  const l = Number.isFinite(val) ? val : (d.label ?? 0);
                  const rgb = clusterColor(l);
                  return [rgb[0], rgb[1], rgb[2], a];
                },
                getRadius: () => {
                  const s = sizeStateRef.current.computedImageSize;
                  return s * 0.76;
                },
                radiusUnits: "pixels",
                pickable: false,
                parameters: { depthTest: false, blend: false },
                updateTriggers: {
                  getFillColor: [
                    filteredIds,
                    clusterOpacity,
                    selectedPoints.length,
                    labelKey,
                  ],
                  getRadius: [computedImageSize, selectedPoints.length],
                  getFilterValue: [selectedPoints.length],
                },
              })
            );
          }
        }
      }

      if (!is3D && clusterOutlineOn && clusterLineWidth > 0 && outlineData.length > 0) {
        all.push(
          new PathLayer({
            id: "cluster-outlines",
            data: outlineData,
            getPath: (d) => worldPath(d.path),
            getColor: (d) => d.color,
            widthUnits: "pixels",
            getWidth: Math.max(0, clusterLineWidth),
            parameters: { depthTest: false },
            pickable: false,
            rounded: true,
            jointRounded: true,
            miterLimit: 2,
            loop: true,
            updateTriggers: {
              getColor: [outlineData.length],
              getWidth: [clusterLineWidth],
              getPath: [pixelYFlipHeight, outlineData.length],
            },
          }),
        );
      }

      appendClusterHighlightOutlineLayers(all, {
        points: effectiveClusterHighlightPoints,
        highlightedClusters,
        clusterHighlightLabelKey,
        getLabelForId,
        sizeStateRef,
        useSquareOutline,
        is3D,
        // Sprites are UMAP / non-OME — never apply spatial Y flip here.
        worldPos: (d) => pointToWorld(d),
        samplingThreshold,
        selectedIds,
        selectedBypassSampling,
        filteredIds,
        pixelYFlipHeight: null,
      });

      const pickLayer = pickScatterLayer();
      if (pickLayer) all.push(pickLayer);

      return all;
    }

    const base = [];
    if (clusterColorOn) {
      const a = Math.round(Math.min(1, Math.max(0, clusterOpacity)) * 255);
      base.push(
        new ScatterplotLayer({
          id: "scatter-cluster-only",
          data: points ?? [],
          getPosition: (d) => worldPos(d),
          stroked: dotOutlineForBrightBackground,
          lineWidthUnits: "pixels",
          getLineWidth: dotOutlineForBrightBackground ? 1 : 0,
          getLineColor: () => [0, 0, 0, 210],
          extensions: [SAMPLING_FILTER],
          getFilterValue: (d) =>
            samplingFilterValue(d, selectedIds, selectedBypassSampling),
          filterRange: [0, samplingThreshold],
          getFillColor: (d) => {
            const rIdx = getRegionIndexForId?.(d.id);
            if (hasSelection && !(typeof rIdx === "number" && rIdx >= 0)) return [0, 0, 0, 0];
            const activeFilter = filteredIds && filteredIds.size > 0;
            if (activeFilter && !filteredIds.has(d.id)) return [0, 0, 0, 0];

            const val = d[labelKey];
            const l = Number.isFinite(val) ? val : (d.label ?? 0);
            const rgb = clusterColor(l);

            return [rgb[0], rgb[1], rgb[2], a];
          },
          getRadius: () => sizeStateRef.current.computedImageSize * 0.72,
          radiusUnits: "pixels",
          pickable: true,
          autoHighlight: true,
          parameters: { depthTest: true, blend: false },
          transitions: transitionsEnabled
            ? {
                getPosition: { duration: 600, easing: ease },
              }
            : undefined,
          updateTriggers: {
            getFillColor: [
              filteredIds,
              clusterOpacity,
              selectedPoints.length,
              labelKey,
            ],
            getRadius: [computedImageSize, selectedPoints.length],
            getFilterValue: [selectedPoints.length],
            getPosition: [pixelYFlipHeight],
          },
        })
      );
    } else {
      base.push(
        new ScatterplotLayer({
          id: "scatter",
          data: points ?? [],
          getPosition: (d) => worldPos(d),
          extensions: [SAMPLING_FILTER],
          getFilterValue: (d) =>
            samplingFilterValue(d, selectedIds, selectedBypassSampling),
          filterRange: [0, samplingThreshold],
          getFillColor: (d) => {
            const activeFilter = filteredIds && filteredIds.size > 0;
            if (omeSpatialScatterPickOnly) {
              if (activeFilter && !filteredIds.has(d.id)) {
                return [0, 0, 0, 0];
              }
              // Transparent scatter; selection ring in Viewer DOM (avoids disk over OME)
              return [255, 255, 255, 0];
            }
            if (activeFilter && !filteredIds.has(d.id)) {
              return [0, 0, 0, 0];
            }
            if (dotOutlineForBrightBackground) {
              return [255, 255, 255, 220];
            }
            return [255, 255, 255, 255];
          },
          stroked: omeSpatialScatterPickOnly ? false : dotOutlineForBrightBackground,
          lineWidthUnits: "pixels",
          getLineWidth: omeSpatialScatterPickOnly ? 0 : dotOutlineForBrightBackground ? 1 : 0,
          getLineColor: () => [0, 0, 0, 220],
          getRadius: () =>
            sizeStateRef.current.computedImageSize *
            0.75 *
            (omeSpatialScatterPickOnly ? 1.5 : 1),
          radiusScale: 1,
          radiusUnits: "pixels",
          pickable: true,
          autoHighlight: false,
          parameters: { depthTest: true },
          transitions: transitionsEnabled
            ? {
                getPosition: { duration: 600, easing: ease },
              }
            : undefined,
          updateTriggers: {
            getFillColor: [
              filteredIds,
              selectedPoints.length,
              omeSpatialScatterPickOnly,
            ],
            getRadius: [
              computedImageSize,
              selectedPoints.length,
              omeSpatialScatterPickOnly,
            ],
            getFilterValue: [selectedPoints.length],
            getPosition: [pixelYFlipHeight],
            getLineWidth: [omeSpatialScatterPickOnly, dotOutlineForBrightBackground],
          },
        })
      );
    }
    if (!is3D && clusterOutlineOn && clusterLineWidth > 0 && outlineData.length > 0) {
      base.push(
        new PathLayer({
          id: "scatter-cluster-outlines",
          data: outlineData,
          getPath: (d) => worldPath(d.path),
          getColor: (d) => d.color,
          widthUnits: "pixels",
          getWidth: Math.max(0, clusterLineWidth),
          parameters: { depthTest: false },
          pickable: false,
          rounded: true,
          jointRounded: true,
          miterLimit: 2,
          loop: true,
          updateTriggers: {
            getColor: [outlineData.length],
            getWidth: [clusterLineWidth],
            getPath: [pixelYFlipHeight, outlineData.length],
          },
        })
      );
    }
    appendClusterHighlightOutlineLayers(base, {
      points: effectiveClusterHighlightPoints,
      highlightedClusters,
      clusterHighlightLabelKey,
      getLabelForId,
      sizeStateRef,
      useSquareOutline,
      is3D,
      worldPos,
      samplingThreshold,
      selectedIds,
      selectedBypassSampling,
      filteredIds,
      pixelYFlipHeight,
    });

    const pickLayer = pickScatterLayer("-scatter");
    if (pickLayer) base.push(pickLayer);

    return base;
  }, [
    meta,
    renderMode,
    points,
    pickPoints,
    hoverPickAll,
    effectivePickPoints,
    pixelYFlipHeight,
    atlasByChannel,
    iconMappingsByChunk,
    channels,
    colors,
    alphas,
    windows,
    omePixelRangeByChannelId,
    is3D,
    filteredIds,
    highlightedClusters,
    clusterColorOn,
    clusterOpacity,
    clusterLineWidth,
    clusterOutlineOn,
    outlineData,
    // Marker pixel size follows zoom; deck diffs same layer ids (no new WebGL context).
    computedImageSize,
    useSquareOutline,
    getRegionIndexForId,
    regionColors,
    selectedPoints.length,
    dotOutlineForBrightBackground,
    suppressSpriteAtlases,
    omeSpatialScatterPickOnly,
    hasRenderableChannels,
    selectedIds,
    selectedBypassSampling,
    samplingThreshold,
    getLabelForId,
    clusterHighlightLabelKey,
    clusterHighlightPoints,
    effectiveClusterHighlightPoints,
    tilePx,
    rawUsesOmeTiff,
    semanticLevel,
    semanticSizeOn,
  ]);

  return layers;
}


