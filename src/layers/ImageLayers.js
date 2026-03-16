import { useMemo } from "react";
import { ScatterplotLayer, PathLayer } from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import WindowedIconLayer from "./WindowedIconLayer";
import { clusterColor } from "../utils/clustering";
import { ease } from "../utils/utils";

export default function ImageLayers({
  meta,
  renderMode = "sprites",
  points = [],
  atlasURL,
  atlasByChannel,
  iconMappingsByChunk,
  channels = [],
  colors = {},
  alphas = {},
  windows = {},
  is3D = false,
  filteredIds = new Set(),
  // cluster overlay
  clusterColorOn = false,
  clusterOpacity = 0.25,
  clusterLineWidth = 1,
  clusterOutlineOn = false,
  // outlines (2D)
  outlineData = [],
  // size
  computedImageSize = 4,
  // selection coloring
  getRegionIndexForId,
  regionColors,
  // semantic zoom
  semanticLevel = 6.0,
  labelKey = "label",
  // rankKey unused
  rankKey = null,
  // Whether to enable size adjustment based on semanticLevel
  semanticSizeOn = false,
  // GPU Sampling
  samplingThreshold = 1.0,
  selectedIds = null, // Set of IDs that should always be shown
  // Whether to enable transition animations for point positions / sizes
  transitionsEnabled = true,
}) {

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

        const baseConfig = {
          data: arr.map((d) => ({ ...d, icon: `t_${d.local_index}` })),
          iconMapping: mapping,
          getIcon: (d) => d.icon,
          getPosition: (d) => [d.x, d.y, d.z ?? 0],
          
          // --- GPU Filtering for Sampling ---
          extensions: [new DataFilterExtension({ filterSize: 1 })],
          getFilterValue: (d) => {
            // Always show selected items
            if (selectedIds && selectedIds.has(d.id)) return 0;
            // Uniform hash
            return (d.id * 0.6180339887) % 1;
          },
          filterRange: [0, samplingThreshold],
          // ----------------------------------
          getSize: (d) => {
            // —— Semantic zoom size adjustment ——
            // Raw view: semanticSizeOn=false, use the original size logic directly.
            if (!semanticSizeOn) {
              return computedImageSize;
            }

            // UMAP view: scale size piecewise based on semanticLevel.
            // Adjusted rule (slightly smaller overall, but boost for Level < 1.7):
            //   Level∈[0,1)    →  sizeFactor = 4.8  (larger representative images)
            //   Level∈[1,1.7)  →  linear from 4.8 down to 2.4
            //   Level∈[1.7,3)  →  linear from 2.4 down to 0.9 (rapidly shrinking as point count increases)
            //   Level≥3       →  sizeFactor = 0.9
            const lvl = Math.max(0, Math.min(6, semanticLevel));
            let sizeFactor;
            if (lvl < 1.0) {
              sizeFactor = 4.8;
            } else if (lvl < 1.7) {
              const t = (lvl - 1.0) / 0.7;              // 0 → 1
              sizeFactor = 4.8 + (2.4 - 4.8) * t;      // 4.8 → 2.4
            } else if (lvl < 3.0) {
              const t = (lvl - 1.7) / (3.0 - 1.7);      // 0 → 1
              sizeFactor = 2.4 + (0.9 - 2.4) * t;      // 2.4 → 0.9
            } else {
              sizeFactor = 0.9;
            }

            return computedImageSize * sizeFactor;
          },
          sizeScale: 1,
          fovy: 45,
          near: 0.1,
          far: 1000,
          distanceFadeEnabled: is3D,
          sizeUnits: "pixels",
          billboard: true,
          pickable: true,
          // Disable built‑in blue highlight; we draw a custom white outline on hover instead.
          autoHighlight: false,
          // Use default Image loading (not ImageBitmap) so WebGL texture upload works reliably
          // across browsers/GPUs; ImageBitmap can fail on some environments and cause sprites not to render.
          // Only animate positions; do not interpolate size changes (e.g. zoom-driven computedImageSize)
          transitions: transitionsEnabled
            ? {
                getPosition: { duration: 600, easing: ease },
              }
            : undefined,
          updateTriggers: {
            getSize: [computedImageSize, selectedPoints.length, semanticLevel, semanticSizeOn],
            getFilterValue: [selectedPoints.length], // re-eval if selection changes
          },
        };
        let addedGray = false;

        if (!clusterColorOn) {
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
                // Use plus‑lighter (additive blending): RGB values are added,
                // e.g. red+blue→magenta, red+green→yellow, mimicking
                // multi‑channel fluorescence mixing in the preview.
                parameters: { depthTest: false, blend: true, blendFunc: [1, 1], blendEquation: 32774 },
                windowMin: winMin01,
                windowMax: winMax01,
                premultiply: true,
                getColor: (d) => {
                  const activeFilter = filteredIds && filteredIds.size > 0;
                  // When filter is active, hide points that don't pass the filter (fully transparent)
                  if (activeFilter && !filteredIds.has(d.id)) {
                    return [col[0] ?? 255, col[1] ?? 255, col[2] ?? 255, 0];
                  }
                  return [
                    col[0] ?? 255,
                    col[1] ?? 255,
                    col[2] ?? 255,
                    a,
                  ];
                },
                updateTriggers: {
                  ...baseConfig.updateTriggers,
                  getColor: [filteredIds, colors, alphas, windows],
                  getFilterValue: [selectedPoints.length],
                },
              })
            );
          }
        }
        if (!clusterColorOn) {
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
                  const activeFilter = filteredIds && filteredIds.size > 0;
                  if (activeFilter && !filteredIds.has(d.id)) {
                    return [255, 255, 255, 0];
                  }
                  // Do not change brightness based on selection; express selection only via the white outline
                  return [255, 255, 255, 255];
                },
                updateTriggers: {
                  ...baseConfig.updateTriggers,
                  getColor: [filteredIds, selectedPoints.length],
                  getFilterValue: [selectedPoints.length],
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
                parameters: { depthTest: false, blend: false },
                windowMin: 0.0,
                windowMax: 1.0,
                flatColor: true,
                premultiply: true,
                getColor: (d) => {
                  const rIdx = getRegionIndexForId?.(d.id);
                  if (hasSelection && !(typeof rIdx === "number" && rIdx >= 0)) {
                    return [0, 0, 0, 0];
                  }
                  const activeFilter = filteredIds && filteredIds.size > 0;
                  if (activeFilter && !filteredIds.has(d.id)) return [0, 0, 0, 0];

                  // Use the labelKey corresponding to the current semantic level,
                  // instead of always using the original d.label, so colors track
                  // the active semantic clustering level.
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
                // --- GPU Filtering ---
                extensions: [new DataFilterExtension({ filterSize: 1 })],
                getFilterValue: (d) => {
                  if (selectedIds && selectedIds.has(d.id)) return 0;
                  return (d.id * 0.6180339887) % 1;
                },
                filterRange: [0, samplingThreshold],
                // ---------------------
                getFillColor: (d) => {
                  const rIdx = getRegionIndexForId?.(d.id);
                  if (hasSelection && !(typeof rIdx === "number" && rIdx >= 0)) return [0, 0, 0, 0];
                  const activeFilter = filteredIds && filteredIds.size > 0;
                  if (activeFilter && !filteredIds.has(d.id)) return [0, 0, 0, 0];
                  
                // Dynamic cluster coloring based on current level
                  const val = d[labelKey];
                  const l = Number.isFinite(val) ? val : (d.label ?? 0);
                  const rgb = clusterColor(l);
                  return [rgb[0], rgb[1], rgb[2], a];
                },
                getRadius: (d) => {
                  const rIdx = getRegionIndexForId?.(d.id);
                  const scale = typeof rIdx === "number" && rIdx >= 0 ? 1.2 : 1.0;
                  return computedImageSize * 0.76 * scale;
                },
                radiusUnits: "pixels",
                pickable: false,
                parameters: { depthTest: false, blend: false },
                updateTriggers: {
                  getFillColor: [filteredIds, clusterOpacity, selectedPoints.length, labelKey],
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
            getPath: (d) => d.path,
            getColor: (d) => d.color,
            widthUnits: "pixels",
            getWidth: Math.max(0, clusterLineWidth),
            parameters: { depthTest: false },
            pickable: false,
            rounded: true,
            jointRounded: true,
            miterLimit: 2,
                // Make PathLayer automatically close paths to avoid outline gaps
            loop: true,
            updateTriggers: { getColor: [outlineData.length], getWidth: [clusterLineWidth] },
          })
        );
      }

      return all;
    }

    const base = [];
    if (clusterColorOn) {
      const a = Math.round(Math.min(1, Math.max(0, clusterOpacity)) * 255);
      base.push(
        new ScatterplotLayer({
          id: "scatter-cluster-only",
          data: points ?? [],
          getPosition: (d) => [d.x, d.y, d.z ?? 0],
          stroked: false,
          // --- GPU Filtering ---
          extensions: [new DataFilterExtension({ filterSize: 1 })],
          getFilterValue: (d) => {
            if (selectedIds && selectedIds.has(d.id)) return 0;
            return (d.id * 0.6180339887) % 1;
          },
          filterRange: [0, samplingThreshold],
          // ---------------------
          getFillColor: (d) => {
            const rIdx = getRegionIndexForId?.(d.id);
            if (hasSelection && !(typeof rIdx === "number" && rIdx >= 0)) return [0, 0, 0, 0];
            const activeFilter = filteredIds && filteredIds.size > 0;
            if (activeFilter && !filteredIds.has(d.id)) return [0, 0, 0, 0];

            // Dynamic cluster coloring
            const val = d[labelKey];
            const l = Number.isFinite(val) ? val : (d.label ?? 0);
            const rgb = clusterColor(l);
            
            return [rgb[0], rgb[1], rgb[2], a];
          },
                getRadius: (d) => {
                  // Do not enlarge points when selected; selection is indicated only by the white outline
            return computedImageSize * 0.72;
          },
          radiusUnits: "pixels",
          pickable: true,
          autoHighlight: true,
          parameters: { depthTest: true, blend: false },
          // Only animate positions; do not interpolate radius changes (zoom or parameter adjustments)
          transitions: transitionsEnabled
            ? {
                getPosition: { duration: 600, easing: ease },
              }
            : undefined,
          updateTriggers: { 
            getFillColor: [filteredIds, clusterOpacity, selectedPoints.length, labelKey], 
            getRadius: [computedImageSize, selectedPoints.length],
            getFilterValue: [selectedPoints.length],
          },
        })
      );
    } else {
      base.push(
        new ScatterplotLayer({
          id: "scatter",
          data: points ?? [],
          getPosition: (d) => [d.x, d.y, d.z ?? 0],
          // --- GPU Filtering ---
          extensions: [new DataFilterExtension({ filterSize: 1 })],
          getFilterValue: (d) => {
            if (selectedIds && selectedIds.has(d.id)) return 0;
            return (d.id * 0.6180339887) % 1;
          },
          filterRange: [0, samplingThreshold],
          // ---------------------
          getFillColor: (d) => {
            const activeFilter = filteredIds && filteredIds.size > 0;
            if (activeFilter && !filteredIds.has(d.id)) {
              return [0, 0, 0, 0];
            }
            // Do not dim non-selected points; keep them uniformly white
            return [255, 255, 255, 255];
          },
          stroked: false,
          getRadius: (d) => {
            // Do not enlarge scatter points due to selection
            return computedImageSize * 0.75;
          },
          radiusScale: 1,
          radiusUnits: "pixels",
          pickable: true,
          // Disable built‑in highlight; we use a DOM outline instead.
          autoHighlight: false,
          parameters: { depthTest: true },
          // Only animate positions; do not interpolate radius changes
          transitions: transitionsEnabled
            ? {
                getPosition: { duration: 600, easing: ease },
              }
            : undefined,
          updateTriggers: {
            getFillColor: [filteredIds, selectedPoints.length],
            getRadius: [computedImageSize, selectedPoints.length],
            getFilterValue: [selectedPoints.length],
          },
        })
      );
    }
    if (!is3D && clusterOutlineOn && clusterLineWidth > 0 && outlineData.length > 0) {
      base.push(
        new PathLayer({
          id: "scatter-cluster-outlines",
          data: outlineData,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          widthUnits: "pixels",
          getWidth: Math.max(0, clusterLineWidth),
          parameters: { depthTest: false },
          pickable: false,
          rounded: true,
          jointRounded: true,
          miterLimit: 2,
          // Also close cluster outlines in scatter mode
          loop: true,
          updateTriggers: { getColor: [outlineData.length], getWidth: [clusterLineWidth] },
        })
      );
    }
    return base;
  }, [
    meta,
    renderMode,
    points,
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
    selectedPoints.length,
  ]);

  return layers;
}


