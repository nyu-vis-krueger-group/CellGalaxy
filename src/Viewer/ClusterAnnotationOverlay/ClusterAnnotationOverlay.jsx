import React, { useRef, useState } from "react";
import ClusterLabelReviewModal from "./ClusterLabelReviewModal";
import useClusterLabelReviews, {
  normalizeReview,
  resolveAnnotationDisplay,
} from "./useClusterLabelReviews";
import "./ClusterAnnotationOverlay.css";

function ReviewEyeIcon() {
  return (
    <svg
      className="cluster-annotation-review-eye-icon"
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
}) {
  const { getReview, upsertReview } = useClusterLabelReviews(reviewsEnabled);
  const [modalAnn, setModalAnn] = useState(null);
  const modalAnnRef = useRef(null);
  modalAnnRef.current = modalAnn;

  if (!annotations || annotations.length === 0) {
    return null;
  }

  const z = typeof viewStateZoom === "number" ? viewStateZoom : 8;
  const baseSize = 14;
  const scale = 1 + (z - 8) * 0.1;
  const size = Math.max(10, Math.min(32, baseSize * scale));

  const buildEntry = (ann, status, userTitle = null) => ({
    status,
    llm_title: ann.title,
    llm_model: ann.model || clusterAnnotationModel,
    user_title: userTitle,
    reviewed_at: new Date().toISOString(),
  });

  const modalReview = modalAnn ? normalizeReview(getReview(levelKey, modalAnn.label)) : null;
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

  const saveReview = (status, userTitle = null) => {
    const ann = modalAnnRef.current;
    if (!ann) return Promise.reject(new Error("No cluster selected"));
    return upsertReview({
      levelKey,
      clusterId: ann.label,
      entry: buildEntry(ann, status, userTitle),
    });
  };

  return (
    <>
      {annotations.map((ann) => {
        const { label, title, description, x, y, dominantCelltype, dominantNeighNames } = ann;
        if (!title) return null;
        const review = getReview(levelKey, label);
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

        const titleClass = [
          "cluster-annotation-title-text",
          display.status === "unsure" ? "cluster-annotation-title-unsure" : "",
          display.status === "corrected" ? "cluster-annotation-title-corrected" : "",
          display.strikethrough ? "cluster-annotation-title-rejected" : "",
          display.showCheck ? "cluster-annotation-title-accepted" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <div
            key={`cluster-annotation-title-${label}`}
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
                  backgroundColor: `rgba(${darkBg[0]},${darkBg[1]},${darkBg[2]},0.9)`,
                  color: "#ffffff",
                  fontSize: `${size}px`,
                }}
              >
                {display.displayTitle}
                {display.showCheck && (
                  <span className="cluster-annotation-check" aria-hidden="true" title="Accepted">
                    ✓
                  </span>
                )}
                {display.showUnsure && (
                  <span className="cluster-annotation-unsure-mark" aria-hidden="true" title="Unsure">
                    ?
                  </span>
                )}
                {display.showCorrected && (
                  <span className="cluster-annotation-corrected-mark" aria-hidden="true" title="User corrected">
                    ✎
                  </span>
                )}
              </div>
              {display.showEye && (
                <button
                  type="button"
                  className={[
                    "cluster-annotation-review-eye",
                    display.status === "unsure" ? "cluster-annotation-review-eye-unsure" : "",
                    display.status === "accepted" ? "cluster-annotation-review-eye-accepted" : "",
                    display.status === "corrected" ? "cluster-annotation-review-eye-corrected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ pointerEvents: "auto" }}
                  title={
                    display.status === "unsure"
                      ? "Review again (unsure)"
                      : display.status === "accepted"
                        ? "Change review (accepted)"
                        : display.status === "corrected"
                          ? "Change review (user corrected)"
                          : "Review cluster label"
                  }
                  aria-label={`Review label for cluster ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openReview(ann);
                  }}
                >
                  <ReviewEyeIcon />
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
        onAccept={() => saveReview("accepted", null)}
        onUnsure={() => saveReview("unsure", null)}
        onRejectConfirm={(userTitle) => saveReview("corrected", userTitle)}
      />
    </>
  );
}
