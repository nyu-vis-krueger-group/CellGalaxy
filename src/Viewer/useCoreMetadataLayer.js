import { useMemo } from "react";
import { TextLayer } from "@deck.gl/layers";
import { buildCoreMetadataWorldItems } from "../utils/coreMetadata";

/**
 * Deck.gl TextLayer for CORE_ID metadata labels in OME spatial world coordinates.
 */
export default function useCoreMetadataLayer({
  enabled = false,
  viewerId = "viewer",
  rows = [],
  selectedFields = [],
  imageWidth = null,
  imageHeight = null,
  pixelYFlipHeight = null,
  viewState = null,
}) {
  const worldItems = useMemo(
    () =>
      buildCoreMetadataWorldItems({
        rows,
        selectedFields,
        imageWidth,
        imageHeight,
        pixelYFlipHeight,
      }),
    [rows, selectedFields, imageWidth, imageHeight, pixelYFlipHeight],
  );

  const textSize = useMemo(() => {
    const z = typeof viewState?.zoom === "number" ? viewState.zoom : 0;
    const size = 14 * (1 + (z - 8) * 0.1);
    return Math.max(12, Math.min(32, size));
  }, [viewState?.zoom]);

  const layer = useMemo(() => {
    if (!enabled || !worldItems.length) return null;
    return new TextLayer({
      id: `core-metadata-labels-${viewerId}`,
      data: worldItems,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: textSize,
      sizeUnits: "pixels",
      getColor: [255, 255, 255, 255],
      getBackgroundColor: [0, 0, 0, 180],
      background: true,
      backgroundPadding: [4, 2],
      billboard: true,
      pickable: false,
      fontFamily: "Helvetica, Arial, sans-serif",
      characterSet: "auto",
      parameters: { depthTest: false },
      updateTriggers: {
        getPosition: [imageWidth, imageHeight, pixelYFlipHeight, selectedFields],
        getText: [selectedFields],
        getSize: [textSize],
      },
    });
  }, [
    enabled,
    viewerId,
    worldItems,
    textSize,
    imageWidth,
    imageHeight,
    pixelYFlipHeight,
    selectedFields,
  ]);

  return { layer, worldItems };
}
