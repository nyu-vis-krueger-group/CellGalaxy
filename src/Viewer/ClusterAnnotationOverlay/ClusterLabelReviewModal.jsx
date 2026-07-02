import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./ClusterLabelReviewModal.css";

export default function ClusterLabelReviewModal({
  open,
  onClose,
  llmTitle = "",
  llmModel = "",
  description = "",
  currentTitle = null,
  reviewStatus = null,
  initialUserTitle = "",
  onAccept,
  onUnsure,
  onRejectConfirm,
}) {
  const [step, setStep] = useState("actions");
  const [userTitle, setUserTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragState = useRef(null);

  useEffect(() => {
    if (open) {
      setStep("actions");
      setUserTitle(initialUserTitle || "");
      setSaving(false);
      setSaveError(null);
      setOffset({ x: 0, y: 0 });
    }
  }, [open, llmTitle, initialUserTitle]);

  const openRejectStep = () => {
    const seed =
      initialUserTitle?.trim() ||
      (currentTitle && currentTitle !== llmTitle ? currentTitle : "");
    setUserTitle(seed);
    setStep("reject");
  };

  const onHeaderPointerDown = useCallback(
    (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: offset.x,
        origY: offset.y,
      };
      const onMove = (ev) => {
        if (!dragState.current) return;
        setOffset({
          x: dragState.current.origX + (ev.clientX - dragState.current.startX),
          y: dragState.current.origY + (ev.clientY - dragState.current.startY),
        });
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [offset.x, offset.y],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  if (!open) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && !saving) onClose();
  };

  const run = async (fn) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setSaveError(err?.message || "Failed to save review");
    } finally {
      setSaving(false);
    }
  };

  const modal = (
    <div
      className="cluster-review-modal-backdrop"
      role="presentation"
      onClick={handleBackdrop}
    >
      <div
        className="cluster-review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cluster-review-modal-title"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="cluster-review-modal-header"
          onPointerDown={onHeaderPointerDown}
        >
          <h3 id="cluster-review-modal-title">Review cluster label</h3>
          <button
            type="button"
            className="cluster-review-modal-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {step === "actions" && (
          <>
            <div className="cluster-review-modal-body">
              {reviewStatus && (
                <div className={`cluster-review-status-badge cluster-review-status-${reviewStatus}`}>
                  Current: {reviewStatus}
                </div>
              )}
              {currentTitle && currentTitle !== llmTitle && (
                <div className="cluster-review-modal-current">
                  <div className="cluster-review-modal-meta">Displayed label</div>
                  <div className="cluster-review-modal-llm-title cluster-review-modal-llm-title-full">
                    &ldquo;{currentTitle}&rdquo;
                  </div>
                </div>
              )}
              {llmModel && (
                <div className="cluster-review-modal-meta">
                  LLM suggestion ({llmModel})
                </div>
              )}
              <div className="cluster-review-modal-llm-title cluster-review-modal-llm-title-full">
                &ldquo;{llmTitle}&rdquo;
              </div>
              {description && (
                <div className="cluster-review-modal-description">{description}</div>
              )}
            </div>
            <div className="cluster-review-modal-actions">
              {saveError && (
                <div className="cluster-review-save-error" role="alert">
                  {saveError}
                </div>
              )}
              <button
                type="button"
                className="cluster-review-btn cluster-review-btn-accept"
                disabled={saving}
                onClick={() => run(onAccept)}
              >
                Accept
              </button>
              <button
                type="button"
                className="cluster-review-btn cluster-review-btn-reject"
                disabled={saving}
                onClick={openRejectStep}
              >
                Reject
              </button>
              <button
                type="button"
                className="cluster-review-btn cluster-review-btn-unsure"
                disabled={saving}
                onClick={() => run(onUnsure)}
              >
                Unsure
              </button>
            </div>
          </>
        )}

        {step === "reject" && (
          <>
            <div className="cluster-review-modal-body">
              <div className="cluster-review-modal-meta">Rejected LLM label</div>
              <div className="cluster-review-modal-llm-title cluster-review-modal-llm-title-full cluster-review-modal-llm-title-rejected">
                &ldquo;{llmTitle}&rdquo;
              </div>
              <label className="cluster-review-input-label" htmlFor="cluster-review-user-title">
                Your label
              </label>
              <textarea
                id="cluster-review-user-title"
                className="cluster-review-textarea"
                value={userTitle}
                onChange={(e) => setUserTitle(e.target.value)}
                placeholder="Enter the correct cluster label"
                rows={3}
                autoFocus
              />
            </div>
            <div className="cluster-review-modal-actions">
              {saveError && (
                <div className="cluster-review-save-error" role="alert">
                  {saveError}
                </div>
              )}
              <button
                type="button"
                className="cluster-review-btn cluster-review-btn-back"
                disabled={saving}
                onClick={() => setStep("actions")}
              >
                Back
              </button>
              <button
                type="button"
                className="cluster-review-btn cluster-review-btn-confirm"
                disabled={saving || !userTitle.trim()}
                onClick={() => run(() => onRejectConfirm(userTitle.trim()))}
              >
                Confirm
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
