import React from "react";
import { VIEW_SINGLE } from "./constants/view";
import {
  SPATIAL_SCROLL_ZOOM_SPEED,
  UMAP_SCROLL_ZOOM_SPEED,
} from "./constants/render";
import useDataLoader from "./DataLoader/DataLoader";
import Viewer from "./Viewer/Viewer";
import Control from "./Control/Control";
import "./App.css";
export default function App() {
  const dataLoader = useDataLoader();
  const {
    pointsRaw,
    pointsUMAP,
    clusterColorOn,
    clusterOutlineOn,
    clusterAnnotationOn,
    clusterAnnotationModel,
    clusterPreviewOn,
    ...rest
  } = dataLoader;
  // viewMode: single | dual
  const [viewMode, setViewMode] = React.useState(VIEW_SINGLE);
  // No camera tween on mode switch
  const [disableTransitions, setDisableTransitions] = React.useState(false);
  React.useEffect(() => {
    setDisableTransitions(true);
    const t = setTimeout(() => setDisableTransitions(false), 200);
    return () => clearTimeout(t);
  }, [viewMode]);

  return (
    <div className="app-container">
      {viewMode === "dual" ? (
        <div className="viewer-split">
          <div className="viewer-pane">
            <div className="viewer-label">Spatial</div>
            <Viewer
              key={`viewer-raw-${viewMode}`}
              {...rest}
              viewerId="raw"
              omeTiffUrl={rest.omeTiffUrl}
              omeTiffFile={rest.omeTiffFile}
              channelOmeIndexById={rest.channelOmeIndexById}
              points={pointsRaw}
              hoverMaskEnabled={false}
              clusterColorOn={clusterColorOn}
              clusterOutlineOn={false}
              clusterAnnotationOn={false}
              clusterAnnotationModel={clusterAnnotationModel}
              clusterPreviewOn={false}
              transitionsEnabled={!disableTransitions}
              zoomSpeed={SPATIAL_SCROLL_ZOOM_SPEED}
            />
          </div>
          <div className="viewer-pane">
            <div className="viewer-label">UMAP</div>
            <Viewer
              key={`viewer-umap-${viewMode}`}
              {...rest}
              viewerId="umap"
              omeTiffFile={null}
              omeTiffUrl={null}
              points={pointsUMAP}
              hoverMaskEnabled={true}
              clusterColorOn={clusterColorOn}
              clusterOutlineOn={clusterOutlineOn}
              clusterAnnotationOn={clusterAnnotationOn}
              clusterAnnotationModel={clusterAnnotationModel}
              clusterPreviewOn={clusterPreviewOn}
              transitionsEnabled={!disableTransitions}
              zoomSpeed={UMAP_SCROLL_ZOOM_SPEED}
            />
          </div>
        </div>
      ) : (
        <div className="viewer-split">
          <div className="viewer-pane">
            <div className="viewer-label">{rest.useUMAP ? "UMAP" : "Spatial"}</div>
            <Viewer
              {...rest}
              viewerId="single"
              omeTiffUrl={rest.useUMAP ? null : rest.omeTiffUrl}
              omeTiffFile={rest.useUMAP ? null : rest.omeTiffFile}
              channelOmeIndexById={rest.channelOmeIndexById}
              points={rest.useUMAP ? pointsUMAP : pointsRaw}
              hoverMaskEnabled={!!rest.useUMAP}
              clusterColorOn={clusterColorOn}
              clusterOutlineOn={rest.useUMAP ? clusterOutlineOn : false}
              clusterAnnotationOn={rest.useUMAP ? clusterAnnotationOn : false}
              clusterAnnotationModel={clusterAnnotationModel}
              clusterPreviewOn={rest.useUMAP ? clusterPreviewOn : false}
              transitionsEnabled={!disableTransitions}
              zoomSpeed={
                rest.useUMAP
                  ? UMAP_SCROLL_ZOOM_SPEED
                  : SPATIAL_SCROLL_ZOOM_SPEED
              }
            />
          </div>
        </div>
      )}
      <Control {...dataLoader} viewMode={viewMode} setViewMode={setViewMode} />
    </div>
  );
}
