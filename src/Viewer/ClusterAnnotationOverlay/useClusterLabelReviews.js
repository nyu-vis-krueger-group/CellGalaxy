import { useCallback, useEffect, useState } from "react";
import {
  fetchClusterLabelReviews,
  saveClusterLabelReview,
} from "../../api/api";

/** Legacy rows: accepted + user_title → corrected */
export function normalizeReview(review) {
  if (!review) return null;
  if (
    review.status === "accepted" &&
    review.user_title != null &&
    String(review.user_title).trim()
  ) {
    return { ...review, status: "corrected" };
  }
  return review;
}

export function resolveAnnotationDisplay(ann, review) {
  const llmTitle = ann?.title || "";
  const r = normalizeReview(review);

  if (!r) {
    return {
      displayTitle: llmTitle,
      showEye: true,
      status: null,
      strikethrough: false,
      showCheck: false,
      showUnsure: false,
      showCorrected: false,
    };
  }

  if (r.status === "accepted") {
    return {
      displayTitle: llmTitle,
      showEye: true,
      status: "accepted",
      strikethrough: false,
      showCheck: true,
      showUnsure: false,
      showCorrected: false,
    };
  }

  if (r.status === "corrected") {
    return {
      displayTitle: r.user_title || llmTitle,
      showEye: true,
      status: "corrected",
      strikethrough: false,
      showCheck: false,
      showUnsure: false,
      showCorrected: true,
    };
  }

  if (r.status === "unsure") {
    return {
      displayTitle: llmTitle,
      showEye: true,
      status: "unsure",
      strikethrough: false,
      showCheck: false,
      showUnsure: true,
      showCorrected: false,
    };
  }

  if (r.status === "rejected") {
    return {
      displayTitle: llmTitle,
      showEye: true,
      status: "rejected",
      strikethrough: true,
      showCheck: false,
      showUnsure: false,
      showCorrected: false,
    };
  }

  return {
    displayTitle: llmTitle,
    showEye: true,
    status: null,
    strikethrough: false,
    showCheck: false,
    showUnsure: false,
    showCorrected: false,
  };
}

export default function useClusterLabelReviews(enabled = false) {
  const [reviews, setReviews] = useState({ version: 1, levels: {} });

  useEffect(() => {
    if (!enabled) return undefined;
    const ac = new AbortController();
    (async () => {
      const data = await fetchClusterLabelReviews(ac.signal);
      if (!ac.signal.aborted) setReviews(data || { version: 1, levels: {} });
    })();
    return () => ac.abort();
  }, [enabled]);

  const getReview = useCallback(
    (levelKey, clusterId) => {
      const lk = String(levelKey);
      const ck = String(clusterId);
      return reviews?.levels?.[lk]?.[ck] ?? null;
    },
    [reviews],
  );

  const upsertReview = useCallback(async ({ levelKey, clusterId, entry }) => {
    const lk = String(levelKey);
    const ck = String(clusterId);

    const applyEntry = (e) => {
      setReviews((prev) => ({
        ...prev,
        levels: {
          ...(prev.levels || {}),
          [lk]: {
            ...((prev.levels || {})[lk] || {}),
            [ck]: e,
          },
        },
      }));
    };

    applyEntry(entry);

    const persist = async (e) => {
      await saveClusterLabelReview({
        level: levelKey,
        clusterId,
        entry: e,
      });
    };

    try {
      await persist(entry);
    } catch (e) {
      // Back-compat: older backend only allows accepted/rejected/unsure
      if (entry?.status === "corrected" && entry?.user_title) {
        const fallback = { ...entry, status: "accepted" };
        applyEntry(fallback);
        try {
          await persist(fallback);
          return;
        } catch (e2) {
          const ac = new AbortController();
          const data = await fetchClusterLabelReviews(ac.signal);
          setReviews(data || { version: 1, levels: {} });
          throw e2;
        }
      }
      const ac = new AbortController();
      const data = await fetchClusterLabelReviews(ac.signal);
      setReviews(data || { version: 1, levels: {} });
      throw e;
    }
  }, []);

  return { reviews, getReview, upsertReview };
}
