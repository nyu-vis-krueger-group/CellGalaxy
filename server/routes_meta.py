import os

import pandas as pd
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .config import DATA_DIR, ZARR_DIR, OME_TIFF_PATH
from .data_paths import (
    channel_list_csv_path,
    data_csv_path,
    features_npy_path,
    generating_marker_path,
    raw_csv_json_paths,
    zooming_csv_path,
)
from .data_utils import get_channel_info, process_coord_row, generate_channel_info_only
from .display_subset import display_atlas_n_and_chunks, load_display_indices, subset_artifacts_exist
from .zarr_utils import open_zarr, meta_from_img, grid_for_count, get_default_tile


router = APIRouter()


def _has_zarr() -> bool:
    """Check whether zarr directory contains any data."""
    if not os.path.isdir(ZARR_DIR):
        return False
    try:
        return any(os.scandir(ZARR_DIR))
    except Exception:
        # be conservative: if we cannot scan, assume there is some data
        return True


def _raw_annotation_columns() -> dict:
    """If raw.json exists, return which annotation columns are present (celltype, neigh_names)."""
    _, raw_json = raw_csv_json_paths()
    out = {"celltype": False, "neigh_names": False}
    if not os.path.exists(raw_json):
        return out
    try:
        import json
        with open(raw_json, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list) or len(data) < 1:
            return out
        schema = data[0].get("schema") if isinstance(data[0], dict) else None
        if not isinstance(schema, list):
            return out
        names = set()
        for s in schema:
            if isinstance(s, dict):
                names.add((s.get("name") or s.get("rawName") or "").strip())
        out["celltype"] = "celltype" in names
        out["neigh_names"] = "neigh_names" in names
    except Exception:
        pass
    return out


@router.get("/upload/status")
async def upload_status():
    csv_path = data_csv_path()
    raw_csv, raw_json = raw_csv_json_paths()
    raw_cols = _raw_annotation_columns()
    return {
        "zarr": _has_zarr(),
        "csv": os.path.exists(csv_path),
        "raw": os.path.exists(raw_csv) and os.path.exists(raw_json),
        "raw_annotation_columns": raw_cols,
        "feat": os.path.exists(features_npy_path()),
        "channels": os.path.exists(channel_list_csv_path()),
        "zooming": os.path.exists(zooming_csv_path()),
        "ome_tiff": os.path.exists(OME_TIFF_PATH),
        "generating": os.path.exists(generating_marker_path()),
    }


@router.get("/channels")
async def get_channels():
    try:
        ch_json = os.path.join(DATA_DIR, "channel_info.json")
        if os.path.exists(ch_json):
            try:
                import json
                with open(ch_json, "r", encoding="utf-8") as f:
                    data = json.load(f)
                channels = data.get("channels", [])
                return {"channels": channels, "total_channels": len(channels)}
            except Exception:
                pass
        channels = generate_channel_info_only()
        if channels is not None:
            return {"channels": channels, "total_channels": len(channels)}
        csv_path = data_csv_path()
        if not os.path.exists(csv_path):
            return {"channels": [], "total_channels": 0}
        df = pd.read_csv(csv_path)
        img = open_zarr()
        channels = get_channel_info(df, img)
        return {"channels": channels, "total_channels": len(channels)}
    except Exception:
        return {"channels": [], "total_channels": 0}


@router.get("/meta")
def meta():
    if not os.path.isdir(ZARR_DIR):
        return {"error": "No data loaded", "message": "Please upload zarr data first"}
    try:
        img = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
        n_disp, n_chunks_eff = display_atlas_n_and_chunks(N, n_per_chunk)
        rows, cols = grid_for_count(n_per_chunk)
        tile = get_default_tile()
        atlas_w = cols * tile
        atlas_h = rows * tile
        return {
            "C": int(C),
            "N": int(n_disp),
            "N_zarr": int(N),
            "display_subset": bool(subset_artifacts_exist()),
            "H": int(H),
            "W": int(W),
            "dtype": str(img.dtype),
            "chunks": tuple(int(x) for x in img.chunks),
            "n_chunks": int(n_chunks_eff),
            "n_per_chunk": int(n_per_chunk),
            "atlas": {
                "tile": int(tile),
                "cols": int(cols),
                "rows": int(rows),
                "width": int(atlas_w),
                "height": int(atlas_h),
            },
        }
    except Exception as e:
        return {"error": "Failed to load data", "message": str(e)}


def _cluster_dominant_annotations() -> dict | None:
    """Compute dominant celltype and neigh_names per (level, cluster_id) from coords + raw.json."""
    import json
    from collections import Counter

    coords_path = os.path.join(DATA_DIR, "coords.json")
    _, raw_json = raw_csv_json_paths()
    if not os.path.exists(coords_path) or not os.path.exists(raw_json):
        return None
    try:
        with open(coords_path, "r", encoding="utf-8") as f:
            coords = json.load(f)
        with open(raw_json, "r", encoding="utf-8") as f:
            raw_data = json.load(f)
    except Exception:
        return None
    if not isinstance(coords, list) or not isinstance(raw_data, list) or len(raw_data) < 2:
        return None
    id_to_raw = {}
    for i in range(1, len(raw_data)):
        row = raw_data[i]
        if not isinstance(row, dict):
            continue
        rid = row.get("id")
        raw_obj = row.get("raw")
        if not isinstance(raw_obj, dict):
            continue
        id_to_raw[rid] = {
            "celltype": raw_obj.get("celltype"),
            "neigh_names": raw_obj.get("neigh_names"),
        }
    levels_out = {}
    for level in range(6):
        cluster_key = f"cluster_L{level}"
        clusters = {}  # cluster_id -> list of (celltype, neigh_names)
        for c in coords:
            if not isinstance(c, dict):
                continue
            cid = c.get("id")
            cluster_id = c.get(cluster_key)
            if cluster_id is None:
                continue
            raw_vals = id_to_raw.get(cid)
            if not raw_vals:
                continue
            cluster_id = int(cluster_id) if isinstance(cluster_id, (int, float)) else cluster_id
            if cluster_id not in clusters:
                clusters[cluster_id] = []
            ct = raw_vals.get("celltype")
            nn = raw_vals.get("neigh_names")
            if ct is not None and str(ct).strip():
                clusters[cluster_id].append(("celltype", str(ct).strip()))
            if nn is not None and str(nn).strip():
                clusters[cluster_id].append(("neigh_names", str(nn).strip()))
        level_out = {}
        for cluster_id, pairs in clusters.items():
            ct_vals = [v for k, v in pairs if k == "celltype"]
            nn_vals = [v for k, v in pairs if k == "neigh_names"]
            level_out[str(cluster_id)] = {
                "celltype": Counter(ct_vals).most_common(1)[0][0] if ct_vals else None,
                "neigh_names": Counter(nn_vals).most_common(1)[0][0] if nn_vals else None,
            }
        levels_out[str(level)] = level_out
    return {"levels": levels_out}


@router.get("/cluster_dominant_annotations")
def cluster_dominant_annotations():
    """Return dominant celltype and neigh_names per cluster at each level (requires coords.json + raw.json with those columns)."""
    data = _cluster_dominant_annotations()
    if data is None:
        return JSONResponse({"levels": {}}, status_code=200)
    return data


@router.get("/coords")
def coords(limit: int | None = Query(None)):
    csv_path = data_csv_path()
    if not os.path.exists(csv_path):
        return JSONResponse([])
    try:
        df = pd.read_csv(csv_path)
        img = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
        N = min(len(df), N)
        ind = load_display_indices()
        if ind is None:
            max_i = N if limit is None else min(N, int(limit))
            row_ids = list(range(max_i))
        else:
            k = int(ind.size)
            max_i = k if limit is None else min(k, int(limit))
            row_ids = [int(ind[i]) for i in range(max_i)]

        out = [
            process_coord_row(df.iloc[zid], zid, pos, n_per_chunk)
            for pos, zid in enumerate(row_ids)
        ]
        return JSONResponse(out)
    except Exception:
        return JSONResponse([])


