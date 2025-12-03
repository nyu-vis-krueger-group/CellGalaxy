import React from "react";
import "./GroupToolbar.css";
import { ANALYSIS_COMPARE } from "../../constants/analysis";

export default function GroupToolbar({ show, mode, onAnalyze = () => {}, onClear = () => {} }) {
  if (!show) return null;
  const isCompare = mode === ANALYSIS_COMPARE;
  const icon = isCompare ? "compare_arrows" : "analytics";
  const title = isCompare ? "Compare two regions" : "Group analysis";
  return (
    <div className={`group-toolbar${isCompare ? " compare" : ""}`}>
      <button className="gtb-btn" title={title} onClick={onAnalyze}>
        <span className="material-icons">{icon}</span>
      </button>
      <div className="gtb-divider" />
      <button className="gtb-btn gtb-close" title="clear selection" onClick={onClear}>
        <span className="material-icons">close</span>
      </button>
    </div>
  );
}

