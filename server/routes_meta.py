import os

import pandas as pd
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .config import DATA_DIR, ZARR_DIR
from .data_utils import get_channel_info, process_coord_row, generate_channel_info_only
from .zarr_utils import open_zarr, meta_from_img, grid_for_count, get_default_tile


router = APIRouter()


def _csv_path() -> str:
    return os.path.join(DATA_DIR, "data.csv")


def _raw_paths() -> tuple[str, str]:
    return (
        os.path.join(DATA_DIR, "raw.csv"),
        os.path.join(DATA_DIR, "raw.json"),
    )

def _feat_path() -> str:
    return os.path.join(DATA_DIR, "features.npy")

def _channels_path() -> str:
    return os.path.join(DATA_DIR, "channel_list.csv")

def _zooming_path() -> str:
    return os.path.join(DATA_DIR, "cluster_multilevel_hierarchy.csv")

def _gen_marker_path() -> str:
    return os.path.join(DATA_DIR, ".generating")


def _has_zarr() -> bool:
    """Check whether zarr directory contains any data."""
    if not os.path.isdir(ZARR_DIR):
        return False
    try:
        return any(os.scandir(ZARR_DIR))
    except Exception:
        # be conservative: if we cannot scan, assume there is some data
        return True


@router.get("/upload/status")
async def upload_status():
    csv_path = _csv_path()
    raw_csv, raw_json = _raw_paths()
    return {
        "zarr": _has_zarr(),
        "csv": os.path.exists(csv_path),
        "raw": os.path.exists(raw_csv) and os.path.exists(raw_json),
        "feat": os.path.exists(_feat_path()),
        "channels": os.path.exists(_channels_path()),
        "zooming": os.path.exists(_zooming_path()),
        "generating": os.path.exists(_gen_marker_path()),
    }


@router.get("/channels")
async def get_channels():
    try:
        # Prefer pre-generated file if present
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
        # Else, try to generate on the fly (prefers channel_list.csv)
        channels = generate_channel_info_only()
        if channels is not None:
            return {"channels": channels, "total_channels": len(channels)}
        # Finally, fallback to data.csv direct computation
        csv_path = _csv_path()
        if not os.path.exists(csv_path):
            return {"channels": [], "total_channels": 0}
        df = pd.read_csv(csv_path)
        img = open_zarr()
        channels = get_channel_info(df, img)
        return {"channels": channels, "total_channels": len(channels)}
    except Exception as e:
        return {"channels": [], "total_channels": 0}


@router.get("/meta")
def meta():
    if not os.path.isdir(ZARR_DIR):
        return {"error": "No data loaded", "message": "Please upload zarr data first"}
    try:
        img = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
        rows, cols = grid_for_count(n_per_chunk)
        tile = get_default_tile()
        atlas_w = cols * tile
        atlas_h = rows * tile
        return {
            "C": int(C),
            "N": int(N),
            "H": int(H),
            "W": int(W),
            "dtype": str(img.dtype),
            "chunks": tuple(int(x) for x in img.chunks),
            "n_chunks": int(n_chunks),
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


@router.get("/coords")
def coords(limit: int | None = Query(None)):
    csv_path = _csv_path()
    if not os.path.exists(csv_path):
        return JSONResponse([])
    try:
        df = pd.read_csv(csv_path)
        img = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
        N = min(len(df), N)
        total = N if limit is None else min(N, int(limit))

        out = [
            process_coord_row(df.iloc[idx], idx, n_per_chunk) for idx in range(total)
        ]
        return JSONResponse(out)
    except Exception:
        return JSONResponse([])


