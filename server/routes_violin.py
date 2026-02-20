import math
from typing import Dict, List, Tuple, Callable

import numpy as np
from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

from .zarr_utils import open_zarr, meta_from_img


router = APIRouter()

# process-level cache: global sampling results (by parameter key)
_GLOBAL_CACHE: Dict[str, Dict[str, object]] = {}
_GLOBAL_KDE_CACHE: Dict[str, Dict[str, object]] = {}


def _key_for_global(max_samples: int, perc: float, thr: float, channels: Tuple[int, ...] | None) -> str:
    ch_key = "all" if channels is None else ",".join(str(int(c)) for c in channels)
    return f"m{int(max_samples)}_p{float(perc):.2f}_t{float(thr):.3f}_ch[{ch_key}]"


def _foreground_filter(vals: np.ndarray, perc_for_thr: float, thr_factor: float) -> np.ndarray:
    """
    Simple foreground filter:
    - First drop extremely low-intensity pixels based on an absolute 0–65535 scale
      (keep only >=1% of the full range, i.e. >= ~655), to get rid of a huge mass
      of dark background values.
    - Then apply the original percentile-based foreground threshold:
        keep values > (percentile(perc_for_thr) * thr_factor)
    - If after any filtering we have too few samples, fall back to the unfiltered
      values to avoid degenerate KDE estimates.
    """
    if vals.size == 0:
        return vals
    x = vals.astype("float32", copy=False)

    # 1) Absolute lower cut based on 16‑bit range 0..65535:
    #    keep only values >= 1% * 65535 ≈ 655 to remove the bulk of near‑zero background.
    #    If this would remove almost everything (e.g. for 8‑bit data), fall back.
    try:
        min_abs = 0.01 * 65535.0  # 1% of [0, 65535]
        x_clip = x[x >= min_abs]
        if x_clip.size >= 100:
            x = x_clip
    except Exception:
        # if anything goes wrong, just keep original values
        x = vals.astype("float32", copy=False)

    # 2) Original percentile-based foreground selection
    try:
        p_val = float(np.percentile(x, float(perc_for_thr)))
        thr = p_val * float(thr_factor)
        fg = x[x > thr]
        if fg.size >= 100:
            return fg
        return x
    except Exception:
        return x


def _sample_channel_global(arr, channel_idx: int, max_samples: int) -> np.ndarray:
    """
    - sample pixels from global (all cells) for current channel
    - sequentially process by chunk, do not read all at once
    - determine the sampling number of each chunk according to the pixel ratio of each chunk, use np.random.choice to sample in the chunk
    """
    C, N, H, W = arr.shape
    _, n_per_chunk, _, _ = arr.chunks
    total_pixels = int(N) * int(H) * int(W)
    samples: List[np.ndarray] = []
    start = 0
    while start < N:
        end = min(start + n_per_chunk, N)
        data = np.asarray(arr[channel_idx, start:end, :, :])
        flat = data.reshape(-1)
        local_n = int(flat.size)
        if local_n <= 0:
            start = end
            continue
        # the sampling number of this chunk (allocated according to the ratio)
        k = int(np.round(max_samples * (local_n / max(1, total_pixels))))
        if k > 0:
            k = min(k, local_n)
            idx = np.random.choice(local_n, size=k, replace=False)
            samples.append(flat[idx])
        start = end
    if not samples:
        return np.array([], dtype=arr.dtype)
    return np.concatenate(samples, axis=0)


def _group_ids_by_chunk(valid_ids: np.ndarray, n_per_chunk: int, N: int) -> Dict[int, np.ndarray]:
    """
    group global indices by chunk, return {chunk_id: local indices in this chunk}
    """
    out: Dict[int, List[int]] = {}
    for gid in valid_ids.tolist():
        if gid < 0 or gid >= N:
            continue
        cid = gid // n_per_chunk
        li = gid - cid * n_per_chunk
        out.setdefault(int(cid), []).append(int(li))
    return {cid: np.array(locs, dtype=np.int64) for cid, locs in out.items()}


def _sample_channel_selection(arr, channel_idx: int, sel_ids: np.ndarray, max_samples: int) -> np.ndarray:
    C, N, H, W = arr.shape
    _, n_per_chunk, _, _ = arr.chunks
    # filter and deduplicate
    sel_ids = np.unique(sel_ids[(sel_ids >= 0) & (sel_ids < N)])
    if sel_ids.size == 0:
        return np.array([], dtype=arr.dtype)
    by_chunk = _group_ids_by_chunk(sel_ids, int(n_per_chunk), int(N))
    total_pixels = int(sel_ids.size) * int(H) * int(W)
    samples: List[np.ndarray] = []
    # sequentially process by chunk, do not read all at once
    for cid, local_idxs in by_chunk.items():
        if local_idxs.size == 0:
            continue
        start = cid * n_per_chunk
        end = min(start + n_per_chunk, N)
        block = np.asarray(arr[channel_idx, start:end, :, :])  # [n_per_chunk, H, W]
        # only keep selected cells in this chunk (local rows)
        block_sel = block[local_idxs, :, :]
        flat = block_sel.reshape(-1)
        local_n = int(flat.size)
        if local_n <= 0:
            continue
        k = int(round(max_samples * (local_n / max(1, total_pixels))))
        if k <= 0:
            continue
        k = min(k, local_n)
        idx = np.random.choice(local_n, size=k, replace=False)
        samples.append(flat[idx])
    if not samples:
        return np.array([], dtype=arr.dtype)
    return np.concatenate(samples, axis=0)


def _sample_channel_selection_cell_means(arr, channel_idx: int, sel_ids: np.ndarray, max_cells: int) -> np.ndarray:
    """
    For a given channel and a list of **cell ids**, sample up to `max_cells`
    cells and return one scalar per cell as its intensity summary.

    Compared to pixel-level sampling, this:
      - treats each cell equally (not weighted by area),
      - reads Zarr in chunk-wise blocks instead of per-cell, which is
        much faster on large selections.
    """
    C, N, H, W = arr.shape
    _, n_per_chunk, _, _ = arr.chunks
    # filter + dedup ids, clamp to valid range
    sel_ids = np.unique(sel_ids[(sel_ids >= 0) & (sel_ids < N)])
    if sel_ids.size == 0:
        return np.array([], dtype=np.float32)
    # downsample number of cells to keep cost roughly constant
    max_cells = int(max(1, max_cells))
    if sel_ids.size > max_cells:
        idx = np.random.choice(sel_ids.size, size=max_cells, replace=False)
        sel_ids = sel_ids[idx]
    # group by chunk so we read each chunk once
    by_chunk = _group_ids_by_chunk(sel_ids, int(n_per_chunk), int(N))
    vals: List[np.ndarray] = []
    for cid, local_idxs in by_chunk.items():
        if local_idxs.size == 0:
            continue
        start = cid * n_per_chunk
        end = min(start + n_per_chunk, N)
        try:
            block = np.asarray(arr[channel_idx, start:end, :, :], dtype=np.float32)  # [n_per_chunk,H,W]
            block_sel = block[local_idxs, :, :]
            if block_sel.size == 0:
                continue
            # Flatten to [n_cells_in_chunk, H*W]
            flat2d = block_sel.reshape(block_sel.shape[0], -1)
            # Use a **high but not extreme percentile (95th)** per cell as the
            # summary intensity. Compared with pure mean,这会把真正亮的细胞
            # 拉得更开，但又不会像 99/100 分位那样被单点噪声主导。
            per_cell = np.percentile(flat2d, 95.0, axis=1).astype(np.float32)
            vals.append(per_cell)
        except Exception:
            continue
    if not vals:
        return np.array([], dtype=np.float32)
    return np.concatenate(vals, axis=0).astype(np.float32)

def _kde_gaussian_1d(values: np.ndarray, grid: int = 256) -> Tuple[np.ndarray, np.ndarray, float, float, float]:
    """
    - Gaussian kernel density estimation (1D, Scott's bandwidth), return (xs, ys, lo, hi, bw)
    - xs: intensity grid (evenly spaced, lo..hi)
    - ys: probability density (not scaled), same length as xs
    - lo/hi: minimum/maximum of sampling, used as uniform y-axis intensity scale
    - bw: Scott's bandwidth h
    """
    if values.size == 0:
        xs = np.linspace(0.0, 1.0, num=max(2, int(grid)), dtype=np.float32)
        ys = np.zeros_like(xs, dtype=np.float32)
        return xs, ys, 0.0, 1.0, 0.0
    x = values.astype(np.float64, copy=False)
    n = x.size
    lo = float(np.min(x))
    hi = float(np.max(x))
    std = float(np.std(x)) if n > 1 else 0.0
    # Scott's rule: h = sigma * n^{-1/5}
    if std <= 0.0:
        std = (hi - lo) / 6.0 if hi > lo else 1.0
    h = float(std) * (float(n) ** (-1.0 / 5.0))
    if h <= 1e-12:
        h = max(1e-6, (hi - lo) * 1e-3 if hi > lo else 1e-3)
    xs = np.linspace(lo, hi, num=max(8, int(grid)), dtype=np.float64)
    inv_norm = 1.0 / (np.sqrt(2.0 * np.pi) * float(n) * h)
    ys = np.empty_like(xs)
    # calculate point by point, avoid constructing giant matrix
    for i in range(xs.size):
        u = (xs[i] - x) / h
        ys[i] = inv_norm * np.exp(-0.5 * u * u).sum()
    return xs.astype(np.float32), ys.astype(np.float32), lo, hi, float(h)


def _ensure_channel_list(C: int, channels: str | None) -> List[int]:
    """Parse and sanitize channel indices from query string."""
    if channels and channels.strip():
        ch_list = tuple(sorted(set(int(x) for x in channels.split(",") if x.strip() != "")))
        return [c for c in ch_list if 0 <= c < C]
    return list(range(int(C)))


def _kde_for_channels(
    ch_sel: List[int],
    sampler: Callable[[int], np.ndarray],
    grid: int,
) -> Tuple[List[List[float]], List[List[float]], List[float], List[float], List[float], List[int]]:
    """
    Compute KDE for a list of channels using provided sampler(channel_idx)->np.ndarray.
    Returns (xs_list, ys_list, lo_list, hi_list, bw_list).
    """
    xs_list: List[List[float]] = []
    ys_list: List[List[float]] = []
    lo_list: List[float] = []
    hi_list: List[float] = []
    bw_list: List[float] = []
    cnt_list: List[int] = []
    for c in ch_sel:
        s = sampler(int(c))
        cnt_list.append(int(s.size))
        xs, ys, lo, hi, bw = _kde_gaussian_1d(s, grid=int(grid))
        xs_list.append(xs.astype(np.float32).tolist())
        ys_list.append(ys.astype(np.float32).tolist())
        lo_list.append(float(lo))
        hi_list.append(float(hi))
        bw_list.append(float(bw))
    return xs_list, ys_list, lo_list, hi_list, bw_list, cnt_list

@router.get("/violin/global")
def violin_global(
    max_samples_per_channel: int = Query(100000, ge=1000, le=200000),
    perc_for_thr: float = Query(99.0, ge=50.0, le=100.0),
    thr_factor: float = Query(0.1, ge=0.0, le=1.0),
    channels: str | None = Query(None, description="e.g. '0,1,2'; empty string means all channels"),
):
    try:
        arr = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(arr)
        ch_sel = _ensure_channel_list(C, channels)
        key = _key_for_global(int(max_samples_per_channel), float(perc_for_thr), float(thr_factor), tuple(ch_sel))
        if key in _GLOBAL_CACHE:
            cached = _GLOBAL_CACHE[key]
            return JSONResponse(cached)
        out_vals: List[List[float]] = []
        for c in ch_sel:
            s = _sample_channel_global(arr, c, int(max_samples_per_channel))
            s = _foreground_filter(s, float(perc_for_thr), float(thr_factor))
            out_vals.append([float(v) for v in s.tolist()])
        res = {
            "channels": [int(c) for c in ch_sel],
            "values": out_vals,  # values[i] -> sample array for channel ch_sel[i]
            "meta": {
                "C": int(C),
                "N": int(N),
                "H": int(H),
                "W": int(W),
                "chunks": tuple(int(x) for x in chunks),
            },
        }
        # simple cache (same parameters)
        _GLOBAL_CACHE[key] = res  # type: ignore
        return JSONResponse(res)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"violin_global failed: {e}")


@router.post("/violin/selection")
def violin_selection(payload: Dict = Body(...)):
    """
    Input:  { ids:number[], max?:int, perc?:float, thr?:float, channels?: number[] }
    Return: { channels:number[], values:number[][] } where values[i] is the sampling array for ch=channels[i]
    """
    try:
        ids = payload.get("ids")
        if not isinstance(ids, list) or len(ids) == 0:
            raise HTTPException(status_code=400, detail="ids must be a non-empty list")
        chs = payload.get("channels", None)
        max_samples = int(payload.get("max", 30000))
        perc = float(payload.get("perc", 99.0))
        thr = float(payload.get("thr", 0.1))
        arr = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(arr)
        if isinstance(chs, list) and len(chs) > 0:
            ch_str = ",".join(str(int(c)) for c in chs)
            ch_sel = _ensure_channel_list(int(C), ch_str)
        else:
            ch_sel = list(range(int(C)))
        ids_arr = np.array([int(x) for x in ids], dtype=np.int64)
        # Downsample selected cell ids to avoid reading an excessive number of chunks
        # when the region is very large. Intensity statistics are approximate but
        # much faster and still representative.
        max_ids = int(payload.get("max_ids", 1500))
        if ids_arr.size > max_ids:
            idx = np.random.choice(ids_arr.size, size=max_ids, replace=False)
            ids_arr = ids_arr[idx]
        out_vals: List[List[float]] = []
        for c in ch_sel:
            s = _sample_channel_selection(arr, c, ids_arr, max_samples)
            s = _foreground_filter(s, perc, thr)
            out_vals.append([float(v) for v in s.tolist()])
        return JSONResponse(
            {
                "channels": [int(c) for c in ch_sel],
                "values": out_vals,
                "meta": {
                    "count_ids": int(ids_arr.size),
                    "H": int(H),
                    "W": int(W),
                },
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"violin_selection failed: {e}")


@router.post("/violin/selection_kde")
def violin_selection_kde(payload: Dict = Body(...)):
    """
    Input:  { ids:number[], max?:int, perc?:float, thr?:float, channels?: number[], grid?:int }
    Return: { channels:number[], xs:number[][], ys:number[][], lo:number[], hi:number[], bw:number[] }
    - Same KDE strategy as /violin/global_kde (Gaussian kernel + Scott's bandwidth)
    """
    try:
        ids = payload.get("ids")
        if not isinstance(ids, list) or len(ids) == 0:
            raise HTTPException(status_code=400, detail="ids must be a non-empty list")
        chs = payload.get("channels", None)

        max_samples = int(payload.get("max", 60000))
        perc = float(payload.get("perc", 99.0))
        thr = float(payload.get("thr", 0))
        grid = int(payload.get("grid", 256))
        arr = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(arr)

        if isinstance(chs, list) and len(chs) > 0:
            ch_str = ",".join(str(int(c)) for c in chs)
            ch_sel = _ensure_channel_list(int(C), ch_str)
        else:
            ch_sel = list(range(int(C)))
        ids_arr = np.array([int(x) for x in ids], dtype=np.int64)
        # Downsample selected cell ids to an upper bound; this keeps the KDE
        # cost roughly constant once the region is large enough.
        # 默认上限从 1500 收紧到 400，避免在超大选区上读取过多 chunk。
        max_ids = int(payload.get("max_ids", 400))
        if ids_arr.size > max_ids:
            idx = np.random.choice(ids_arr.size, size=max_ids, replace=False)
            ids_arr = ids_arr[idx]
        def _sel_sampler(cidx: int) -> np.ndarray:
            s = _sample_channel_selection(arr, cidx, ids_arr, max_samples)
            return _foreground_filter(s, perc, thr)
        xs_list, ys_list, lo_list, hi_list, bw_list, n_list = _kde_for_channels(ch_sel, _sel_sampler, grid)
        return JSONResponse(
            {
                "channels": [int(c) for c in ch_sel],
                "xs": xs_list,
                "ys": ys_list,
                "lo": lo_list,
                "hi": hi_list,
                "bw": bw_list,
                "n": n_list,
                "meta": {"count_ids": int(ids_arr.size), "H": int(H), "W": int(W)},
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"violin_selection_kde failed: {e}")


@router.post("/violin/selection_kde_cell")
def violin_selection_kde_cell(payload: Dict = Body(...)):
    """
    KDE over **per‑cell mean intensities** for a selection.

    Input:
      { ids:number[], max_cells?:int, channels?: number[], grid?:int }

    Each selected cell contributes a single scalar (its mean intensity) per
    channel, so the resulting curves directly reflect how bright the cells
    are in Region 1 vs Region 2, which matches visual intuition better than
    a raw pixel‑level histogram.
    """
    try:
        ids = payload.get("ids")
        if not isinstance(ids, list) or len(ids) == 0:
            raise HTTPException(status_code=400, detail="ids must be a non-empty list")
        chs = payload.get("channels", None)
        grid = int(payload.get("grid", 192))
        max_cells = int(payload.get("max_cells", 400))

        arr = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(arr)
        if isinstance(chs, list) and len(chs) > 0:
            ch_sel = [int(c) for c in chs if 0 <= int(c) < int(C)]
        else:
            ch_sel = list(range(int(C)))
        ids_arr = np.array([int(x) for x in ids], dtype=np.int64)

        def _sel_sampler(cidx: int) -> np.ndarray:
            return _sample_channel_selection_cell_means(arr, cidx, ids_arr, max_cells=max_cells)

        xs_list, ys_list, lo_list, hi_list, bw_list, n_list = _kde_for_channels(ch_sel, _sel_sampler, grid)
        return JSONResponse(
            {
                "channels": [int(c) for c in ch_sel],
                "xs": xs_list,
                "ys": ys_list,
                "lo": lo_list,
                "hi": hi_list,
                "bw": bw_list,
                "n": n_list,
                "meta": {"count_ids": int(ids_arr.size), "H": int(H), "W": int(W)},
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"violin_selection_kde_cell failed: {e}")

@router.get("/violin/global_kde")
def violin_global_kde(
    max_samples_per_channel: int = Query(100000, ge=1000, le=200000),
    perc_for_thr: float = Query(99.0, ge=50.0, le=100.0),
    thr_factor: float = Query(0.1, ge=0.0, le=1.0),
    channels: str | None = Query(None, description="e.g. '0,1,2'; empty means all"),
    grid: int = Query(256, ge=64, le=1024),
):
    """
    return KDE curves for each channel (only active channels), used to draw violin shape directly in frontend.
    - sample and filter foreground in the same way as global, then do KDE on the filtered samples
    - return xs/ys (unnormalized density) and lo/hi/bw; frontend can normalize ys to [0,1] for width
    """
    try:
        arr = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(arr)
        ch_sel = _ensure_channel_list(C, channels)
        key = f"kde_m{int(max_samples_per_channel)}_p{float(perc_for_thr):.2f}_t{float(thr_factor):.3f}_g{int(grid)}_ch[{','.join(str(int(c)) for c in ch_sel)}]"
        if key in _GLOBAL_KDE_CACHE:
            return JSONResponse(_GLOBAL_KDE_CACHE[key])
        def _glob_sampler(cidx: int) -> np.ndarray:
            s = _sample_channel_global(arr, cidx, int(max_samples_per_channel))
            return _foreground_filter(s, float(perc_for_thr), float(thr_factor))
        xs_list, ys_list, lo_list, hi_list, bw_list, n_list = _kde_for_channels(ch_sel, _glob_sampler, grid)
        res = {
            "channels": [int(c) for c in ch_sel],
            "xs": xs_list,
            "ys": ys_list,
            "lo": lo_list,
            "hi": hi_list,
            "bw": bw_list,
            "n": n_list,
            "meta": {
                "C": int(C),
                "N": int(N),
                "H": int(H),
                "W": int(W),
                "chunks": tuple(int(x) for x in chunks),
            },
        }
        _GLOBAL_KDE_CACHE[key] = res  # cache
        return JSONResponse(res)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"violin_global_kde failed: {e}")
