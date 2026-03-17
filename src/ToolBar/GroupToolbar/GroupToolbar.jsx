import React from "react";
import "./GroupToolbar.css";
import { ANALYSIS_COMPARE } from "../../constants/analysis";

export default function GroupToolbar({
  show,
  mode,
  onAnalyze = () => {},
  onClear = () => {},
  hasRawAnnotationColumns = false,
  onShowAnnotationStats = () => {},
  onZoomToSelection,
  onRestoreView,
  isZoomedToSelection = false,
}) {
  if (!show) return null;
  const isCompare = mode === ANALYSIS_COMPARE;
  const icon = isCompare ? "compare_arrows" : "analytics";
  const title = isCompare ? "Compare two regions" : "Group analysis";
  const canZoomToSelection =
    !isCompare &&
    typeof onZoomToSelection === "function" &&
    typeof onRestoreView === "function";
  return (
    <div className={`group-toolbar${isCompare ? " compare" : ""}`}>
      {canZoomToSelection && (
        <>
          <button
            className="gtb-btn"
            title={isZoomedToSelection ? "Restore view" : "Zoom to selection"}
            onClick={isZoomedToSelection ? onRestoreView : onZoomToSelection}
          >
            <span className="material-icons">{isZoomedToSelection ? "fullscreen_exit" : "zoom_in"}</span>
          </button>
          <div className="gtb-divider" />
        </>
      )}
      <button className="gtb-btn" title={title} onClick={onAnalyze}>
        <span className="material-icons">{icon}</span>
      </button>
      {hasRawAnnotationColumns && (
        <>
          <div className="gtb-divider" />
          <button
            className="gtb-btn"
            title="Cell type & Neigh names statistics"
            onClick={onShowAnnotationStats}
          >
            <span className="material-icons">bar_chart</span>
          </button>
        </>
      )}
      <div className="gtb-divider" />
      <button className="gtb-btn gtb-close" title="clear selection" onClick={onClear}>
        <span className="material-icons">close</span>
      </button>
    </div>
  );
}

