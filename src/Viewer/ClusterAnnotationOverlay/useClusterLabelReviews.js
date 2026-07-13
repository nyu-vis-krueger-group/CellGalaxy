import { useCallback, useEffect, useState } from "react";
import {
  fetchClusterLabelReviews,
  saveClusterLabelReview,
} from "../../api/api";

export function isReviewConfirmed(status) {
  return status === "accepted" || status === "corrected";
}

/** True when obj is a single review row (legacy v1 or leaf entry). */
export function isReviewEntry(obj) {
  return Boolean(obj && typeof obj === "object" && "status" in obj);
}

/**
 * Normalize levels[level][cluster] to { [model]: reviewEntry }.
 * Legacy v1 stored one review directly under the cluster id.
 */
export function modelsMapForCluster(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (isReviewEntry(raw)) {
    const model = raw.llm_model || "_legacy";
    return { [String(model)]: raw };
  }
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (isReviewEntry(val)) out[String(key)] = val;
  }
  return out;
}

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

export function lookupReview(reviews, levelKey, clusterId, model) {
  const lk = String(levelKey);
  const ck = String(clusterId);
  const mk = model != null && String(model).trim() !== "" ? String(model) : null;
  const raw = reviews?.levels?.[lk]?.[ck];
  if (!raw) return null;
  const byModel = modelsMapForCluster(raw);
  if (!mk) return null;
  return byModel[mk] ?? null;
}

export default function useClusterLabelReviews(enabled = false) {
  const [reviews, setReviews] = useState({ version: 2, levels: {} });

  useEffect(() => {
    if (!enabled) return undefined;
    const ac = new AbortController();
    (async () => {
      const data = await fetchClusterLabelReviews(ac.signal);
      if (!ac.signal.aborted) setReviews(data || { version: 2, levels: {} });
    })();
    return () => ac.abort();
  }, [enabled]);

  const getReview = useCallback(
    (levelKey, clusterId, model) =>
      lookupReview(reviews, levelKey, clusterId, model),
    [reviews],
  );

  const upsertReview = useCallback(async ({ levelKey, clusterId, entry }) => {
    const lk = String(levelKey);
    const ck = String(clusterId);
    const mk = String(entry?.llm_model || "").trim();
    if (!mk) {
      throw new Error("entry.llm_model is required");
    }

    const applyEntry = (e) => {
      setReviews((prev) => {
        const prevCluster = prev?.levels?.[lk]?.[ck];
        const modelMap = {
          ...modelsMapForCluster(prevCluster),
          [mk]: e,
        };
        return {
          ...prev,
          version: 2,
          levels: {
            ...(prev.levels || {}),
            [lk]: {
              ...((prev.levels || {})[lk] || {}),
              [ck]: modelMap,
            },
          },
        };
      });
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
          setReviews(data || { version: 2, levels: {} });
          throw e2;
        }
      }
      const ac = new AbortController();
      const data = await fetchClusterLabelReviews(ac.signal);
      setReviews(data || { version: 2, levels: {} });
      throw e;
    }
  }, []);

  return { reviews, getReview, upsertReview };
}
