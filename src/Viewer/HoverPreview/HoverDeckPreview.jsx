import React, { useMemo } from "react";
import DeckGL from "@deck.gl/react";
import { OrthographicView } from "@deck.gl/core";
import ImageLayers from "../../layers/ImageLayers";

const PREVIEW_VIEW_ID = "hover-preview-2d";

/**
 * Single-cell hover preview via the same ImageLayers / WindowedIconLayer stack as UMAP.
 */
export default function HoverDeckPreview({
  point,
  previewSize = 128,
  meta,
  atlasURL = {},
  atlasByChannel = {},
  iconMappingsByChunk = {},
  chunkUV = {},
  channels = [],
  colors = {},
  alphas = {},
  windows = {},
  clusterColorOn = false,
  clusterOpacity = 0.25,
  clusterLineWidth = 1,
  clusterOutlineOn = false,
  labelKey = "label",
  isUMAPView = true,
  computedImageSize = 16,
}) {
  const tilePx = useMemo(() => {
    const cid = point?.chunk_id;
    return chunkUV?.[cid]?.tile ?? meta?.atlas?.tile ?? 16;
  }, [point?.chunk_id, chunkUV, meta?.atlas?.tile]);

  const previewIconSize = useMemo(
    () => Math.max(8, Math.min(previewSize * 0.94, tilePx * (previewSize / Math.max(tilePx, 1)))),
    [previewSize, tilePx],
  );

  const viewState = useMemo(
    () => ({
      target: [point?.x ?? 0, point?.y ?? 0, point?.z ?? 0],
      zoom: isUMAPView ? 10 : 4,
      minZoom: -20,
      maxZoom: 20,
      id: PREVIEW_VIEW_ID,
    }),
    [point?.x, point?.y, point?.z, isUMAPView],
  );

  const layers = ImageLayers({
    meta,
    renderMode: "sprites",
    points: point ? [point] : [],
    atlasURL,
    atlasByChannel,
    iconMappingsByChunk,
    channels,
    colors,
    alphas,
    windows,
    is3D: false,
    filteredIds: new Set(),
    clusterColorOn,
    clusterOpacity,
    clusterLineWidth,
    clusterOutlineOn,
    outlineData: [],
    computedImageSize: previewIconSize,
    getRegionIndexForId: () => -1,
    regionColors: [],
    labelKey,
    samplingThreshold: 1,
    selectedIds: new Set(),
    selectedBypassSampling: true,
    transitionsEnabled: false,
    suppressSpriteAtlases: false,
    hasRenderableChannels: channels?.length > 0,
    hoverPickAll: false,
  });

  if (!point || !layers?.length) {
    return (
      <div
        className="hover-preview-deck-empty"
        style={{ width: previewSize, height: previewSize, background: "#000" }}
      />
    );
  }

  return (
    <div
      className="hover-preview-deck-wrapper"
      style={{
        width: previewSize,
        height: previewSize,
        background: "#000",
        overflow: "hidden",
      }}
    >
      <DeckGL
        width={previewSize}
        height={previewSize}
        style={{ position: "relative", background: "#000" }}
        views={new OrthographicView({ id: PREVIEW_VIEW_ID, flipY: false })}
        controller={false}
        viewState={viewState}
        layers={layers}
        pickingRadius={0}
        useDevicePixels={true}
        getCursor={() => "default"}
      />
    </div>
  );
}
