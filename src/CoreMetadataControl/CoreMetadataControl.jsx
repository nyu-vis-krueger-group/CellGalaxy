import React, { useState, useRef, useEffect } from "react";
import "./CoreMetadataControl.css";

function displayLabel(selectedFields) {
  if (!selectedFields.length) return "Select fields…";
  if (selectedFields.length === 1) return selectedFields[0];
  return `${selectedFields.length} selected`;
}

export default function CoreMetadataControl({
  active = false,
  textColumns = [],
  selectedFields = [],
  setSelectedFields = () => {},
  omeTiffSpatialActive = false,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocMouseDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [menuOpen]);

  if (!active || !textColumns.length) return null;

  const selectedSet = new Set(selectedFields);

  const toggleField = (field) => {
    setSelectedFields((prev) => {
      const set = new Set(prev);
      if (set.has(field)) set.delete(field);
      else set.add(field);
      return Array.from(set);
    });
  };

  return (
    <div className="core-meta-block">
      <div className="core-meta-title">Core metadata</div>
      {!omeTiffSpatialActive && (
        <div className="core-meta-tip core-meta-tip--warn">
          Load OME-TIFF for spatial labels.
        </div>
      )}
      <div className="core-meta-select-wrap" ref={wrapRef}>
        <button
          type="button"
          className={`core-meta-select-display ${menuOpen ? "open" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="listbox"
        >
          <span className="core-meta-select-label">{displayLabel(selectedFields)}</span>
          <span className="core-meta-select-caret">▾</span>
        </button>
        {menuOpen && (
          <div className="core-meta-select-menu" role="listbox" aria-multiselectable="true">
            {textColumns.map((field) => (
              <label key={field} className="core-meta-select-option">
                <input
                  type="checkbox"
                  checked={selectedSet.has(field)}
                  onChange={() => toggleField(field)}
                />
                <span>{field}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
