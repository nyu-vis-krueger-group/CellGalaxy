import React, { useState } from "react";
import "./ClusteringControl.css";
import { runLLMClusterChannelAvg, runLLMGenerateClusterLabels } from "../api/api";

export default function ClusteringControl({
  outlineOn = false,
  setOutlineOn = () => {},
  setLineWidth = () => {},
  annotationOn = false,
  setAnnotationOn = () => {},
  annotationModel = "MedGemma",
  setAnnotationModel = () => {},
  previewOn = true,
  setPreviewOn = () => {},
}) {
  const [showModelPanel, setShowModelPanel] = useState(false);
  const [selectedModel, setSelectedModel] = useState(annotationModel || "Biomni");
  const [isLLMRunning, setIsLLMRunning] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  return (
    <div className="clu-block">
      <div className="clu-title">Visual Encoding </div>
      <div className="clu-buttons">
        <button
          className={`clu-btn ${outlineOn ? "on" : ""}`}
          onClick={() => {
            const next = !outlineOn;
            setOutlineOn(next);
            if (next) setLineWidth(0.8);
          }}
          title="outline for each clustering"
        >
          {/* outline icon */}
          <svg
            className="icon icon-outline"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.5"/>
            <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.5" opacity="0.6"/>
          </svg>
        </button>
        {/* New: Large Model trigger button (runs the whole pipeline: precompute -> multi-model annotate) */}
        {/* Cluster preview toggle: control whether representative images are shown on UMAP */}
        <button
          className={`clu-btn preview ${previewOn ? "on" : ""}`}
          onClick={() => setPreviewOn(!previewOn)}
          title="show representative image for each cluster"
        >
          {/* preview icon (mini image tile) */}
          <svg
            className="icon icon-preview"
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="2.5" y="2.5" width="15" height="15" rx="3" stroke="currentColor" opacity="0.6" />
            <rect x="5" y="6" width="4.5" height="4.5" rx="1" fill="currentColor" opacity="0.85" />
            <rect x="10.5" y="5" width="3.5" height="3.5" rx="1" fill="currentColor" opacity="0.55" />
            <rect x="9" y="10.5" width="4.5" height="4.5" rx="1" fill="currentColor" opacity="0.35" />
          </svg>
        </button>
        {/* New: Large Model trigger button (runs the whole pipeline: precompute -> multi-model annotate) */}
        <button
          className="clu-btn model"
          onClick={() => {
            if (isLLMRunning) return;
            setIsLLMRunning(true);
            const ac = new AbortController();
            runLLMClusterChannelAvg(ac.signal)
              .then(() => {
                const ac2 = new AbortController();
                return runLLMGenerateClusterLabels({ top_k: 6, models: ["Biomni","MedGemma","BioMistral"] }, ac2.signal);
              })
              .catch(() => ({}))
              .finally(() => {
                setIsLLMRunning(false);
              });
          }}
          title="run large model from scratch"
        >
          {/* model icon (robot head) */}
          <svg
            className="icon icon-model"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="4" y="6.5" width="16" height="11" rx="4" stroke="currentColor" strokeWidth="1.5"/>
            <circle cx="9" cy="12" r="1.75" fill="currentColor" />
            <circle cx="15" cy="12" r="1.75" fill="currentColor" />
            <path d="M12 6.5V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        <button
          className={`clu-btn annotate ${showModelPanel ? "on" : ""}`}
          onClick={() =>
            setShowModelPanel((v) => {
              const next = !v;
              if (next) {
                if (selectedModel) {
                  setAnnotationModel(selectedModel);
                  setAnnotationOn(true);
                }
              } else {
                setAnnotationOn(false);
              }
              return next;
            })
          }
          title="open annotation panel"
        >
          {/* annotation icon (chat bubble with dots) */}
          <svg
            className="icon icon-annotate"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="3.5" y="5" width="17" height="12" rx="3.5" stroke="currentColor" strokeWidth="1.5"/>
            <circle cx="9" cy="11" r="1.25" fill="currentColor"/>
            <circle cx="12" cy="11" r="1.25" fill="currentColor" opacity="0.9"/>
            <circle cx="15" cy="11" r="1.25" fill="currentColor" opacity="0.8"/>
            <path d="M8 17.5l-2.5 3v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
      {isLLMRunning && <div className="clu-tip">Running...</div>}
      {showModelPanel && (
        <div className="clu-panel">
          <div className="clu-row">
            <div className="clu-label">Model</div>
            <div className="clu-select-wrap">
              <div
                className={`clu-select-display ${modelMenuOpen ? "open" : ""}`}
                tabIndex={0}
                onClick={() => setModelMenuOpen((v) => !v)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) {
                    setModelMenuOpen(false);
                  }
                }}
              >
                <span className="clu-select-display-label">{selectedModel}</span>
                <span className="clu-select-display-caret">▾</span>
                {modelMenuOpen && (
                  <div className="clu-select-menu">
                    {["MedGemma", "BioMistral"].map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`clu-select-option ${selectedModel === m ? "active" : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setSelectedModel(m);
                          setAnnotationModel(m);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span className="clu-select-option-check">
                          {selectedModel === m ? "✓" : ""}
                        </span>
                        <span>{m}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
