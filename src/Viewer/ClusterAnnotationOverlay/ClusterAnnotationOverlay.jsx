import React, { useEffect, useRef, useState } from "react";
import ClusterLabelReviewModal from "./ClusterLabelReviewModal";
import useClusterLabelReviews, {
  isReviewConfirmed,
  normalizeReview,
  resolveAnnotationDisplay,
} from "./useClusterLabelReviews";
import "./ClusterAnnotationOverlay.css";

function ReviewBadgeContent({ status }) {
  if (status === "accepted") {
    return <span className="cluster-annotation-review-badge-mark">✓</span>;
  }
  if (status === "unsure") {
    return <span className="cluster-annotation-review-badge-mark">?</span>;
  }
  if (status === "corrected") {
    return <span className="cluster-annotation-review-badge-mark">✎</span>;
  }
  if (status === "rejected") {
    return <span className="cluster-annotation-review-badge-mark">✕</span>;
  }
  return (
    <svg
      className="cluster-annotation-review-badge-icon"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M12 5C7 5 2.73 8.11 1 12.5 2.73 16.89 7 20 12 20s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"
      />
    </svg>
  );
}

function reviewBadgeTitle(status) {
  if (status === "unsure") return "Review again (unsure)";
  if (status === "accepted") return "Change review (accepted)";
  if (status === "corrected") return "Change review (user corrected)";
  if (status === "rejected") return "Change review (rejected)";
  return "Review cluster label";
}

export default function ClusterAnnotationOverlay({
  annotations,
  viewStateZoom,
  altPressed,
  clusterColor,
  hoveredAnnotationLabel,
  setHoveredAnnotationLabel,
  descriptionRefs,
  cellTypeAnnotationOn = false,
  neighNamesAnnotationOn = false,
  levelKey = "0",
  clusterAnnotationModel = "MedGemma",
  reviewsEnabled = true,
  reviewMode = false,
}) {
  const { getReview, upsertReview } = useClusterLabelReviews(reviewsEnabled);
  const [modalAnn, setModalAnn] = useState(null);
  const modalAnnRef = useRef(null);
  modalAnnRef.current = modalAnn;

  // Reviews are per-model; closing avoids showing the wrong model's status in the modal.
  useEffect(() => {
    modalAnnRef.current = null;
    setModalAnn(null);
  }, [clusterAnnotationModel]);

  if (!annotations || annotations.length === 0) {
    return null;
  }

  const z = typeof viewStateZoom === "number" ? viewStateZoom : 8;
  const baseSize = 14;
  const scale = 1 + (z - 8) * 0.1;
  const size = Math.max(10, Math.min(32, baseSize * scale));
  const reviewGrayBg = "rgba(72, 72, 78, 0.88)";

  const buildEntry = (ann, status, userTitle = null, extra = {}) => ({
    status,
    llm_title: ann.title,
    llm_model: ann.model || clusterAnnotationModel,
    user_title: userTitle,
    llm_accuracy: extra.llmAccuracy ?? null,
    confidence: extra.confidence ?? null,
    reviewed_at: new Date().toISOString(),
  });

  const reviewModelFor = (ann) => ann?.model || clusterAnnotationModel;

  const modalReview = modalAnn
    ? normalizeReview(getReview(levelKey, modalAnn.label, reviewModelFor(modalAnn)))
    : null;
  const modalCurrentTitle = modalReview
    ? resolveAnnotationDisplay(modalAnn, modalReview).displayTitle
    : null;

  const openReview = (ann) => {
    modalAnnRef.current = ann;
    setModalAnn(ann);
  };

  const closeReview = () => {
    modalAnnRef.current = null;
    setModalAnn(null);
  };

  const saveReview = (status, userTitle = null, extra = {}) => {
    const ann = modalAnnRef.current;
    if (!ann) return Promise.reject(new Error("No cluster selected"));
    return upsertReview({
      levelKey,
      clusterId: ann.label,
      entry: buildEntry(ann, status, userTitle, extra),
    });
  };

  return (
    <>
      {annotations.map((ann) => {
        const { label, title, description, x, y, dominantCelltype, dominantNeighNames } = ann;
        if (!title) return null;
        const modelKey = reviewModelFor(ann);
        const review = getReview(levelKey, label, modelKey);
        const display = resolveAnnotationDisplay(ann, review);
        const rgb = clusterColor(label);
        const darkBg = [
          Math.round(rgb[0] * 0.6),
          Math.round(rgb[1] * 0.6),
          Math.round(rgb[2] * 0.6),
        ];
        const showCelltype =
          cellTypeAnnotationOn && dominantCelltype && dominantCelltype.trim();
        const showNeigh =
          neighNamesAnnotationOn && dominantNeighNames && dominantNeighNames.trim();
        const hasDominant = showCelltype || showNeigh;

        const confirmed = isReviewConfirmed(display.status);
        const useReviewGray = reviewMode && !confirmed;
        const labelBackground = useReviewGray
          ? reviewGrayBg
          : `rgba(${darkBg[0]},${darkBg[1]},${darkBg[2]},0.9)`;
        const titleClass = [
          "cluster-annotation-title-text",
          reviewMode && display.strikethrough ? "cluster-annotation-title-rejected" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <div
            key={`cluster-annotation-title-${label}-${modelKey}`}
            className="cluster-annotation-title"
            style={{
              left: x,
              top: y,
              pointerEvents: "none",
              zIndex: hoveredAnnotationLabel === label ? 100 : 10,
            }}
          >
            <div
              className="cluster-annotation-title-chip"
              style={{ pointerEvents: altPressed ? "auto" : "none" }}
              onMouseEnter={(e) => {
                if (altPressed || e.altKey) setHoveredAnnotationLabel(label);
              }}
              onMouseLeave={() =>
                setHoveredAnnotationLabel((cur) => (cur === label ? null : cur))
              }
            >
              <div
                className={titleClass}
                style={{
                  backgroundColor: labelBackground,
                  color: "#ffffff",
                  fontSize: `${size}px`,
                }}
              >
                {display.displayTitle}
              </div>
              {reviewMode && display.showEye && (
                <button
                  type="button"
                  className="cluster-annotation-review-badge"
                  style={{ pointerEvents: "auto" }}
                  title={reviewBadgeTitle(display.status)}
                  aria-label={`Review label for cluster ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openReview(ann);
                  }}
                >
                  <ReviewBadgeContent status={display.status} />
                </button>
              )}
            </div>
            {hasDominant && (
              <div
                className="cluster-annotation-dominant"
                style={{ fontSize: `${Math.max(9, size - 2)}px` }}
              >
                {showCelltype && <span>Cell type: {dominantCelltype}</span>}
                {showCelltype && showNeigh && " · "}
                {showNeigh && <span>Neigh: {dominantNeighNames}</span>}
              </div>
            )}
            {hoveredAnnotationLabel === label && description && altPressed && (
              <div
                className="deck-tooltip cluster-annotation-description"
                style={{ pointerEvents: "auto" }}
                ref={(el) => {
                  if (el) {
                    descriptionRefs.current[label] = el;
                  } else {
                    delete descriptionRefs.current[label];
                  }
                }}
                onMouseEnter={() => setHoveredAnnotationLabel(label)}
                onMouseLeave={() =>
                  setHoveredAnnotationLabel((cur) => (cur === label ? null : cur))
                }
                onWheel={(e) => {
                  const el = descriptionRefs.current[label];
                  if (el) {
                    el.scrollTop += e.deltaY;
                    e.preventDefault();
                  }
                }}
              >
                {description}
              </div>
            )}
          </div>
        );
      })}

      <ClusterLabelReviewModal
        open={Boolean(modalAnn)}
        onClose={closeReview}
        llmTitle={modalAnn?.title || ""}
        llmModel={modalAnn?.model || clusterAnnotationModel}
        description={modalAnn?.description || ""}
        currentTitle={modalCurrentTitle}
        reviewStatus={modalReview?.status || null}
        initialUserTitle={
          modalReview?.status === "corrected" ? modalReview.user_title || "" : ""
        }
        initialAccuracy={
          modalReview?.status === "corrected" || modalReview?.status === "rejected"
            ? modalReview?.llm_accuracy ?? null
            : null
        }
        initialConfidence={
          modalReview?.status === "unsure" ? modalReview?.confidence ?? null : null
        }
        onAccept={() => saveReview("accepted", null)}
        onUnsure={(confidence) => saveReview("unsure", null, { confidence })}
        onRejectConfirm={(userTitle, llmAccuracy) =>
          saveReview("corrected", userTitle, { llmAccuracy })
        }
      />
    </>
  );
}
