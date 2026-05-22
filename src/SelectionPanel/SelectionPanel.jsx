import React from "react";
import { SELECTION_NONE, SELECTION_BOX, SELECTION_LASSO } from "../constants/selection";
import "./SelectionPanel.css";

export default function SelectionPanel({
  selectionMode = "none",
  setSelectionMode = () => {},
  selectedIds = new Set(),
}) {
  const selectedCount = selectedIds.size ?? 0;

  return (
    <div className="selection-panel">
      <div className="selection-panel-title">
        <span>Selection</span>
        <span className="selection-count-inline">
          Selected: <b>{selectedCount}</b> points
        </span>
      </div>
      
      <div className="selection-mode-buttons">
        <button
          className={`selection-mode-btn ${selectionMode === SELECTION_NONE ? "active" : ""}`}
          onClick={() => setSelectionMode(SELECTION_NONE)}
          title="No selection mode"
        >
          <img src="/icons/none.svg" alt="None" />
        </button>
        <button
          className={`selection-mode-btn ${selectionMode === SELECTION_BOX ? "active" : ""}`}
          onClick={() => setSelectionMode(SELECTION_BOX)}
          title="Drag a rectangle; returns to pan/zoom when done (Shift: draw two for compare)"
        >
          <img src="/icons/box.svg" alt="Box" />
        </button>
        <button
          className={`selection-mode-btn ${selectionMode === SELECTION_LASSO ? "active" : ""}`}
          onClick={() => setSelectionMode(SELECTION_LASSO)}
          title="Drag a lasso; returns to pan/zoom when done (Shift: draw two for compare)"
        >
          <img src="/icons/lasso.svg" alt="Lasso" />
        </button>
      </div>

      
    </div>
  );
}
