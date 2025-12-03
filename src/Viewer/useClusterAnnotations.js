import { useEffect, useMemo, useState } from "react";
import { TextLayer } from "@deck.gl/layers";
import { clusterColor } from "../utils/clustering";

/**
 * Build cluster annotation TextLayer + lookup map for tooltips.
 * Depends only on outlineData (per-cluster centroid + label), viewState zoom,
 * and the selected annotation model.
 */
export default function useClusterAnnotations({
  clusterAnnotationOn = false,
  clusterAnnotationModel = "MedGemma",
  outlineData = [],
  viewState,
  is3D = false,
  screenOutlines3D = [],
  level = 0,
}) {
  // Load static JSON once when annotation is enabled
  const [clusterLabelsJson, setClusterLabelsJson] = useState(null);

  useEffect(() => {
    if (!clusterAnnotationOn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/cluster_labels.json");
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setClusterLabelsJson(json);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("failed to load cluster_labels.json", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clusterAnnotationOn]);

  // Text size that responds to zoom (bigger when zooming in)
  const clusterTextSize = useMemo(() => {
    const z = typeof viewState?.zoom === "number" ? viewState.zoom : 0;
    const base = 14;
    const scale = 1 + (z - 8) * 0.1;
    const size = base * scale;
    return Math.max(10, Math.min(32, size));
  }, [viewState]);

  // Build annotation data (cluster centroid + title/description for selected model)
  const clusterAnnotationData = useMemo(() => {
    if (!clusterAnnotationOn) return [];
    if (!clusterLabelsJson) return [];
    const source = is3D ? screenOutlines3D : outlineData;
    if (!source || source.length === 0) return [];
    const levels = clusterLabelsJson.levels || {};
    const levelKey = String(level - 1);
    const levelData = levels[levelKey] || {};
    if (!clusterAnnotationModel) return [];

    const result = [];
    for (const outline of source) {
      const labelKey = String(outline.label);
      const clusterEntry = levelData[labelKey];
      const modelInfo =
        clusterEntry && clusterEntry.models && clusterEntry.models[clusterAnnotationModel];
      if (!modelInfo || !modelInfo.title) continue;
      const c = is3D
        ? outline.centroidWorld || [0, 0, 0]
        : outline.centroid || (outline.path && outline.path[0]) || [0, 0, 0];
      const pixelOffset = is3D && Array.isArray(outline.pixelOffset)
        ? outline.pixelOffset.map((v) => (Number.isFinite(v) ? v : 0))
        : [0, 0];
      const bboxCenter =
        outline.bbox &&
        Number.isFinite(outline.bbox.cx) &&
        Number.isFinite(outline.bbox.cy)
          ? [outline.bbox.cx, outline.bbox.cy]
          : null;
      result.push({
        position: [c[0], c[1], c[2] ?? 0],
        pixelOffset,
        screenPosition: bboxCenter,
        label: outline.label,
        title: modelInfo.title,
        description: modelInfo.description || "",
        model: clusterAnnotationModel,
        kind: "cluster-annotation",
      });
    }
    return result;
  }, [
    clusterAnnotationOn,
    clusterLabelsJson,
    outlineData,
    clusterAnnotationModel,
    is3D,
    screenOutlines3D,
    level,
  ]);

  // Quick lookup: label -> annotation entry
  const clusterAnnotationByLabel = useMemo(() => {
    if (!clusterAnnotationData || clusterAnnotationData.length === 0) return new Map();
    const m = new Map();
    for (const d of clusterAnnotationData) {
      m.set(d.label, d);
    }
    return m;
  }, [clusterAnnotationData]);

  const annotationLayer = useMemo(() => {
    if (!clusterAnnotationOn) return null;
    if (!clusterAnnotationData || clusterAnnotationData.length === 0) return null;
    return new TextLayer({
      id: "cluster-annotations",
      data: clusterAnnotationData,
      getPosition: (d) => d.position,
      getText: (d) => d.title,
      getSize: () => clusterTextSize,
      sizeUnits: "pixels",
      getPixelOffset: (d) => d.pixelOffset || [0, 0],
      getColor: [255, 255, 255, 255],
      getBackgroundColor: (d) => {
        const rgb = clusterColor(d.label);
        return [rgb[0], rgb[1], rgb[2], 170];
      },
      background: true,
      billboard: true,
      pickable: true,
      parameters: { depthTest: false },
      updateTriggers: {
        getSize: [clusterTextSize],
      },
    });
  }, [clusterAnnotationOn, clusterAnnotationData, clusterTextSize]);

  return { annotationLayer, clusterAnnotationByLabel, clusterAnnotationData };
}
