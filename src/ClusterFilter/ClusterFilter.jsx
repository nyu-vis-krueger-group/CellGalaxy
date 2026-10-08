import React, { useEffect, useMemo, useRef, useState } from "react";
import { clusterColor } from "../utils/clustering";
import "./ClusterFilter.css";

const NAMES_STORAGE_KEY = "cellgalaxy.clusteringNames";

function loadStoredNames() {
  try {
    const raw = localStorage.getItem(NAMES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export default function ClusterFilter({
  availableLabels = [],
  highlightedClusters = new Set(),
  setHighlightedClusters = () => {},
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState(() => loadStoredNames());
  const [menuStyle, setMenuStyle] = useState(null);
  const rootRef = useRef(null);
  const btnRef = useRef(null);

  const placeMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 280;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setMenuStyle({ top: rect.bottom + 6, left, width });
  };

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

  useEffect(() => {
    if (!open) return undefined;
    placeMenu();
    const onReflow = () => placeMenu();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
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

  const updateName = (label, value) => {
    const key = String(label);
    setNames((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(NAMES_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Export still uses in-memory names if storage is unavailable.
      }
      return next;
    });
  };

  const exportNames = () => {
    const lines = [
      "clustering,name",
      ...sortedLabels.map((id) => {
        const name = (names[String(id)] ?? "").trim();
        return `${id},${csvEscape(name)}`;
      }),
    ];
    const csv = `\uFEFF${lines.join("\n")}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cluster_names.csv";
    a.addEventListener("click", (event) => event.stopPropagation());
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        ref={btnRef}
        type="button"
        className="cluster-filter-btn"
        onClick={() => {
          if (!open) placeMenu();
          setOpen((v) => !v);
        }}
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
        <div
          className="cluster-filter-menu"
          role="listbox"
          aria-multiselectable="true"
          style={menuStyle || undefined}
        >
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
                <div key={label} className="cluster-filter-item">
                  <label className="cluster-filter-check">
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
                    <span className="cluster-filter-id">{label}</span>
                  </label>
                  <input
                    className="cluster-filter-name"
                    value={names[String(label)] ?? ""}
                    placeholder="name"
                    aria-label={`Name for cluster ${label}`}
                    onChange={(e) => updateName(label, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="cluster-filter-footer">
            <button type="button" className="cluster-filter-action" onClick={exportNames}>
              Export
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
