import json
import os
from typing import Any, List, Dict, Optional, Tuple

import numpy as np
import pandas as pd

from .config import DATA_DIR, ZARR_DIR
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
        # If we cannot rely on pandas for the check, fall back to the logic below
        pass
    # Already an int
    if isinstance(val, int):
        return val
    # Try direct int() conversion
    try:
        return int(val)
    except Exception:
        pass
    # Then try converting via float first, e.g. "1.0"
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


def process_coord_row(row: pd.Series, idx: int, n_per_chunk: int) -> Dict[str, Any]:
    """process a single coordinate row"""
    x_raw = float(row.get("X_centroid", 0))
    y_raw = float(row.get("Y_centroid", 0))
    
    # Extract hierarchical clustering fields if present
    extra = {}
    # 支持 rank_L0..rank_L5 / cluster_L0..cluster_L5 共 6 个语义层级
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
        "id": idx,
        "chunk_id": int(idx // n_per_chunk),
        "local_index": int(idx % n_per_chunk),
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
        ) or stable_label(idx),
    }
    base.update(extra)
    return base


def _pixel_stats_from_array(channel_data: np.ndarray) -> Dict[str, float]:
    """
    计算单个通道的像素统计信息，用于前端 intensity 窗宽/自动窗位：

    - data_min / data_max: 全局真实最小/最大值（用于 slider 总范围）
    - auto_min / auto_max: 百分位裁剪后的推荐显示范围（用于“Auto” 按钮和默认窗位）
    """
    flat = channel_data.astype(np.float32).ravel()
    if flat.size == 0:
        return {
            "data_min": 0.0,
            "data_max": 0.0,
            "auto_min": 0.0,
            "auto_max": 0.0,
        }

    data_min = float(np.min(flat))
    data_max = float(np.max(flat))

    # 使用 1% / 99% 百分位作为自动窗位，避免极少数 outlier 拉开对比度
    auto_low, auto_high = np.percentile(flat, [1.0, 99.0])
    return {
        "data_min": data_min,
        "data_max": data_max,
        "auto_min": float(auto_low),
        "auto_max": float(auto_high),
    }


def get_channel_info(df: pd.DataFrame, img):
    """Extract channel information using Zarr image statistics (assumes Zarr is available)."""
    columns = list(df.columns)
    channel_columns = columns[9:]  # columns after the 9th are channels
    channels = []
    for i, col_name in enumerate(channel_columns):
        # use Zarr image statistics pixel range
        channel_data = img[i, :, :, :]
        stats = _pixel_stats_from_array(channel_data)
        channels.append(
            {
                "id": i,
                "name": col_name,
                "column_index": i + 9,
                "pixel_value_range": stats,
            }
        )
    return channels


def _channel_list_csv_path() -> str:
    return os.path.join(DATA_DIR, "channel_list.csv")


def _read_channel_names_from_csv(path: str) -> List[str]:
    """Read channel names from a CSV file.

    Supported formats:
      - Prefer column header 'channel_name' (case-insensitive)
      - Fallbacks: 'name', 'channel', 'marker'
      - If an id column exists (e.g., 'channel_id', 'id', 'index'), map names by id
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

    # build names
    def _clean_str(v: Any) -> str:
        s = str(v).strip()
        return "" if s.lower() == "nan" else s

    if id_col is not None:
        pairs = []
        for _, row in df.iterrows():
            try:
                rid = int(row[id_col])
            except Exception:
                continue
            nm = _clean_str(row.get(name_col, ""))
            if nm:
                pairs.append((rid, nm))
        if not pairs:
            return []
        max_id = max(r for r, _ in pairs)
        out = ["" for _ in range(max_id + 1)]
        for rid, nm in pairs:
            if 0 <= rid < len(out):
                out[rid] = nm
        # remove trailing empty names if any
        while len(out) > 0 and out[-1] == "":
            out.pop()
        # fill empty slots with default names like ch_{i}
        for i in range(len(out)):
            if not out[i]:
                out[i] = f"ch_{i}"
        return out
    else:
        names: List[str] = []
        for v in df[name_col].tolist():
            s = _clean_str(v)
            if s:
                names.append(s)
        return names


def get_channel_info_from_names(names: List[str], img) -> List[Dict[str, Any]]:
    """Build channel info from an ordered name list and Zarr image statistics."""
    channels: List[Dict[str, Any]] = []
    if img is None:
        return [
            {
                "id": i,
                "name": (names[i] if i < len(names) else f"ch_{i}"),
                "pixel_value_range": {
                    "data_min": 0.0,
                    "data_max": 0.0,
                    "auto_min": 0.0,
                    "auto_max": 0.0,
                },
            }
            for i in range(len(names))
        ]
    try:
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    except Exception:
        C = len(names)
    limit = min(len(names), int(C))
    for i in range(limit):
        ch_name = names[i] if i < len(names) else f"ch_{i}"
        try:
            channel_data = img[i, :, :, :]
            stats = _pixel_stats_from_array(channel_data)
        except Exception:
            stats = {
                "data_min": 0.0,
                "data_max": 0.0,
                "auto_min": 0.0,
                "auto_max": 0.0,
            }
        channels.append({
            "id": i,
            "name": ch_name,
            "pixel_value_range": stats,
        })
    return channels


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
        names = _read_channel_names_from_csv(ch_list_path)
        channels = get_channel_info_from_names(names, img)
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
            coords = [process_coord_row(df.iloc[idx], idx, n_per_chunk) for idx in range(N)]
            with open(os.path.join(DATA_DIR, "coords.json"), "w", encoding="utf-8") as f:
                json.dump(coords, f, ensure_ascii=False, indent=2)
            coords_generated = True

        # channel_info.json generation (prefer explicit channel list)
        channels = generate_channel_info_only()

        # Log
        coords_msg = f"coords.json ({len(coords) if os.path.exists(csv_path) else 0} points)" if coords_generated else "coords.json (skipped)"
        ch_msg = f"channel_info.json ({len(channels) if channels is not None else 0} channels)" if channels is not None else "channel_info.json (skipped)"
        print(f"Generated JSON files: {coords_msg}, {ch_msg}")
    except Exception as e:
        print(f"Generated JSON files failed: {str(e)}")


__all__ = [
    "generate_raw_json",
    "process_coord_row",
    "get_channel_info",
    "get_channel_info_from_names",
    "generate_channel_info_only",
    "generate_json_files",
]


