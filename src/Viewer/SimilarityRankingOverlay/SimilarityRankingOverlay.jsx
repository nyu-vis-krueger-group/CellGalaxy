import React from "react";
import "./SimilarityRankingOverlay.css";

export default function SimilarityRankingOverlay({ items }) {
  if (!items || items.length === 0) return null;

  return items.map((item) => {
    const { id, x, y, rank } = item;
    const isQuery = rank === 0;
    return (
      <div
        key={`similarity-rank-${id}`}
        className="similarity-ranking-overlay"
        style={{
          left: x,
          top: y,
        }}
      >
        <div
          className={`similarity-ranking-label ${
            isQuery ? "query" : "neighbor"
          }`}
        >
          {isQuery ? "Q" : rank}
        </div>
      </div>
    );
  });
}


