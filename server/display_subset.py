"""Large-dataset display subset: cap cells used for coords + Zarr atlases.

When aligned cell count exceeds ``SUBSET_THRESHOLD``, keep at most ``MAX_DISPLAY_CELLS``
rows. Prefer thinning by UMAP 2D grid (one cell per bin, random tie-break), then fill
with uniform random sampling. Original Zarr/csv row indices are preserved as ``id`` in
coords; atlas ``chunk_id`` / ``local_index`` refer to the packed display order.
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd

from .config import DATA_DIR

SUBSET_THRESHOLD = 200_000
MAX_DISPLAY_CELLS = 200_000

_SUBSET_NPZ = os.path.join(DATA_DIR, "display_cell_subset.npz")


def subset_artifacts_exist() -> bool:
    return os.path.exists(_SUBSET_NPZ)


def clear_display_subset_artifacts() -> None:
    try:
        if os.path.exists(_SUBSET_NPZ):
            os.remove(_SUBSET_NPZ)
    except Exception:
        pass


def load_display_indices() -> np.ndarray | None:
    """Return int64 array of original row indices in display order, or None if no subset."""
    if not subset_artifacts_exist():
        return None
    try:
        z = np.load(_SUBSET_NPZ)
        ind = np.asarray(z["indices"], dtype=np.int64).ravel()
        if ind.size == 0:
            return None
        return ind
    except Exception:
        return None


def load_subset_full_n() -> int | None:
    if not subset_artifacts_exist():
        return None
    try:
        z = np.load(_SUBSET_NPZ)
        if "full_n" in z.files:
            return int(z["full_n"])
    except Exception:
        pass
    return None


def _umap_grid_thin(
    ux: np.ndarray,
    uy: np.ndarray,
    n: int,
    cap: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Pick at most one index per UMAP grid cell; return sorted unique indices (may be < cap)."""
    finite = np.isfinite(ux) & np.isfinite(uy)
    if not finite.any():
        return np.array([], dtype=np.int64)

    gx = int(np.ceil(np.sqrt(cap * 1.25)))
    gy = int(np.ceil(cap / max(gx, 1)))
    while gx * gy < cap:
        gx += 1
        gy = int(np.ceil(cap / max(gx, 1)))

    xmin = float(np.min(ux[finite]))
    xmax = float(np.max(ux[finite]))
    ymin = float(np.min(uy[finite]))
    ymax = float(np.max(uy[finite]))
    rx = max(xmax - xmin, 1e-12)
    ry = max(ymax - ymin, 1e-12)

    bx = np.floor((ux - xmin) / rx * (gx - 1e-9)).astype(np.int32)
    by = np.floor((uy - ymin) / ry * (gy - 1e-9)).astype(np.int32)
    bx = np.clip(bx, 0, gx - 1)
    by = np.clip(by, 0, gy - 1)
    keys = bx.astype(np.int64) * gy + by.astype(np.int64)

    order = rng.permutation(n)
    picked_bins: set[int] = set()
    picked_idx: list[int] = []
    for i in order:
        if len(picked_idx) >= cap:
            break
        if not finite[i]:
            continue
        k = int(keys[i])
        if k in picked_bins:
            continue
        picked_bins.add(k)
        picked_idx.append(int(i))
    return np.array(sorted(picked_idx), dtype=np.int64)


def compute_display_indices(df: pd.DataFrame, n_aligned: int, seed: int = 42) -> np.ndarray:
    """
    Return sorted original row indices ``0 .. n-1`` to use for coords + atlas packing.
    Length is ``min(n_aligned, MAX_DISPLAY_CELLS)`` iff ``n_aligned > SUBSET_THRESHOLD``, else ``n_aligned``.
    """
    n = int(min(len(df), int(n_aligned)))
    if n <= SUBSET_THRESHOLD:
        return np.arange(n, dtype=np.int64)

    rng = np.random.default_rng(int(seed))
    cap = min(MAX_DISPLAY_CELLS, n)

    picked = np.array([], dtype=np.int64)
    if "umap2_x" in df.columns and "umap2_y" in df.columns:
        try:
            s = df.iloc[:n]
            ux = pd.to_numeric(s["umap2_x"], errors="coerce").to_numpy(dtype=np.float64)
            uy = pd.to_numeric(s["umap2_y"], errors="coerce").to_numpy(dtype=np.float64)
            picked = _umap_grid_thin(ux, uy, n, cap, rng)
        except Exception:
            picked = np.array([], dtype=np.int64)

    picked = np.unique(picked.astype(np.int64, copy=False))
    if picked.size > cap:
        picked = np.sort(rng.choice(picked, size=cap, replace=False))
    need = cap - picked.size
    if need > 0:
        pool = np.setdiff1d(np.arange(n, dtype=np.int64), picked, assume_unique=True)
        if pool.size > 0:
            take = min(need, pool.size)
            extra = rng.choice(pool, size=take, replace=False) if pool.size > take else pool
            picked = np.sort(np.concatenate([picked, extra.astype(np.int64, copy=False)]))
    return picked.astype(np.int64, copy=False)


def save_display_subset(full_n: int, indices: np.ndarray) -> None:
    """Persist subset indices; atlas PNGs stay under ch*/tile_* (clear_cache_dir invalidates old files)."""
    indices = np.asarray(indices, dtype=np.int64).ravel()
    np.savez_compressed(_SUBSET_NPZ, indices=indices, full_n=int(full_n))


def display_atlas_n_and_chunks(n_full: int, n_per_chunk: int) -> tuple[int, int]:
    """Effective cell count and chunk count for atlas / meta (display space)."""
    ind = load_display_indices()
    if ind is None:
        n_disp = int(n_full)
    else:
        n_disp = int(ind.size)
    n_chunks = int(np.ceil(n_disp / max(int(n_per_chunk), 1))) if n_disp > 0 else 0
    return n_disp, n_chunks


__all__ = [
    "SUBSET_THRESHOLD",
    "MAX_DISPLAY_CELLS",
    "subset_artifacts_exist",
    "clear_display_subset_artifacts",
    "load_display_indices",
    "load_subset_full_n",
    "compute_display_indices",
    "save_display_subset",
    "display_atlas_n_and_chunks",
]
