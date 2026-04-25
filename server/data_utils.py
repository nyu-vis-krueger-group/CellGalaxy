import json
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, List, Dict, Optional, Tuple

import numpy as np
import pandas as pd

from .config import DATA_DIR, ZARR_DIR, clear_cache_dir
from .display_subset import (
    clear_display_subset_artifacts,
    compute_display_indices,
    save_display_subset,
    subset_artifacts_exist,
)
from .zarr_utils import open_zarr, meta_from_img, stable_label


def _to_native(val: Any) -> Any:
    """convert numpy/pandas scalar to native Python type, for JSON serialization"""
    try:
        import numpy as _np

        if isinstance(val, (_np.generic,)):
            return val.item()
    except Exception:
        pass
    if isinstance(val, (pd.Timestamp,)):
        return val.isoformat()
    if isinstance(val, (float, int, str, bool)) or val is None:
        return val
    try:
        return json.loads(json.dumps(val))
    except Exception:
        return str(val)


def _safe_int(val: Any) -> Optional[int]:
    """
    Safely try to convert any value to an int.
    - NaN / missing values -> None
    - Strings like "1.0" are first converted to float and then to int
    - Invalid strings (e.g. "NA") return None instead of raising an exception
    """
    try:
        import pandas as _pd  # Local import to avoid potential circular imports

        if _pd.isna(val):
            return None
    except Exception:
        pass
    if isinstance(val, int):
        return val
    try:
        return int(val)
    except Exception:
        pass
    try:
        f = float(val)
        return int(f)
    except Exception:
        return None


def _parse_col_descriptor(name: str):
    """parse descriptor from column name, e.g. 'CD3 (marker: T cells)'"""
    s = str(name or "").strip()
    desc = None
    base = s
    if "(" in s and ")" in s and s.rfind("(") < s.rfind(")"):
        l = s.rfind("(")
        r = s.rfind(")")
        desc = s[l + 1 : r].strip()
        base = s[:l].strip()
    return base if base else s, (desc or None)


def _is_categorical(desc: str, series: pd.Series) -> bool:
    """infer if the column is categorical based on description and data type"""
    if desc and ":" in desc:
        return True
    try:
        from pandas.api import types as ptypes

        if ptypes.is_numeric_dtype(series):
            return False
    except Exception:
        pass
    return True


def generate_raw_json(raw_csv_path: str, out_path: str) -> None:
    """read raw CSV and write array JSON to `out_path`.

    output format:
      [ {"schema": [{name, rawName, type, description}]}, {"id":.., "raw": {...}}, ... ]
    """
    if not os.path.exists(raw_csv_path):
        return
    df = pd.read_csv(raw_csv_path)
    cols = list(df.columns)
    id_col = "id" if "id" in cols else ("ID" if "ID" in cols else None)

    # build schema
    schema = []
    for c in cols:
        if c == id_col:
            continue
        base, desc = _parse_col_descriptor(c)
        ctype = "categorical" if _is_categorical(desc, df[c]) else "numeric"
        schema.append(
            {
                "name": base,
                "rawName": c,
                "type": ctype,
                "description": desc or "",
            }
        )

    items: List[Dict[str, Any]] = []
    for idx, row in df.iterrows():
        rid = (
            int(_to_native(row[id_col]))
            if id_col is not None and not pd.isna(row[id_col])
            else int(idx)
        )
        raw_map = {}
        for c in cols:
            if c == id_col:
                continue
            raw_map[c] = _to_native(row[c])
        items.append({"id": rid, "raw": raw_map})

    data = [{"schema": schema}] + items
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def process_coord_row(
    row: pd.Series,
    zarr_row_id: int,
    display_position: int,
    n_per_chunk: int,
) -> Dict[str, Any]:
    """process a single coordinate row.

    ``zarr_row_id`` is the original cell index (Zarr axis 1 / CSV row).
    ``display_position`` is 0..K-1 in packed atlas order (chunk_id / local_index).
    """
    x_raw = float(row.get("X_centroid", 0))
    y_raw = float(row.get("Y_centroid", 0))
    
    # Extract hierarchical clustering fields if present
    extra = {}
    # support 6 semantic levels: rank_L0..rank_L5 / cluster_L0..cluster_L5
    for level in range(6):
        rank_key = f"rank_L{level}"
        if rank_key in row:
            # Handle potential NaN or float/int conversion
            val = row[rank_key]
            iv = _safe_int(val)
            if iv is not None:
                extra[rank_key] = iv
        
        cluster_key = f"cluster_L{level}"
        if cluster_key in row:
            val = row[cluster_key]
            iv = _safe_int(val)
            if iv is not None:
                extra[cluster_key] = iv

    base = {
        "id": int(zarr_row_id),
        "chunk_id": int(display_position // n_per_chunk),
        "local_index": int(display_position % n_per_chunk),
        "raw": {"x": x_raw, "y": y_raw, "z": 0},
        "umap2d": {
            "x": float(row.get("umap2_x", x_raw)),
            "y": float(row.get("umap2_y", y_raw)),
            "z": 0,
        },
        "umap3d": {
            "x": float(row.get("umap3_x", x_raw)),
            "y": float(row.get("umap3_y", y_raw)),
            "z": float(row.get("umap3_z", 0)),
        },
        # Safely convert label as well to avoid invalid values like "NA" breaking the whole process
        "label": (
            _safe_int(row.get("label"))
            if row.get("label") is not None
            else _safe_int(row.get("clustering"))
        ) or stable_label(int(zarr_row_id)),
    }
    base.update(extra)
    return base


_AUTO_P_LO = 1.0
_AUTO_P_HI = 99.0
# Histogram paths: stride voxels before bincount when volume is huge (percentiles ~unchanged).
_MAX_HIST_PIXELS = 4_000_000
# Float / wide-range int: cap samples so percentile stays cheap (no full-array sort).
_MAX_AUTO_SAMPLE = 2_000_000


def _hist_sample_flat(flat: np.ndarray) -> np.ndarray:
    n = int(flat.size)
    if n <= _MAX_HIST_PIXELS:
        return flat
    step = int(np.ceil(n / _MAX_HIST_PIXELS))
    return flat[::step]


def _auto_lo_hi_from_counts(counts: np.ndarray, value_offset: float = 0.0) -> Tuple[float, float]:
    """1st / 99th percentile mass on a nonnegative integer histogram; one ``cumsum``."""
    total = counts.sum(dtype=np.float64)
    if total <= 0:
        return value_offset, value_offset
    cdf = np.cumsum(counts, dtype=np.float64)

    def value_at(p: float) -> float:
        thr = (p / 100.0) * float(total)
        thr = min(max(thr, np.nextafter(0.0, 1.0)), float(total))
        idx = int(np.searchsorted(cdf, thr, side="left"))
        return float(min(max(idx, 0), counts.size - 1)) + value_offset

    return value_at(_AUTO_P_LO), value_at(_AUTO_P_HI)


def _pixel_stats_from_array(channel_data: np.ndarray) -> Dict[str, float]:
    """Contrast hint for UI: only auto_min / auto_max (slider bounds stay 0–65535 in client).

    - uint8 / uint16: ``bincount`` (+ optional stride) + single CDF for two percentiles.
    - int16: shifted into 0..65535 then same.
    - Other dtypes: strided subsample + ``np.percentile`` on at most ``_MAX_AUTO_SAMPLE`` values.
    """
    if channel_data.size == 0:
        return {"auto_min": 0.0, "auto_max": 0.0}

    dt = channel_data.dtype
    flat = _hist_sample_flat(channel_data.ravel())

    if dt == np.uint8 or (getattr(dt, "kind", None) == "u" and dt.itemsize == 1):
        counts = np.bincount(flat)
        lo, hi = _auto_lo_hi_from_counts(counts)
        return {"auto_min": lo, "auto_max": hi}

    if dt == np.uint16 or (getattr(dt, "kind", None) == "u" and dt.itemsize == 2):
        # No fixed minlength: shorter histogram when dynamic range is narrow (faster cumsum).
        counts = np.bincount(flat)
        lo, hi = _auto_lo_hi_from_counts(counts)
        return {"auto_min": lo, "auto_max": hi}

    if dt == np.int16 or (getattr(dt, "kind", None) == "i" and dt.itemsize == 2):
        shifted = np.clip(flat.astype(np.int32, copy=False) + 32768, 0, 65535)
        counts = np.bincount(shifted)
        lo, hi = _auto_lo_hi_from_counts(counts, value_offset=-32768.0)
        return {"auto_min": lo, "auto_max": hi}

    # Fallback: subsample then percentile (avoids O(n log n) on full volume).
    x = flat.astype(np.float32, copy=False)
    n = int(x.size)
    if n > _MAX_AUTO_SAMPLE:
        step = int(np.ceil(n / _MAX_AUTO_SAMPLE))
        x = x[::step]
    lo, hi = np.percentile(x, [_AUTO_P_LO, _AUTO_P_HI])
    return {"auto_min": float(lo), "auto_max": float(hi)}


def _channel_stats_max_threads(limit: int) -> int:
    try:
        raw = int(os.environ.get("CHANNEL_STATS_MAX_THREADS", "4"))
    except ValueError:
        raw = 4
    return max(1, min(raw, limit))


def get_channel_info(df: pd.DataFrame, img):
    """Extract channel information using Zarr image statistics (assumes Zarr is available)."""
    columns = list(df.columns)
    channel_columns = columns[9:]  # columns after the 9th are channels

    def _one(i: int) -> Dict[str, Any]:
        col_name = channel_columns[i]
        channel_data = img[i, :, :, :]
        stats = _pixel_stats_from_array(channel_data)
        return {
            "id": i,
            "name": col_name,
            "column_index": i + 9,
            "pixel_value_range": stats,
        }

    n = len(channel_columns)
    if n == 0:
        return []
    if n == 1:
        return [_one(0)]
    workers = _channel_stats_max_threads(n)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(_one, range(n)))


def _channel_list_csv_path() -> str:
    return os.path.join(DATA_DIR, "channel_list.csv")


def _read_channel_entries_from_csv(path: str) -> List[Dict[str, Any]]:
    """Read channel entries from channel_list.csv.

    Supported formats:
      - Prefer column header 'channel_name' (case-insensitive)
      - Fallbacks: 'name', 'channel', 'marker'
      - If an id column exists (e.g., 'channel_id', 'id', 'index'), map names by id
      - Optional raw index columns: 'raw_index', 'raw', 'ome_index', 'ome_c', 'c'
      - If no id column, keep file order
    """
    if not os.path.exists(path):
        return []
    df = pd.read_csv(path)
    if df is None or df.empty:
        return []
    # normalize column names
    original_cols = list(df.columns)
    lower_map = {str(c).strip().lower(): c for c in original_cols}
    # pick name column
    name_key_candidates = ["channel_name", "name", "channel", "marker", "label"]
    name_col = None
    for k in name_key_candidates:
        if k in lower_map:
            name_col = lower_map[k]
            break
    if name_col is None:
        # fall back: if there's more than one column, prefer the last column (often the name),
        # otherwise use the first column
        name_col = original_cols[-1] if len(original_cols) > 1 else original_cols[0]

    # pick id column if any
    id_key_candidates = ["channel_id", "id", "index"]
    id_col = None
    for k in id_key_candidates:
        if k in lower_map:
            id_col = lower_map[k]
            break
    # pick raw index column if any (1-based OME channel index from CSV)
    raw_idx_key_candidates = ["raw_index", "raw", "ome_index", "ome_c", "c"]
    raw_idx_col = None
    for k in raw_idx_key_candidates:
        if k in lower_map:
            raw_idx_col = lower_map[k]
            break

    # build entries
    def _clean_str(v: Any) -> str:
        s = str(v).strip()
        return "" if s.lower() == "nan" else s

    def _safe_raw_index(v: Any) -> Optional[int]:
        iv = _safe_int(v)
        if iv is None:
            return None
        return iv if iv >= 1 else None

    if id_col is not None:
        pairs = []
        for _, row in df.iterrows():
            try:
                rid = int(row[id_col])
            except Exception:
                continue
            nm = _clean_str(row.get(name_col, ""))
            raw_idx = _safe_raw_index(row.get(raw_idx_col)) if raw_idx_col else None
            if nm:
                pairs.append((rid, nm, raw_idx))
        if not pairs:
            return []
        max_id = max(r for r, _, _ in pairs)
        out: List[Optional[Dict[str, Any]]] = [None for _ in range(max_id + 1)]
        for rid, nm, raw_idx in pairs:
            if 0 <= rid < len(out):
                out[rid] = {
                    "id": rid,
                    "name": nm,
                    "raw_index": raw_idx,
                }
        # fill empty slots with defaults
        for i in range(len(out)):
            if out[i] is None:
                out[i] = {
                    "id": i,
                    "name": f"ch_{i}",
                    "raw_index": None,
                }
        return [x for x in out if x is not None]
    else:
        entries: List[Dict[str, Any]] = []
        for i, row in df.iterrows():
            s = _clean_str(row.get(name_col, ""))
            if not s:
                continue
            raw_idx = _safe_raw_index(row.get(raw_idx_col)) if raw_idx_col else None
            entries.append({
                "id": len(entries),
                "name": s,
                "raw_index": raw_idx,
            })
        return entries


def get_channel_info_from_entries(entries: List[Dict[str, Any]], img) -> List[Dict[str, Any]]:
    """Build channel info from ordered channel entries and Zarr image statistics."""
    names = [str(e.get("name", "")).strip() for e in entries]
    raw_index_by_id = {
        int(e["id"]): _safe_int(e.get("raw_index"))
        for e in entries
        if _safe_int(e.get("id")) is not None
    }
    if img is None:
        return [
            {
                "id": i,
                "name": (names[i] if i < len(names) else f"ch_{i}"),
                "raw_index": (
                    raw_index_by_id.get(i)
                    if raw_index_by_id.get(i) is not None and raw_index_by_id.get(i) >= 1
                    else None
                ),
                "ome_c": (
                    int(raw_index_by_id.get(i)) - 1
                    if raw_index_by_id.get(i) is not None and raw_index_by_id.get(i) >= 1
                    else None
                ),
                "pixel_value_range": {
                    "auto_min": 0.0,
                    "auto_max": 65535.0,
                },
            }
            for i in range(len(names))
        ]
    try:
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    except Exception:
        C = len(names)
    limit = min(len(names), int(C))

    def _build_one(i: int) -> Dict[str, Any]:
        ch_name = names[i] if i < len(names) else f"ch_{i}"
        raw_idx = raw_index_by_id.get(i)
        raw_idx_i = int(raw_idx) if raw_idx is not None and raw_idx >= 1 else None
        try:
            channel_data = img[i, :, :, :]
            stats = _pixel_stats_from_array(channel_data)
        except Exception:
            stats = {
                "auto_min": 0.0,
                "auto_max": 65535.0,
            }
        return {
            "id": i,
            "name": ch_name,
            "raw_index": raw_idx_i,
            "ome_c": (raw_idx_i - 1) if raw_idx_i is not None else None,
            "pixel_value_range": stats,
        }

    if limit <= 0:
        return []
    if limit == 1:
        return [_build_one(0)]
    workers = _channel_stats_max_threads(limit)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(_build_one, range(limit)))


def generate_channel_info_only() -> Optional[List[Dict[str, Any]]]:
    """Generate channel_info.json prioritizing channel_list.csv if present.

    Returns the channels list if generated, else None.
    """
    try:
        img = open_zarr()
    except Exception:
        img = None
    # 1) Prefer explicit channel_list.csv
    ch_list_path = _channel_list_csv_path()
    if os.path.exists(ch_list_path):
        entries = _read_channel_entries_from_csv(ch_list_path)
        channels = get_channel_info_from_entries(entries, img)
        with open(os.path.join(DATA_DIR, "channel_info.json"), "w", encoding="utf-8") as f:
            json.dump({"channels": channels, "total_channels": len(channels)}, f, ensure_ascii=False, indent=2)
        return channels

    # 2) Fallback to data.csv column names (if available)
    csv_path = os.path.join(DATA_DIR, "data.csv")
    if os.path.exists(csv_path):
        try:
            df = pd.read_csv(csv_path)
            if img is None:
                try:
                    img = open_zarr()
                except Exception:
                    img = None
            channels = get_channel_info(df, img) if img is not None else []
            with open(os.path.join(DATA_DIR, "channel_info.json"), "w", encoding="utf-8") as f:
                json.dump({"channels": channels, "total_channels": len(channels)}, f, ensure_ascii=False, indent=2)
            return channels
        except Exception:
            return None
    return None


async def generate_json_files() -> None:
    """generate coords.json and channel_info.json.

    - coords.json: from data.csv (if exists)
    - channel_info.json: prefer channel_list.csv; fallback to data.csv
    """
    csv_path = os.path.join(DATA_DIR, "data.csv")
    try:
        # coords.json generation (requires data.csv + zarr)
        coords_generated = False
        coords: List[Dict[str, Any]] = []
        if os.path.exists(csv_path):
            df = pd.read_csv(csv_path)
            try:
                img = open_zarr()
                C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
                N = min(len(df), N)
            except Exception:
                # If zarr not available, skip coords generation
                img = None
                n_per_chunk = 1
                N = len(df)
            # Subset only when Zarr is present (atlas/coords alignment); otherwise keep all rows.
            if img is None:
                indices = np.arange(N, dtype=np.int64)
            else:
                indices = compute_display_indices(df, N)
            if int(indices.size) == int(N):
                if subset_artifacts_exist():
                    clear_display_subset_artifacts()
                    clear_cache_dir()
            else:
                save_display_subset(N, indices)
                clear_cache_dir()
            coords = [
                process_coord_row(df.iloc[int(orig)], int(orig), pos, n_per_chunk)
                for pos, orig in enumerate(indices)
            ]
            with open(os.path.join(DATA_DIR, "coords.json"), "w", encoding="utf-8") as f:
                json.dump(coords, f, ensure_ascii=False, indent=2)
            coords_generated = True

        # channel_info.json generation (prefer explicit channel list)
        channels = generate_channel_info_only()

        # Log
        coords_msg = f"coords.json ({len(coords) if coords_generated else 0} points)" if coords_generated else "coords.json (skipped)"
        ch_msg = f"channel_info.json ({len(channels) if channels is not None else 0} channels)" if channels is not None else "channel_info.json (skipped)"
        print(f"Generated JSON files: {coords_msg}, {ch_msg}")
    except Exception as e:
        print(f"Generated JSON files failed: {str(e)}")


__all__ = [
    "generate_raw_json",
    "process_coord_row",
    "get_channel_info",
    "get_channel_info_from_entries",
    "generate_channel_info_only",
    "generate_json_files",
]


