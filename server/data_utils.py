import json
import os
from typing import Any, List, Dict, Optional

import numpy as np
import pandas as pd

from .config import DATA_DIR
from .data_paths import spatial_coords_path
from .display_subset import (
    clear_display_subset_artifacts,
    compute_display_indices,
    save_display_subset,
    subset_artifacts_exist,
)
from .zarr_utils import clear_cache_dir, open_zarr, meta_from_img, stable_label


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


def process_spatial_coord_row(row: pd.Series, zarr_row_id: int) -> Dict[str, Any]:
    """Full-tissue record for spatial hover pick + UMAP geometric selection."""
    x_raw = float(row.get("X_centroid", 0))
    y_raw = float(row.get("Y_centroid", 0))
    return {
        "id": int(zarr_row_id),
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
    }


def get_channel_info(df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Extract channel metadata from data.csv column names (no Zarr pixel stats)."""
    columns = list(df.columns)
    channel_columns = columns[9:]  # columns after the 9th are channels
    return [
        {
            "id": i,
            "name": col_name,
            "column_index": i + 9,
        }
        for i, col_name in enumerate(channel_columns)
    ]


def _channel_list_csv_path() -> str:
    return os.path.join(DATA_DIR, "channel_list.csv")


def _read_channel_entries_from_csv(path: str) -> List[Dict[str, Any]]:
    """Read channel entries from channel_list.csv.

    Supported formats:
      - Prefer column header 'channel_name' (case-insensitive)
      - Fallbacks: 'name', 'channel', 'marker'
      - If an id column exists (e.g., 'channel_id', 'id', 'index'), map names by id
      - Optional zarr index columns: 'zarr_index', 'zarr_c', 'index_in_zarr'
      - Optional legacy raw index columns: 'raw_index', 'raw', 'ome_index', 'ome_c', 'c'
      - channel_id is the OME-TIFF 0-based channel index; zarr_index maps to Zarr c (empty = OME-only)
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
    zarr_idx_key_candidates = ["zarr_index", "zarr_c", "index_in_zarr", "zarr"]
    zarr_idx_col = None
    for k in zarr_idx_key_candidates:
        if k in lower_map:
            zarr_idx_col = lower_map[k]
            break
    # Legacy raw index column (1-based OME); prefer channel_id as ome_c when present
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

    def _safe_zarr_index(v: Any) -> Optional[int]:
        if v is None:
            return None
        s = str(v).strip()
        if not s or s.lower() in ("na", "nan", "none", "-", "null"):
            return None
        iv = _safe_int(v)
        if iv is None or iv < 0:
            return None
        return iv

    if id_col is not None:
        pairs = []
        for _, row in df.iterrows():
            try:
                rid = int(row[id_col])
            except Exception:
                continue
            nm = _clean_str(row.get(name_col, ""))
            raw_idx = _safe_raw_index(row.get(raw_idx_col)) if raw_idx_col else None
            zarr_idx = _safe_zarr_index(row.get(zarr_idx_col)) if zarr_idx_col else None
            if nm:
                pairs.append((rid, nm, raw_idx, zarr_idx, zarr_idx_col is not None))
        if not pairs:
            return []
        max_id = max(r for r, _, _, _, _ in pairs)
        out: List[Optional[Dict[str, Any]]] = [None for _ in range(max_id + 1)]
        for rid, nm, raw_idx, zarr_idx, has_zarr_col in pairs:
            if 0 <= rid < len(out):
                entry: Dict[str, Any] = {
                    "id": rid,
                    "name": nm,
                    "raw_index": raw_idx,
                }
                if has_zarr_col:
                    entry["zarr_index"] = zarr_idx
                out[rid] = entry
        # fill empty slots with defaults
        for i in range(len(out)):
            if out[i] is None:
                slot: Dict[str, Any] = {
                    "id": i,
                    "name": f"ch_{i}",
                    "raw_index": None,
                }
                if zarr_idx_col is not None:
                    slot["zarr_index"] = None
                out[i] = slot
        return [x for x in out if x is not None]
    else:
        entries: List[Dict[str, Any]] = []
        for i, row in df.iterrows():
            s = _clean_str(row.get(name_col, ""))
            if not s:
                continue
            raw_idx = _safe_raw_index(row.get(raw_idx_col)) if raw_idx_col else None
            entry: Dict[str, Any] = {
                "id": len(entries),
                "name": s,
                "raw_index": raw_idx,
            }
            if zarr_idx_col is not None:
                entry["zarr_index"] = _safe_zarr_index(row.get(zarr_idx_col))
            entries.append(entry)
        return entries


def get_channel_info_from_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Build channel info from channel_list.csv entries (contrast range comes from OME-TIFF client-side).

    channel_id = OME-TIFF 0-based index (ome_c). zarr_index maps to Zarr c when present.
    Legacy CSVs without zarr_index column: zarr_c defaults to channel_id.
    """
    has_zarr_column = any("zarr_index" in e for e in entries)

    def _entry_zarr_c(e: Dict[str, Any], cid: int) -> Optional[int]:
        if "zarr_index" in e:
            z = _safe_int(e.get("zarr_index"))
            if z is None:
                return None
            return int(z) if int(z) >= 0 else None
        z = _safe_int(e.get("zarr_c"))
        if z is not None and int(z) >= 0:
            return int(z)
        if not has_zarr_column:
            return cid
        return None

    channels: List[Dict[str, Any]] = []
    for e in entries:
        cid = _safe_int(e.get("id"))
        if cid is None:
            cid = len(channels)
        ch_name = str(e.get("name", "")).strip() or f"ch_{cid}"
        ome_c = cid
        zarr_c = _entry_zarr_c(e, cid)
        channels.append({
            "id": cid,
            "name": ch_name,
            "ome_c": ome_c,
            "zarr_c": zarr_c,
        })
    return sorted(channels, key=lambda x: x["id"])


def generate_channel_info_only() -> Optional[List[Dict[str, Any]]]:
    """Generate channel_info.json prioritizing channel_list.csv if present.

    Returns the channels list if generated, else None.
    """
    # 1) Prefer explicit channel_list.csv
    ch_list_path = _channel_list_csv_path()
    if os.path.exists(ch_list_path):
        entries = _read_channel_entries_from_csv(ch_list_path)
        channels = get_channel_info_from_entries(entries)
        with open(os.path.join(DATA_DIR, "channel_info.json"), "w", encoding="utf-8") as f:
            json.dump({"channels": channels, "total_channels": len(channels)}, f, ensure_ascii=False, indent=2)
        return channels

    # 2) Fallback to data.csv column names (if available)
    csv_path = os.path.join(DATA_DIR, "data.csv")
    if os.path.exists(csv_path):
        try:
            df = pd.read_csv(csv_path)
            channels = get_channel_info(df)
            with open(os.path.join(DATA_DIR, "channel_info.json"), "w", encoding="utf-8") as f:
                json.dump({"channels": channels, "total_channels": len(channels)}, f, ensure_ascii=False, indent=2)
            return channels
        except Exception:
            return None
    return None


def run_generate_json_files() -> None:
    """Sync CPU-bound JSON generation (run via asyncio.to_thread from async callers)."""
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

            # Full spatial coords for hover pick (all CSV rows; compact JSON).
            spatial_coords = [
                process_spatial_coord_row(df.iloc[i], i) for i in range(len(df))
            ]
            with open(spatial_coords_path(), "w", encoding="utf-8") as f:
                json.dump(spatial_coords, f, ensure_ascii=False, separators=(",", ":"))
            print(f"Generated spatial_coords.json ({len(spatial_coords)} points)")

        # channel_info.json generation (prefer explicit channel list)
        channels = generate_channel_info_only()

        # Log
        coords_msg = f"coords.json ({len(coords) if coords_generated else 0} points)" if coords_generated else "coords.json (skipped)"
        ch_msg = f"channel_info.json ({len(channels) if channels is not None else 0} channels)" if channels is not None else "channel_info.json (skipped)"
        print(f"Generated JSON files: {coords_msg}, {ch_msg}")
    except Exception as e:
        print(f"Generated JSON files failed: {str(e)}")


async def generate_json_files() -> None:
    """Generate coords.json, spatial_coords.json, and channel_info.json."""
    import asyncio

    await asyncio.to_thread(run_generate_json_files)


__all__ = [
    "generate_raw_json",
    "process_coord_row",
    "get_channel_info",
    "get_channel_info_from_entries",
    "generate_channel_info_only",
    "run_generate_json_files",
    "generate_json_files",
]


