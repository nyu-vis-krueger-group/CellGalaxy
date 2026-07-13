import React, { useState } from "react";
import "./Control.css";
import FileUpload from "../FileUpload/FileUpload";
import RenderModeSelector from "../RenderModeSelector/RenderModeSelector";
import ViewModeSelector from "../ViewModeSelector/ViewModeSelector";
import ImageSizeControl from "../ImageSizeControl/ImageSizeControl";
import ChannelManager from "../ChannelManager/ChannelManager";
import SelectionPanel from "../SelectionPanel/SelectionPanel";
import Filter from "../Filter/Filter";
import ClusteringControl from "../ClusteringControl/ClusteringControl";
import ClusterFilter from "../ClusterFilter/ClusterFilter";
import CoreMetadataControl from "../CoreMetadataControl/CoreMetadataControl";

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
  refreshUploadStatus,
  dataVersion,

  selectionMode = "none",
  setSelectionMode = () => {},
  selectedIds = new Set(),
  setSelectedIds = () => {},
  filteredIds = new Set(),
  setFilteredIds = () => {},
  viewMode = "dual",
  setViewMode = () => {},
  
  clusterOutlineOn = false,
  setClusterOutlineOn = () => {},
  clusterOpacity = 0.25,
  setClusterOpacity = () => {},
  clusterLineWidth = 1,
  setClusterLineWidth = () => {},
  clusterAnnotationOn = false,
  setClusterAnnotationOn = () => {},
  clusterAnnotationModel = "MedGemma",
  setClusterAnnotationModel = () => {},
  clusterLabelReviewMode = false,
  setClusterLabelReviewMode = () => {},
  clusterPreviewOn = true,
  setClusterPreviewOn = () => {},
  rawAnnotationColumns = { celltype: false, neigh_names: false },
  cellTypeAnnotationOn = false,
  setCellTypeAnnotationOn = () => {},
  neighNamesAnnotationOn = false,
  setNeighNamesAnnotationOn = () => {},

  coreMetadataActive = false,
  coreMetadataTextColumns = [],
  coreMetadataSelectedFields = [],
  setCoreMetadataSelectedFields = () => {},
  omeTiffSpatialActive = false,

  omeTiffFile = null,
  setOmeTiffFile = () => {},
  clearLocalOmeTiff = () => {},
  omeTiffRestoreNeedsClick = false,
  restoreOmeTiffFromDisk = async () => {},
  omePixelRangeByChannelId = {},
  channelZarrIndexById = {},
  highlightedClusters = new Set(),
  setHighlightedClusters = () => {},
  availableClusterLabels = [],
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`control-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="control-header">
        <div className="brand">
          <img
            className="brand-logo"
            src="/icons/logo.png"
            alt="Cell Galaxy logo"
          />
        </div>
        <button
          className="control-toggle"
          aria-label="Toggle sidebar"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand settings" : "Collapse settings"}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>
      <div className="control-content">
        <FileUpload
          onRefresh={refreshData}
          refreshUploadStatus={refreshUploadStatus}
          omeTiffFile={omeTiffFile}
          setOmeTiffFile={setOmeTiffFile}
          onClearLocalOmeTiff={clearLocalOmeTiff}
          omeTiffRestoreNeedsClick={omeTiffRestoreNeedsClick}
          onRestoreOmeTiffFromDisk={restoreOmeTiffFromDisk}
          renderClusterFilter={() => (
            <ClusterFilter
              availableLabels={availableClusterLabels}
              highlightedClusters={highlightedClusters}
              setHighlightedClusters={setHighlightedClusters}
            />
          )}
        />
      {/* Channel management (moved above Selection) */}
      <ChannelManager
        selected={channels}
        setSelected={setChannels}
        colors={colors}
        setColors={setColors}
        windows={windows}
        setWindows={setWindows}
        dataVersion={dataVersion}
        omePixelRangeByChannelId={omePixelRangeByChannelId}
        channelZarrIndexById={channelZarrIndexById}
      />
      <CoreMetadataControl
        active={coreMetadataActive}
        textColumns={coreMetadataTextColumns}
        selectedFields={coreMetadataSelectedFields}
        setSelectedFields={setCoreMetadataSelectedFields}
        omeTiffSpatialActive={omeTiffSpatialActive}
      />
      {/* Selection panel */}
      <SelectionPanel
        selectionMode={selectionMode}
        setSelectionMode={setSelectionMode}
        selectedIds={selectedIds}
      />
      
      <ViewModeSelector
        viewMode={viewMode}
        setViewMode={setViewMode}
        useUMAP={useUMAP}
        setUseUMAP={setUseUMAP}
      />

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

      {/* Clustering overlay control */}
      <ClusteringControl
        outlineOn={clusterOutlineOn}
        setOutlineOn={setClusterOutlineOn}
        opacity={clusterOpacity}
        setOpacity={setClusterOpacity}
        lineWidth={clusterLineWidth}
        setLineWidth={setClusterLineWidth}
        annotationOn={clusterAnnotationOn}
        setAnnotationOn={setClusterAnnotationOn}
        annotationModel={clusterAnnotationModel}
        setAnnotationModel={setClusterAnnotationModel}
        reviewModeOn={clusterLabelReviewMode}
        setReviewModeOn={setClusterLabelReviewMode}
        previewOn={clusterPreviewOn}
        setPreviewOn={setClusterPreviewOn}
        rawAnnotationColumns={rawAnnotationColumns}
        cellTypeAnnotationOn={cellTypeAnnotationOn}
        setCellTypeAnnotationOn={setCellTypeAnnotationOn}
        neighNamesAnnotationOn={neighNamesAnnotationOn}
        setNeighNamesAnnotationOn={setNeighNamesAnnotationOn}
      />
    
      </div>
    </div>
  );
}
