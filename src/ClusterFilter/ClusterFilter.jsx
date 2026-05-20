import React, { useEffect, useMemo, useRef, useState } from "react";
import { clusterColor } from "../utils/clustering";
import "./ClusterFilter.css";

export default function ClusterFilter({
  availableLabels = [],
  highlightedClusters = new Set(),
  setHighlightedClusters = () => {},
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const sortedLabels = useMemo(() => {
    if (!Array.isArray(availableLabels)) return [];
    return [...availableLabels].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  }, [availableLabels]);

  const selectedCount = highlightedClusters?.size ?? 0;
  const allSelected =
    sortedLabels.length > 0 && selectedCount === sortedLabels.length;

  useEffect(() => {
    const onDocClick = (e) => {
      if (!open) return;
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  const toggleLabel = (label) => {
    setHighlightedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const selectAll = () => {
    setHighlightedClusters(new Set(sortedLabels));
  };

  const clearAll = () => {
    setHighlightedClusters(new Set());
  };

  const buttonLabel =
    selectedCount === 0
      ? "Clusters"
      : allSelected
        ? "Clusters (all)"
        : `Clusters (${selectedCount})`;

  return (
    <div className="cluster-filter" ref={rootRef}>
      <button
        type="button"
        className="cluster-filter-btn"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || sortedLabels.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          sortedLabels.length === 0
            ? "Load data.csv to filter by clustering"
            : "Highlight clusters in Spatial and UMAP"
        }
      >
        {buttonLabel}
      </button>
      {open && sortedLabels.length > 0 && (
        <div className="cluster-filter-menu" role="listbox" aria-multiselectable="true">
          <div className="cluster-filter-actions">
            <button type="button" className="cluster-filter-action" onClick={selectAll}>
              Select all
            </button>
            <button type="button" className="cluster-filter-action" onClick={clearAll}>
              Clear
            </button>
          </div>
          <div className="cluster-filter-list">
            {sortedLabels.map((label) => {
              const checked = highlightedClusters.has(label);
              const rgb = clusterColor(label);
              return (
                <label key={label} className="cluster-filter-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleLabel(label)}
                  />
                  <span
                    className="cluster-filter-swatch"
                    style={{
                      backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
                    }}
                  />
                  <span className="cluster-filter-label-text">{label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
