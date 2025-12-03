import os
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

from .config import DATA_DIR

router = APIRouter()

_FEAT_RAW: np.ndarray | None = None
_FEAT_NORM: np.ndarray | None = None
_FEAT_CENTERED_NORM: np.ndarray | None = None
_FEAT_PATH = os.path.join(DATA_DIR, "features.npy")
_CSV_PATH = os.path.join(DATA_DIR, "data.csv")
_GLOBAL_HIST: Dict[str, object] | None = None
_PCTL_CACHE: Dict[str, object] | None = None
_GLOBAL_CENTER: np.ndarray | None = None
_GLOBAL_DIFFS_SORTED: np.ndarray | None = None
_GLOBAL_CENTER: np.ndarray | None = None
_GLOBAL_DIFFS_SORTED: np.ndarray | None = None
_UMAP2: np.ndarray | None = None


def _ensure_features() -> Tuple[np.ndarray, np.ndarray]:
    """Load features and a L2-normalized copy, cached in memory."""
    global _FEAT_RAW, _FEAT_NORM
    if _FEAT_RAW is None:
        if not os.path.exists(_FEAT_PATH):
            raise FileNotFoundError("features.npy not found. Please upload features first.")
        feats = np.load(_FEAT_PATH)
        if feats.ndim != 2:
            raise ValueError(f"features.npy must be 2D (N,D), got shape {feats.shape}")
        # sanitize NaN/Inf → 0 to avoid propagating invalid numbers
        feats = feats.astype(np.float32, copy=False)
        feats = np.where(np.isfinite(feats), feats, 0.0)
        _FEAT_RAW = feats
        # L2 normalize row-wise, avoid zero division
        norm = np.linalg.norm(_FEAT_RAW, axis=1, keepdims=True)
        norm[norm == 0] = 1.0
        _FEAT_NORM = _FEAT_RAW / norm
    return _FEAT_RAW, _FEAT_NORM  # type: ignore


def _get_repr(metric: str) -> np.ndarray:
    """
    Return feature representation for similarity computation.
    metric:
      - 'cosine'           : unit-normalized rows (default)
      - 'cosine_centered'  : subtract global mean (on normalized feats) and re-normalize rows
    """
    global _FEAT_CENTERED_NORM
    _, feats_n = _ensure_features()
    if metric == "cosine":
        return feats_n
    if metric == "cosine_centered":
        if _FEAT_CENTERED_NORM is None:
            mean_vec = feats_n.mean(axis=0, keepdims=True)
            centered = feats_n - mean_vec
            norms = np.linalg.norm(centered, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            _FEAT_CENTERED_NORM = centered / norms
        return _FEAT_CENTERED_NORM
    # fallback
    return feats_n


def _ensure_umap2() -> np.ndarray:
    """
    Load / cache the 2D UMAP coordinates used for neighbor selection.
    This aligns the neighbor topology with what the user sees on the UMAP plot.
    """
    global _UMAP2
    if _UMAP2 is not None:
        return _UMAP2
    if not os.path.exists(_CSV_PATH):
        raise FileNotFoundError("data.csv not found. UMAP-based neighbors require umap2_x/umap2_y.")
    df = pd.read_csv(_CSV_PATH)
    if "umap2_x" not in df.columns or "umap2_y" not in df.columns:
        raise ValueError("data.csv must contain 'umap2_x' and 'umap2_y' columns for UMAP-based neighbors.")
    umap = df[["umap2_x", "umap2_y"]].to_numpy(dtype=np.float32, copy=False)
    _UMAP2 = umap
    return _UMAP2


def _topk_cosine(idx: int, k: int, metric: str = "cosine") -> Tuple[np.ndarray, np.ndarray]:
    """Return neighbor indices and similarities (exclude self)."""
    feats, feats_n = _ensure_features()
    feats_n = _get_repr(metric)
    n = feats_n.shape[0]
    if not (0 <= idx < n):
        raise IndexError(f"Index out of range: {idx} (0..{n-1})")
    k_eff = max(1, min(int(k), n - 1))
    q = feats_n[idx]
    sims = (feats_n @ q).astype(np.float32)  # cosine similarity with normalized vectors
    # numeric clip to [-1,1]
    np.clip(sims, -1.0, 1.0, out=sims)
    sims[idx] = -np.inf
    # partial top-k
    if k_eff < n - 1:
        part_idx = np.argpartition(-sims, k_eff)[:k_eff]
        # sort those k by value
        order = np.argsort(-sims[part_idx])
        neigh = part_idx[order]
    else:
        neigh = np.argsort(-sims)
    return neigh[:k_eff], sims[neigh[:k_eff]]


def _topk_umap_l2(idx: int, k: int) -> np.ndarray:
    """
    Return indices of the k nearest neighbors using **Euclidean distance**
    in the 2D UMAP space (umap2_x, umap2_y), excluding self.

    This is used to make the selected neighbors match what the user sees
    as "nearby" on the UMAP projection, while metrics are still computed
    in the high-dimensional feature space.
    """
    umap = _ensure_umap2()
    n = umap.shape[0]
    if not (0 <= idx < n):
        raise IndexError(f"Index out of range: {idx} (0..{n-1})")
    k_eff = max(1, min(int(k), n - 1))
    q = umap[idx]
    dists = np.linalg.norm(umap - q, axis=1).astype(np.float32)
    dists[idx] = np.inf
    if k_eff < n - 1:
        part_idx = np.argpartition(dists, k_eff)[:k_eff]
        order = np.argsort(dists[part_idx])
        neigh = part_idx[order]
    else:
        neigh = np.argsort(dists)
    return neigh[:k_eff]


def _compactness(neigh_ids: np.ndarray) -> float:
    """Mean L2 distance to neighbor centroid, on normalized features."""
    _, feats_n = _ensure_features()
    if neigh_ids.size == 0:
        return 0.0
    X = feats_n[neigh_ids]
    c = X.mean(axis=0)
    d = np.linalg.norm(X - c, axis=1)
    return float(d.mean())


def _difference_magnitude(q_id: int, neigh_ids: np.ndarray) -> float:
    """||f_q - mean(f_N)||_2 on normalized features."""
    _, feats_n = _ensure_features()
    if neigh_ids.size == 0:
        return 0.0
    fq = feats_n[q_id]
    fN = feats_n[neigh_ids].mean(axis=0)
    return float(np.linalg.norm(fq - fN))

def _compute_metrics_for(idx: int, k: int, metric: str = "cosine") -> Tuple[float, float]:
    """
    Return (compactness, difference) for one query index.

    Neighbor set is selected in UMAP 2D space (Euclidean distance) so that
    the local structure matches what is visible on the UMAP plot.
    Metrics themselves are still computed in the normalized feature space.
    """
    feats, feats_n = _ensure_features()
    _ = feats  # keep reference for potential future use
    feats_repr = _get_repr(metric)
    n = feats_repr.shape[0]
    if not (0 <= idx < n):
        idx = int(max(0, min(idx, n - 1)))
    try:
        neigh_ids = _topk_umap_l2(idx, k)
    except Exception:
        # Fallback: if UMAP coordinates are unavailable, revert to cosine-based neighbors
        neigh_ids, _ = _topk_cosine(idx, k, metric=metric)
    comp = _compactness(neigh_ids)
    diff = _difference_magnitude(idx, neigh_ids)
    return comp, diff

def _ensure_percentiles(k: int, metric: str = "cosine", sample_size: int = 200) -> Tuple[np.ndarray, np.ndarray]:
    """
    Compute and cache approximate percentile reference arrays for compactness and difference.
    Returns sorted arrays (compacts_sorted, diffs_sorted).
    """
    global _PCTL_CACHE
    key = f"k{k}_m{metric}_s{sample_size}"
    if _PCTL_CACHE and _PCTL_CACHE.get("key") == key:
        return _PCTL_CACHE["compacts"], _PCTL_CACHE["diffs"]
    # build by sampling queries uniformly
    _, feats_n = _ensure_features()
    n = feats_n.shape[0]
    m = int(max(50, min(sample_size, n)))
    rng = np.random.default_rng(1729)
    sample_ids = rng.choice(n, size=m, replace=False)
    comps = np.empty(m, dtype=np.float32)
    diffs = np.empty(m, dtype=np.float32)
    for i, idx in enumerate(sample_ids):
        c, d = _compute_metrics_for(int(idx), k, metric=metric)
        comps[i] = c
        diffs[i] = d
    comps.sort()
    diffs.sort()
    _PCTL_CACHE = {"key": key, "compacts": comps, "diffs": diffs}
    return comps, diffs

def _percentile_from_sorted(sorted_arr: np.ndarray, value: float) -> float:
    """Return percentile in [0,1] using sorted reference array."""
    if sorted_arr.size == 0:
        return 0.0
    # rank proportion (<= value)
    idx = int(np.searchsorted(sorted_arr, value, side="right"))
    return float(idx / sorted_arr.size)

def _ensure_global_center() -> np.ndarray:
    """Return global centroid (unit) in normalized feature space."""
    global _GLOBAL_CENTER
    if _GLOBAL_CENTER is None:
        _, feats_n = _ensure_features()
        c = feats_n.mean(axis=0)
        n = np.linalg.norm(c)
        _GLOBAL_CENTER = c / n if n != 0 else np.zeros_like(c)
    return _GLOBAL_CENTER  # type: ignore

def _ensure_global_diffs_sorted() -> np.ndarray:
    """Sorted distances 1-cos(feat, global_center) for all cells."""
    global _GLOBAL_DIFFS_SORTED
    if _GLOBAL_DIFFS_SORTED is None:
        _, feats_n = _ensure_features()
        cg = _ensure_global_center()
        sims = (feats_n @ cg).astype(np.float32)
        np.clip(sims, -1.0, 1.0, out=sims)
        diffs = 1.0 - sims
        _GLOBAL_DIFFS_SORTED = np.sort(diffs)
    return _GLOBAL_DIFFS_SORTED  # type: ignore

def _ensure_global_center() -> np.ndarray:
    """Return global centroid (on normalized features) as a unit vector."""
    global _GLOBAL_CENTER
    if _GLOBAL_CENTER is None:
        _, feats_n = _ensure_features()
        c = feats_n.mean(axis=0)
        n = np.linalg.norm(c)
        _GLOBAL_CENTER = c / n if n != 0 else np.zeros_like(c)
    return _GLOBAL_CENTER  # type: ignore

def _ensure_global_diffs_sorted() -> np.ndarray:
    """Return sorted distances of all cells to global centroid: 1 - cosine(feat_i, c_global)."""
    global _GLOBAL_DIFFS_SORTED
    if _GLOBAL_DIFFS_SORTED is None:
        _, feats_n = _ensure_features()
        cg = _ensure_global_center()
        sims = (feats_n @ cg).astype(np.float32)
        np.clip(sims, -1.0, 1.0, out=sims)
        diffs = 1.0 - sims
        _GLOBAL_DIFFS_SORTED = np.sort(diffs)
    return _GLOBAL_DIFFS_SORTED  # type: ignore

def _spectral_seriation(Xg: np.ndarray) -> np.ndarray:
    """
    Spectral seriation: build affinity A from cosine similarities (clipped 0..1),
    compute Laplacian L=D-A, take Fiedler vector (2nd smallest eigen) and sort by it.
    Return ordering indices for rows of Xg.
    """
    if Xg.shape[0] <= 1:
        return np.arange(Xg.shape[0], dtype=np.int64)
    # cosine sim on normalized features
    S = (Xg @ Xg.T).astype(np.float32)
    np.clip(S, 0.0, 1.0, out=S)  # affinity
    # ensure no self-bias (diagonal can stay as degree contributor)
    d = np.sum(S, axis=1)
    L = np.diag(d) - S
    try:
        # eigh yields ascending eigenvalues
        w, v = np.linalg.eigh(L)
        if v.shape[1] >= 2:
            fied = v[:, 1]
        else:
            fied = v[:, 0]
        order = np.argsort(fied)
    except Exception:
        order = np.argsort(np.sum(S, axis=1))  # fallback: sort by degree
    return order.astype(np.int64)

def _load_coords_df() -> pd.DataFrame | None:
    if not os.path.exists(_CSV_PATH):
        return None
    try:
        return pd.read_csv(_CSV_PATH)
    except Exception:
        return None


def _safe_int_label(value, fallback: int) -> int:
    """
    Robustly cast label-like values to int.
    - NaN/None/invalid → fallback
    - float/str numbers → converted safely
    """
    try:
        import pandas as _pd  # local import to avoid hard dependency at import time

        if _pd.isna(value):
            return int(fallback)
    except Exception:
        # if pandas is not available or check fails, continue with generic logic
        pass
    # already an int
    if isinstance(value, int):
        return value
    # direct int cast
    try:
        return int(value)
    except Exception:
        pass
    # try via float (e.g. "1.0")
    try:
        f = float(value)
        if not (f == f):  # NaN check without importing math
            return int(fallback)
        return int(f)
    except Exception:
        return int(fallback)


def _coords_for_ids(ids: List[int]) -> List[Dict]:
    """Return lightweight coord info for the given ids, if csv exists."""
    df = _load_coords_df()
    out: List[Dict] = []
    if df is None:
        # still return ids so frontend can highlight
        return [{"id": int(i)} for i in ids]
    n = len(df)
    for i in ids:
        if 0 <= i < n:
            row = df.iloc[int(i)]
            # For label / chunk_id / local_index fields, guard against NaN or invalid
            # values so that int() does not raise and break the entire response.
            base_label = row.get("label", row.get("clustering", int(i) % 11))
            label_val = _safe_int_label(base_label, fallback=int(i) % 11)
            chunk_id_val = _safe_int_label(row.get("chunk_id", int(i)), fallback=int(i))
            local_index_val = _safe_int_label(row.get("local_index", int(i)), fallback=int(i))
            out.append(
                {
                    "id": int(i),
                    "raw": {"x": float(row.get("X_centroid", 0)), "y": float(row.get("Y_centroid", 0))},
                    "umap2": {"x": float(row.get("umap2_x", 0)), "y": float(row.get("umap2_y", 0))},
                    "label": label_val,
                    "chunk_id": chunk_id_val,  # optional, best-effort
                    "local_index": local_index_val,
                }
            )
        else:
            out.append({"id": int(i)})
    return out


@router.get("/features/t1")
def features_t1(
    q: int = Query(..., description="query id"),
    # 默认邻居数量从 30 调整为 8，使局部直方图与上方图库一致（仅展示前 8 个最近邻）
    k: int = Query(8, ge=1, le=2000),
    metric: str = Query("cosine", regex="^(cosine|cosine_centered)$"),
):
    """T1: for a single query cell, return neighbors and local structure stats."""
    try:
        feats, feats_n = _ensure_features()
        feats_repr = _get_repr(metric)
        n = feats_repr.shape[0]
        if not (0 <= q < n):
            raise HTTPException(status_code=400, detail=f"q out of range (0..{n-1})")
        # 1) 在 UMAP 2D 空间（umap2_x, umap2_y）里用欧氏距离选出 top-k 邻居，
        #    这样「示例图 / UMAP 上的黄色编号」和用户视觉上的“谁在附近”是一致的；
        # 2) 然后回到高维特征表征 feats_repr 上，对这些邻居计算 cosine 相似度，
        #    同时在归一化 feature 空间里计算 compactness / difference 等指标。
        try:
            neigh_ids = _topk_umap_l2(q, k)
            q_vec = feats_repr[q]
            sims = (feats_repr[neigh_ids] @ q_vec).astype(np.float32)
            np.clip(sims, -1.0, 1.0, out=sims)
        except Exception:
            # 如果 UMAP 坐标不可用，就回退到原来的 cosine 邻居逻辑，避免整个接口报错。
            neigh_ids, sims = _topk_cosine(q, k, metric=metric)
        comp = _compactness(neigh_ids)
        diff = _difference_magnitude(q, neigh_ids)
        # Percentiles (approximate via cached sampling)
        ref_comps, ref_diffs = _ensure_percentiles(k=k, metric=metric, sample_size=200)
        comp_p = _percentile_from_sorted(ref_comps, comp)
        diff_p = _percentile_from_sorted(ref_diffs, diff)
        # include sims list for histogram; frontend can bin
        hist_vals = [float(v) for v in sims.tolist()]
        neighbors = [{"id": int(i), "similarity": float(s)} for i, s in zip(neigh_ids.tolist(), hist_vals)]
        return JSONResponse(
            {
                "query": int(q),
                "k": int(len(neighbors)),
                "neighbors": neighbors,
                "compactness": float(comp),
                "difference": float(diff),
                "percentiles": {
                    "compactness": float(comp_p),
                    "difference": float(diff_p),
                },
                "similarities": hist_vals,
                "coords": _coords_for_ids([int(q)] + [int(i) for i in neigh_ids.tolist()]),
                "metric": metric,
            }
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"T1 computation failed: {e}")


@router.post("/features/t2")
def features_t2(payload: Dict = Body(...)):
    """
    T2: group analysis.
    Input: { ids: number[], k?: number }
    Returns: representative id (closest to centroid), group compactness, and simple stats.
    """
    try:
        ids = payload.get("ids")
        metric = payload.get("metric", "cosine_centered")  # default to centered-cosine for better contrast
        if not isinstance(ids, list) or len(ids) == 0:
            raise HTTPException(status_code=400, detail="ids must be a non-empty list")
        ids_arr = np.array([int(x) for x in ids], dtype=np.int64)
        _, feats_n = _ensure_features()
        feats_repr = _get_repr(metric)  # possibly centered representation
        n = feats_repr.shape[0]
        ids_arr = ids_arr[(ids_arr >= 0) & (ids_arr < n)]
        if ids_arr.size == 0:
            raise HTTPException(status_code=400, detail="no valid ids within range")
        X = feats_repr[ids_arr]
        # group centroid (unit)
        c = X.mean(axis=0)
        cn = np.linalg.norm(c)
        c = c / cn if cn != 0 else np.zeros_like(c)
        # distances to centroid (proxy compactness per member)
        dists = np.linalg.norm(X - c, axis=1).astype(np.float32)
        compactness = float(dists.mean())
        compactness_dist = dists.tolist()
        # centroid-to-members similarities
        sims_to_c = (X @ c).astype(np.float32)
        np.clip(sims_to_c, -1.0, 1.0, out=sims_to_c)
        # 1D PCA-like projection for angle
        Xc = X - c
        try:
            _, _, vt = np.linalg.svd(Xc, full_matrices=False)
            axis = vt[0]
        except Exception:
            axis = np.zeros_like(c)
            axis[0] = 1.0
        proj1 = (Xc @ axis).astype(np.float32)
        order = np.argsort(-sims_to_c)
        k = int(min(6, ids_arr.size))
        top_ids = ids_arr[order[:k]]
        top_sims = sims_to_c[order[:k]]
        exemplars = [{"id": int(i), "similarity": float(s)} for i, s in zip(top_ids.tolist(), top_sims.tolist())]
        # group-global difference + percentile (vs distribution of per-cell diffs to global centroid)
        cglob = _ensure_global_center()
        d_group = float(1.0 - float(np.clip(float(np.dot(c, cglob)), -1.0, 1.0)))
        diffs_sorted = _ensure_global_diffs_sorted()
        d_group_p = _percentile_from_sorted(diffs_sorted, d_group)
        # spectral seriation for group (ordering without dimensionality reduction)
        try:
            order_local = _spectral_seriation(X)
            seriation_order_ids = ids_arr[order_local].tolist()
        except Exception:
            seriation_order_ids = ids_arr.tolist()
        # global y baseline: similarity to this group's centroid (y01=(s+1)/2)
        try:
            _, feats_all = _ensure_features()
            feats_all = feats_repr  # use same representation for consistency
            sims_all = (feats_all @ c).astype(np.float32)
            np.clip(sims_all, -1.0, 1.0, out=sims_all)
            y01 = (sims_all + 1.0) * 0.5
            bins_y = 60
            counts_y, edges_y = np.histogram(y01, bins=bins_y, range=(0.0, 1.0))
            centers_y = (edges_y[:-1] + edges_y[1:]) * 0.5
            global_y_hist = {"centers": centers_y.tolist(), "counts": counts_y.astype(np.int64).tolist()}
        except Exception:
            global_y_hist = {"centers": [], "counts": []}
        # global sims histogram vs global centroid (legacy, kept for compatibility)
        try:
            _, feats_all = _ensure_features()
            feats_all = feats_repr
            n_all = feats_all.shape[0]
            sample = int(min(20000, n_all))
            rng = np.random.default_rng(2025)
            idx = rng.choice(n_all, size=sample, replace=False)
            sims_g = (feats_all[idx] @ cglob).astype(np.float32)
            np.clip(sims_g, -1.0, 1.0, out=sims_g)
            sims_g = (sims_g + 1.0) * 0.5
            bins = 40
            counts, edges = np.histogram(sims_g, bins=bins, range=(0.0, 1.0))
            centers = (edges[:-1] + edges[1:]) * 0.5
            global_hist = {"centers": centers.tolist(), "counts": counts.astype(np.int64).tolist()}
        except Exception:
            global_hist = {"centers": [], "counts": []}
        # median reference lines for y (group vs global)
        try:
            y01_group = (sims_to_c + 1.0) * 0.5
            group_y_median = float(np.median(y01_group))
        except Exception:
            group_y_median = None
        try:
            _, feats_all = _ensure_features()
            feats_all = feats_repr
            sims_all2 = (feats_all @ c).astype(np.float32)
            np.clip(sims_all2, -1.0, 1.0, out=sims_all2)
            y01_all = (sims_all2 + 1.0) * 0.5
            global_y_median = float(np.median(y01_all))
        except Exception:
            global_y_median = None
        # representative: argmin distance to centroid among the provided ids
        rep_idx_local = int(np.argmin(dists))
        rep_id = int(ids_arr[rep_idx_local])
        coords = _coords_for_ids([int(i) for i in ids_arr.tolist()])
        # simple umap centroid if available
        umap_centroid = None
        try:
            xs = [c["umap2"]["x"] for c in coords if "umap2" in c]
            ys = [c["umap2"]["y"] for c in coords if "umap2" in c]
            if len(xs) > 0:
                umap_centroid = {"x": float(sum(xs) / len(xs)), "y": float(sum(ys) / len(ys))}
        except Exception:
            umap_centroid = None
        return JSONResponse(
            {
                "size": int(ids_arr.size),
                "representative": rep_id,
                "compactness": compactness,
                "compactness_dist": compactness_dist,
                "centroid_similarities": sims_to_c.tolist(),
                "proj1": proj1.tolist(),
                "exemplars": exemplars,
                "difference_group": d_group,
                "difference_group_percentile": float(d_group_p),
                "seriation_order": seriation_order_ids,
                "global_y_hist": global_y_hist,
                "global_sims_hist": global_hist,
                "group_y_median": group_y_median,
                "global_y_median": global_y_median,
                "coords": coords,
                "umap_centroid": umap_centroid,
                "metric": metric,
            }
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"T2 computation failed: {e}")


@router.post("/features/representatives")
def features_representatives(payload: Dict = Body(...)):
    """
    Return representative cells (closest to centroid in feature space) for multiple regions.
    Input: { regions: number[][], metric?: str }
    Output: { regions: [{ size, representative, representative_similarity, compactness }], metric }
    """
    try:
        regions = payload.get("regions")
        metric = payload.get("metric", "cosine_centered")
        if not isinstance(regions, list) or len(regions) == 0:
            raise HTTPException(status_code=400, detail="regions must be a non-empty list")
        feats_repr = _get_repr(metric)
        n = feats_repr.shape[0]
        out = []
        for reg in regions:
            if not isinstance(reg, list):
                out.append(
                    {
                        "size": 0,
                        "representative": None,
                        "representative_similarity": None,
                        "compactness": None,
                    }
                )
                continue
            ids_arr = np.array([int(x) for x in reg], dtype=np.int64)
            ids_arr = ids_arr[(ids_arr >= 0) & (ids_arr < n)]
            ids_arr = np.unique(ids_arr)
            if ids_arr.size == 0:
                out.append(
                    {
                        "size": 0,
                        "representative": None,
                        "representative_similarity": None,
                        "compactness": None,
                    }
                )
                continue
            X = feats_repr[ids_arr]
            c = X.mean(axis=0)
            cn = np.linalg.norm(c)
            c = c / cn if cn != 0 else np.zeros_like(c)
            dists = np.linalg.norm(X - c, axis=1).astype(np.float32)
            rep_idx_local = int(np.argmin(dists))
            rep_id = int(ids_arr[rep_idx_local])
            rep_sim = float(np.clip(float(np.dot(X[rep_idx_local], c)), -1.0, 1.0)) if cn != 0 else None
            comp = float(dists.mean()) if dists.size > 0 else None
            out.append(
                {
                    "size": int(ids_arr.size),
                    "representative": rep_id,
                    "representative_similarity": rep_sim,
                    "compactness": comp,
                }
            )
        if len(out) == 0:
            raise HTTPException(status_code=400, detail="no valid regions found")
        return JSONResponse({"metric": metric, "regions": out})
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"features_representatives failed: {e}")


def _compute_global_histogram(bins: int, sample_pairs: int) -> Dict[str, object]:
    """
    Approximate global cosine similarity distribution by random pair sampling.
    """
    _, feats_n = _ensure_features()
    n = feats_n.shape[0]
    bins = int(max(8, min(400, bins)))
    sample_pairs = int(max(1000, min(2_000_000, sample_pairs)))
    # sample indices (avoid self-pairs)
    rng = np.random.default_rng(1234)
    idx1 = rng.integers(0, n, size=sample_pairs, dtype=np.int64)
    idx2 = rng.integers(0, n, size=sample_pairs, dtype=np.int64)
    mask = idx1 != idx2
    idx1 = idx1[mask]
    idx2 = idx2[mask]
    # dot products on normalized features -> cosine similarity in [-1, 1]
    sims = np.einsum("id,id->i", feats_n[idx1], feats_n[idx2]).astype(np.float32)
    # histogram over [0, 1] for interpretability (clip)
    sims = np.clip(sims, 0.0, 1.0)
    counts, edges = np.histogram(sims, bins=bins, range=(0.0, 1.0))
    centers = (edges[:-1] + edges[1:]) * 0.5
    return {
        "bins": int(bins),
        "range": [0.0, 1.0],
        "centers": centers.tolist(),
        "counts": counts.astype(np.int64).tolist(),
        "total": int(sims.size),
    }


@router.get("/features/global_hist")
def global_hist(
    bins: int = Query(60, ge=8, le=400),
    sample: int = Query(50000, ge=1000, le=2000000),
    mode: str = Query("overall", regex="^(overall|anchor)$"),
    q: int | None = Query(None),
):
    """
    Return similarity histogram used as a reference curve.
    - mode='overall': random pairs across the whole dataset (approximate)
    - mode='anchor' : similarity between a given anchor q and (sample of) all others
    Results are cached when possible.
    """
    global _GLOBAL_HIST
    try:
        if mode == "overall":
            key = f"{bins}_{sample}_overall"
            if _GLOBAL_HIST and _GLOBAL_HIST.get("key") == key:
                return JSONResponse({k: v for k, v in _GLOBAL_HIST.items() if k != "key"})
            res = _compute_global_histogram(bins=bins, sample_pairs=sample)
            _GLOBAL_HIST = {"key": key, **res}
            return JSONResponse(res)
        # anchor mode
        _, feats_n = _ensure_features()
        feats_n = _get_repr("cosine")  # default anchor on normalized cosine
        n = feats_n.shape[0]
        if q is None or not (0 <= int(q) < n):
            raise HTTPException(status_code=400, detail="q must be provided for mode=anchor and within range")
        q = int(q)
        anchor = feats_n[q]
        sims = (feats_n @ anchor).astype(np.float32)
        sims[q] = np.nan  # exclude self
        # optional subsample for efficiency
        if n > sample:
            rng = np.random.default_rng(12345)
            idx = rng.choice(n, size=sample, replace=False)
            sims = sims[idx]
        sims = sims[np.isfinite(sims)]
        np.clip(sims, 0.0, 1.0, out=sims)
        counts, edges = np.histogram(sims, bins=int(bins), range=(0.0, 1.0))
        centers = (edges[:-1] + edges[1:]) * 0.5
        return JSONResponse(
            {
                "bins": int(bins),
                "range": [0.0, 1.0],
                "centers": centers.tolist(),
                "counts": counts.astype(np.int64).tolist(),
                "total": int(sims.size),
                "mode": "anchor",
                "q": int(q),
            }
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Global histogram failed: {e}")


@router.get("/features/validate")
def features_validate(q: int = Query(0)):
    """
    Quick sanity checks for similarity computation.
    - norms stats (min/mean/max)
    - self similarity (should be ~1)
    - top-1 neighbor similarity for a sample q
    """
    feats, feats_n = _ensure_features()
    n = feats_n.shape[0]
    if n == 0:
        return JSONResponse({"error": "no features"})
    q = int(max(0, min(q, n - 1)))
    # norm stats on raw features
    norms = np.linalg.norm(feats, axis=1)
    norm_stats = {
        "min": float(np.min(norms)),
        "mean": float(np.mean(norms)),
        "max": float(np.max(norms)),
        "num_zero": int(np.sum(norms == 0)),
        "num_nan": int(np.sum(~np.isfinite(norms))),
    }
    # self sim ~1
    self_sim = float(np.clip(np.dot(feats_n[q], feats_n[q]), -1.0, 1.0))
    # top-1 neighbor
    neigh, sims = _topk_cosine(q, 5)
    sims = np.clip(sims, -1.0, 1.0)
    top1 = float(sims[0]) if sims.size > 0 else None
    return JSONResponse(
        {
            "N": int(n),
            "D": int(feats_n.shape[1]),
            "norm_stats": norm_stats,
            "self_similarity_q": self_sim,
            "top1_similarity_q": top1,
            "top_ids_q": [int(i) for i in neigh.tolist()],
        }
    )

