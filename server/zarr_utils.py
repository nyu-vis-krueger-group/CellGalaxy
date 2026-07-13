import io
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
from typing import Optional, Tuple

import numpy as np
from PIL import Image
import zarr

from .config import CACHE_DIR, ZARR_DIR, DEFAULT_TILE, clear_cache_dir
from .display_subset import load_display_indices


# blosc thread count setting (if available)
try:
    from numcodecs import blosc as _blosc

    _blosc.set_nthreads(max(1, os.cpu_count() or 1))
except Exception:
    pass


# process-level Zarr handle cache and thread pool
_IMG: zarr.Array | None = None
_IMG_LOCK = threading.Lock()
_EXECUTOR = ThreadPoolExecutor(max_workers=max(2, (os.cpu_count() or 4)))
_PREWARM_SET: set[tuple[int, int]] = set()
_TILE_SIZE: int | None = None
_TILE_LOCK = threading.Lock()


def reset_zarr_handle(*, clear_cache: bool = True) -> None:
    """Reset process-level Zarr handle (optionally wipe generated atlas cache)."""
    global _IMG, _TILE_SIZE
    with _IMG_LOCK:
        _IMG = None
    with _TILE_LOCK:
        _TILE_SIZE = None
    if clear_cache:
        clear_cache_dir()


def open_zarr():
    """lazy open Zarr array, using process-level cache"""
    global _IMG
    if _IMG is not None:
        return _IMG
    with _IMG_LOCK:
        if _IMG is None:
            if not os.path.isdir(ZARR_DIR):
                raise RuntimeError(f"Zarr directory does not exist: {ZARR_DIR}")
            _IMG = zarr.open_array(ZARR_DIR, mode="r")
    return _IMG


def meta_from_img(img) -> Tuple[int, int, int, int, Tuple[int, ...], int, int]:
    """extract basic metadata from Zarr image object"""
    if img.ndim != 4:
        raise RuntimeError(f"Expected Zarr shape [C,N,H,W], actual {img.shape}")
    C, N, H, W = img.shape
    chunks = img.chunks
    if chunks is None:
        raise RuntimeError("Zarr array must be chunked")
    n_per_chunk = chunks[1]
    n_chunks = math.ceil(N / n_per_chunk)
    return C, N, H, W, chunks, n_chunks, n_per_chunk


def grid_for_count(n_items: int) -> Tuple[int, int]:
    """calculate rows and columns for a roughly square grid based on item count"""
    cols = int(math.ceil(math.sqrt(n_items))) if n_items > 0 else 1
    rows = int(math.ceil(n_items / cols)) if n_items > 0 else 1
    return rows, cols


def get_default_tile() -> int:
    """
    auto-detect tile size from Zarr metadata.
    priority:
      1. use H (and W) from shape [C, N, H, W] when available
      2. fallback to chunk spatial dimensions
      3. fallback to DEFAULT_TILE
    """
    global _TILE_SIZE
    if _TILE_SIZE is not None:
        return _TILE_SIZE
    with _TILE_LOCK:
        if _TILE_SIZE is not None:
            return _TILE_SIZE
        tile = DEFAULT_TILE
        try:
            img = open_zarr()
            C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
            # prefer spatial dimensions
            if H == W and H > 0:
                tile = int(H)
            elif chunks is not None and len(chunks) >= 4:
                # fallback: use spatial chunk size
                if chunks[2] == chunks[3] and chunks[2] > 0:
                    tile = int(chunks[2])
        except Exception as e:
            print(f"get_default_tile fallback to DEFAULT_TILE={DEFAULT_TILE}: {e}")
        _TILE_SIZE = int(tile)
        return _TILE_SIZE


def stable_label(idx: int, num_classes: int = 11) -> int:
    """generate a stable class label based on index"""
    h = hashlib.sha1(str(idx).encode("utf-8")).hexdigest()
    return int(h[:8], 16) % num_classes


def single_cache_path(channel: int, chunk_id: int, tile: int) -> str:
    """single-channel fixed cache path (matches /public/cache static URL layout)."""
    ch_dir = os.path.join(CACHE_DIR, f"ch{int(channel)}", f"tile_{int(tile)}")
    os.makedirs(ch_dir, exist_ok=True)
    return os.path.join(ch_dir, f"chunk_{int(chunk_id)}.png")


def norm01(x: np.ndarray, lo: float, hi: float, gamma: float = 1.0) -> np.ndarray:
    den = max(hi - lo, 1e-8)
    t = (x.astype(np.float32) - lo) / den
    t = np.clip(t, 0.0, 1.0)
    if gamma != 1.0:
        t = np.power(t, 1.0 / float(gamma), where=t > 0.0, out=t)
    return t


def tiles_to_atlas(rgba_tiles: np.ndarray, tile: int) -> Image.Image:
    """concatenate several tiles into an atlas"""
    M, H, W, _ = rgba_tiles.shape
    rows, cols = grid_for_count(M)
    atlas_h = rows * tile
    atlas_w = cols * tile

    atlas = np.zeros((atlas_h, atlas_w, 4), dtype=np.float32)
    idx = 0
    for r in range(rows):
        r0 = r * tile
        for c in range(cols):
            if idx >= M:
                break
            c0 = c * tile
            atlas[r0:r0 + tile, c0:c0 + tile, :] = rgba_tiles[idx]
            idx += 1
    atlas = (atlas * 255.0 + 0.5).astype(np.uint8)
    return Image.fromarray(atlas, mode="RGBA")


def _cell_indices_for_atlas_chunk(
    chunk_id: int, n_per_chunk: int, n_zarr: int,     subset: Optional[np.ndarray],
) -> np.ndarray:
    """Original Zarr axis-1 indices for one display atlas chunk."""
    if subset is None:
        start = int(chunk_id) * int(n_per_chunk)
        end = min(start + int(n_per_chunk), int(n_zarr))
        if start >= end:
            return np.array([], dtype=np.int64)
        return np.arange(start, end, dtype=np.int64)
    k = int(subset.size)
    start = int(chunk_id) * int(n_per_chunk)
    end = min(start + int(n_per_chunk), k)
    if start >= end:
        return np.array([], dtype=np.int64)
    return subset[start:end].astype(np.int64, copy=False)


def _generate_single_channel_mask(img, ch: int, cell_indices: np.ndarray) -> np.ndarray:
    """generate single-channel RGBA mask from Zarr image for given cell indices (axis 1)."""
    if cell_indices.size == 0:
        raise RuntimeError("empty cell_indices for atlas mask")
    data = np.asarray(img[ch, cell_indices, :, :], dtype=np.float32)
    if data.ndim == 3:
        data = data[np.newaxis, ...]
    if data.ndim != 4:
        raise RuntimeError(f"Unexpected data ndim: {data.ndim}")
    t = norm01(data[0], 0.0, 65535.0, 1.0)
    gray = t
    alpha = t
    mask = np.stack([gray, gray, gray, np.clip(alpha, 0.0, 1.0)], axis=-1)
    return mask


def _render_and_cache_atlas(img, ch: int, chunk_id: int, tile: int) -> str:
    """render and cache single-channel atlas, return cache path"""
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    if not (0 <= ch < C):
        raise RuntimeError(f"channel {ch} out of range [0,{C-1}]")
    subset = load_display_indices()
    n_disp = int(subset.size) if subset is not None else int(N)
    n_chunks_eff = int(math.ceil(n_disp / max(int(n_per_chunk), 1))) if n_disp > 0 else 0
    if not (0 <= chunk_id < n_chunks_eff):
        raise RuntimeError("chunk_id out of range")
    cache_path = single_cache_path(ch, chunk_id, int(tile))
    if os.path.exists(cache_path):
        return cache_path
    cell_idx = _cell_indices_for_atlas_chunk(chunk_id, n_per_chunk, N, subset)
    mask = _generate_single_channel_mask(img, ch, cell_idx)
    atlas_img = tiles_to_atlas(mask, tile=int(tile))
    buf = io.BytesIO()
    atlas_img.save(buf, format="PNG", compress_level=1)
    data_bytes = buf.getvalue()
    with open(cache_path, "wb") as f:
        f.write(data_bytes)
    return cache_path


def render_cell_preview_png(
    img,
    cell_id: int,
    channels: list[int],
    channel_colors: dict[int, tuple[int, int, int]] | None = None,
    channel_alphas: dict[int, float] | None = None,
    channel_windows: dict[int, tuple[float, float]] | None = None,
    out_size: int = 128,
) -> bytes:
    """Composite multi-channel cell tile to PNG (for spatial hover off-atlas cells)."""
    C, N, H, W, _chunks, _n_chunks, _n_per_chunk = meta_from_img(img)
    cid = int(cell_id)
    if not (0 <= cid < int(N)):
        raise ValueError(f"cell_id {cid} out of range [0, {N - 1}]")

    colors = channel_colors or {}
    alphas = channel_alphas or {}
    wins = channel_windows or {}

    tone_gain = 1.0  # sync with src/utils/intensityWindow.js TONE_GAIN
    accum = np.zeros((int(H), int(W), 4), dtype=np.float32)
    for ch in channels:
        ci = int(ch)
        if not (0 <= ci < int(C)):
            continue
        data = np.asarray(img[ci, cid, :, :], dtype=np.float32)
        w = wins.get(ci, (0.0, 65535.0))
        lo, hi = float(w[0]), float(w[1])
        t = norm01(data, lo, hi, 1.0)
        col = colors.get(ci, (255, 255, 255))
        alpha01 = float(min(1.0, max(0.0, alphas.get(ci, 1.0))))
        v = t * alpha01
        accum[..., 0] += np.clip(col[0] * v * tone_gain, 0, 255)
        accum[..., 1] += np.clip(col[1] * v * tone_gain, 0, 255)
        accum[..., 2] += np.clip(col[2] * v * tone_gain, 0, 255)
        accum[..., 3] = np.maximum(accum[..., 3], v)

    rgba = np.zeros((int(H), int(W), 4), dtype=np.uint8)
    rgba[..., 0] = np.clip(accum[..., 0], 0, 255).astype(np.uint8)
    rgba[..., 1] = np.clip(accum[..., 1], 0, 255).astype(np.uint8)
    rgba[..., 2] = np.clip(accum[..., 2], 0, 255).astype(np.uint8)
    rgba[..., 3] = np.clip(accum[..., 3] * 255.0, 0, 255).astype(np.uint8)

    pil = Image.fromarray(rgba, mode="RGBA")
    if out_size > 0 and (int(H) != out_size or int(W) != out_size):
        pil = pil.resize((int(out_size), int(out_size)), Image.Resampling.NEAREST)
    buf = io.BytesIO()
    pil.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def _prewarm_channel_async(ch: int, tile: int) -> None:
    """async prewarm all chunks of a single channel atlas"""
    key = (int(ch), int(tile))
    if key in _PREWARM_SET:
        return
    _PREWARM_SET.add(key)

    def _task():
        try:
            img = open_zarr()
            C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
            subset = load_display_indices()
            n_disp = int(subset.size) if subset is not None else int(N)
            n_chunks_eff = int(math.ceil(n_disp / max(int(n_per_chunk), 1))) if n_disp > 0 else 0
            futures = []
            for cid in range(n_chunks_eff):
                cp = single_cache_path(ch, cid, int(tile))
                if os.path.exists(cp):
                    continue
                futures.append(_EXECUTOR.submit(_render_and_cache_atlas, img, ch, cid, tile))
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception as e:
                    try:
                        print(f"prewarm task error: {e}")
                    except Exception:
                        pass
        finally:
            _PREWARM_SET.discard(key)

    _EXECUTOR.submit(_task)


__all__ = [
    "open_zarr",
    "reset_zarr_handle",
    "meta_from_img",
    "grid_for_count",
    "get_default_tile",
    "render_cell_preview_png",
    "stable_label",
    "single_cache_path",
    "_render_and_cache_atlas",
    "_prewarm_channel_async",
]


