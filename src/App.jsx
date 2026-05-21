import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VIEW_SINGLE } from "./constants/view";
import {
  SPATIAL_SCROLL_ZOOM_SPEED,
  UMAP_SCROLL_ZOOM_SPEED,
} from "./constants/render";
import useDataLoader from "./DataLoader/DataLoader";
import Viewer from "./Viewer/Viewer";
import Control from "./Control/Control";
import { UploadBusyProvider } from "./UploadBusy/UploadBusyProvider";
import "./App.css";

const SPLIT_RATIO_MIN = 0.15;
const SPLIT_RATIO_MAX = 0.85;
const SPLIT_RATIO_DEFAULT = 0.5;

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
  const [viewMode, setViewMode] = useState(VIEW_SINGLE);
  const [splitRatio, setSplitRatio] = useState(SPLIT_RATIO_DEFAULT);
  const splitRef = useRef(null);
  const splitPreviewRef = useRef(null);
  const splitDraggingRef = useRef(false);

  const applySplitColumns = useCallback((ratio, el = splitRef.current) => {
    if (!el) return;
    const r = Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
    el.style.gridTemplateColumns = `minmax(0, ${r}fr) 8px minmax(0, ${1 - r}fr)`;
    return r;
  }, []);

  const ratioFromClientX = useCallback((clientX) => {
    const el = splitRef.current;
    if (!el) return splitRatio;
    const { left, width } = el.getBoundingClientRect();
    if (width <= 0) return splitRatio;
    return Math.min(
      SPLIT_RATIO_MAX,
      Math.max(SPLIT_RATIO_MIN, (clientX - left) / width),
    );
  }, [splitRatio]);

  const showSplitPreview = useCallback((clientX) => {
    const el = splitRef.current;
    const preview = splitPreviewRef.current;
    if (!el || !preview) return;
    const { left, width } = el.getBoundingClientRect();
    if (width <= 0) return;
    const ratio = ratioFromClientX(clientX);
    preview.style.left = `${ratio * width}px`;
    preview.style.display = "block";
  }, [ratioFromClientX]);

  const hideSplitPreview = useCallback(() => {
    const preview = splitPreviewRef.current;
    if (!preview) return;
    preview.style.display = "none";
  }, []);

  const onSplitHandleMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      splitDraggingRef.current = true;
      splitRef.current?.classList.add("viewer-split--dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      showSplitPreview(e.clientX);
    },
    [showSplitPreview],
  );

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!splitDraggingRef.current) return;
      showSplitPreview(e.clientX);
    };
    const endDrag = (e) => {
      if (!splitDraggingRef.current) return;
      splitDraggingRef.current = false;
      splitRef.current?.classList.remove("viewer-split--dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      hideSplitPreview();
      setSplitRatio(ratioFromClientX(e.clientX));
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", endDrag);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", endDrag);
    };
  }, [showSplitPreview, hideSplitPreview, ratioFromClientX]);

  const [disableTransitions, setDisableTransitions] = useState(false);
  useEffect(() => {
    setDisableTransitions(true);
    const t = setTimeout(() => setDisableTransitions(false), 200);
    return () => clearTimeout(t);
  }, [viewMode]);

  useLayoutEffect(() => {
    if (viewMode !== "dual") return;
    applySplitColumns(splitRatio);
  }, [viewMode, splitRatio, applySplitColumns]);

  return (
    <UploadBusyProvider>
    <div className="app-container">
      {viewMode === "dual" ? (
        <div className="viewer-split" ref={splitRef}>
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
          <div
            className="viewer-split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(splitRatio * 100)}
            aria-valuemin={SPLIT_RATIO_MIN * 100}
            aria-valuemax={SPLIT_RATIO_MAX * 100}
            aria-label="调整 Spatial 与 UMAP 视图宽度"
            onMouseDown={onSplitHandleMouseDown}
          />
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
          <div
            ref={splitPreviewRef}
            className="viewer-split-preview"
            aria-hidden="true"
          />
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
    </UploadBusyProvider>
  );
}
