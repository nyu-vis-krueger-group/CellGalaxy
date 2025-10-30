import React from "react";
import "./Control.css";
import FileUpload from "../FileUpload/FileUpload";
import RenderModeSelector from "../RenderModeSelector/RenderModeSelector";
import UMAPSelector from "../UMAPSelector/UMAPSelector";
import ImageSizeControl from "../ImageSizeControl/ImageSizeControl";
import ChannelManager from "../ChannelManager/ChannelManager";
import SelectionPanel from "../SelectionPanel/SelectionPanel";
import Filter from "../Filter/Filter";

export default function Control({
  meta,
  channels,
  setChannels,
  colors,
  setColors,
  windows,
  setWindows,
  renderMode,
  setRenderMode,
  is3D,
  setIs3D,
  useUMAP,
  setUseUMAP,
  imageSize,
  setImageSize,
  refreshData,
  dataVersion,

  // —— New: selection state and operations ——
  selectionMode = "none",
  setSelectionMode = () => {},
  selectedIds = new Set(),
  setSelectedIds = () => {},
  filteredIds = new Set(),
  setFilteredIds = () => {},
}) {
  return (
    <div className="control-panel">
      <FileUpload onRefresh={refreshData} />
      {/* Selection panel */}
      <SelectionPanel
        selectionMode={selectionMode}
        setSelectionMode={setSelectionMode}
        selectedIds={selectedIds}
      />

      {/* UMAP mode selection */}
      <UMAPSelector useUMAP={useUMAP} setUseUMAP={setUseUMAP} />

      {/* Rendering mode selection */}
      <RenderModeSelector
        renderMode={renderMode}
        setRenderMode={setRenderMode}
        is3D={is3D}
        setIs3D={setIs3D}
      />

      {/* Image size control */}
      <ImageSizeControl imageSize={imageSize} setImageSize={setImageSize} />

      {/* Filter (by raw data) */}
      <Filter setFilteredIds={(ids) => { setFilteredIds(ids); }} />

      {/* Channel management */}
      <ChannelManager
        selected={channels}
        setSelected={setChannels}
        colors={colors}
        setColors={setColors}
        windows={windows}
        setWindows={setWindows}
        dataVersion={dataVersion}
      />
    </div>
  );
}
