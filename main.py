from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Body, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
import uvicorn
import os
import zipfile
import shutil
import pandas as pd
import numpy as np
import io
import math
import json
import hashlib
from typing import Optional, List, Dict
from pydantic import BaseModel, Field
from PIL import Image
import zarr
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# import blosc
try:
    from numcodecs import blosc as _blosc
    _blosc.set_nthreads(max(1, os.cpu_count() or 1))
except Exception:
    pass

DATA_DIR = "public"
# remove cache directory
CACHE_DIR = os.path.join(os.getcwd(), ".cache")
ZARR_DIR = os.path.join(DATA_DIR, "output.zarr")
DEFAULT_TILE = 16

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

# =========================
# FastAPI application
# =========================
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/output.zarr", StaticFiles(directory=ZARR_DIR, check_dir=False), name="zarr_data")
app.mount("/public/cache", StaticFiles(directory=CACHE_DIR, check_dir=False), name="cache_files")
app.mount("/public", StaticFiles(directory=DATA_DIR, check_dir=False), name="public_files")

# =========================
# core tool functions
# =========================
# process level Zarr handle cache and thread pool
_IMG = None
_IMG_LOCK = threading.Lock()
_EXECUTOR = ThreadPoolExecutor(max_workers=max(2, (os.cpu_count() or 4)))
_PREWARM_SET = set()


def reset_zarr_handle():
    global _IMG
    with _IMG_LOCK:
        _IMG = None


def remove_path(path: str):
    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        elif os.path.exists(path):
            os.remove(path)
    except FileNotFoundError:
        pass
    except Exception as exc:
        print(f"failed to remove {path}: {exc}")


def clear_cache_dir():
    if os.path.isdir(CACHE_DIR):
        shutil.rmtree(CACHE_DIR)
    os.makedirs(CACHE_DIR, exist_ok=True)

def open_zarr():
    global _IMG
    if _IMG is not None:
        return _IMG
    with _IMG_LOCK:
        if _IMG is None:
            if not os.path.isdir(ZARR_DIR):
                raise RuntimeError(f"Zarr directory does not exist: {ZARR_DIR}")
            _IMG = zarr.open_array(ZARR_DIR, mode="r")
    return _IMG

def stable_label(idx: int, num_classes: int = 11) -> int:
    h = hashlib.sha1(str(idx).encode("utf-8")).hexdigest()
    return int(h[:8], 16) % num_classes

def meta_from_img(img):
    if img.ndim != 4:
        raise RuntimeError(f"Expected Zarr shape [C,N,H,W], actual {img.shape}")
    C, N, H, W = img.shape
    chunks = img.chunks
    if chunks is None:
        raise RuntimeError("Zarr array must be chunked")
    n_per_chunk = chunks[1]
    n_chunks = math.ceil(N / n_per_chunk)
    return C, N, H, W, chunks, n_chunks, n_per_chunk

def grid_for_count(n_items: int):
    cols = int(math.ceil(math.sqrt(n_items))) if n_items > 0 else 1
    rows = int(math.ceil(n_items / cols)) if n_items > 0 else 1
    return rows, cols

# =========================
# cache path helper (single channel: fixed path)
# =========================
def single_cache_path(channel: int, chunk_id: int, tile: int) -> str:
    ch_dir = os.path.join(CACHE_DIR, f"ch{int(channel)}", f"tile_{int(tile)}")
    os.makedirs(ch_dir, exist_ok=True)
    return os.path.join(ch_dir, f"chunk_{int(chunk_id)}.png")

# =========================
# data model
# =========================
class CompositeSpec(BaseModel):
    method: str = Field("weighted_mean", description='"mean"|"max"|"weighted_mean"')
    weights: Dict[int, float] = Field(default_factory=dict)
    colors: Dict[int, List[float]] = Field(default_factory=dict)
    alphas: Dict[int, float] = Field(default_factory=dict)

class AtlasRequest(BaseModel):
    channels: List[int]
    composite: CompositeSpec = Field(default_factory=CompositeSpec)
    tile: int = DEFAULT_TILE

# =========================
# image processing functions
# =========================
def norm01(x: np.ndarray, lo: float, hi: float, gamma: float = 1.0) -> np.ndarray:
    den = max(hi - lo, 1e-8)
    t = (x.astype(np.float32) - lo) / den
    t = np.clip(t, 0.0, 1.0)
    if gamma != 1.0:
        t = np.power(t, 1.0 / float(gamma), where=t > 0.0, out=t)
    return t

def tiles_to_atlas(rgba_tiles: np.ndarray, tile: int) -> Image.Image:
    M, H, W, _ = rgba_tiles.shape
    rows, cols = grid_for_count(M)
    atlas_h = rows * tile
    atlas_w = cols * tile

    atlas = np.zeros((atlas_h, atlas_w, 4), dtype=np.float32)
    idx = 0
    for r in range(rows):
        r0 = r * tile
        for c in range(cols):
            if idx >= M: break
            c0 = c * tile
            atlas[r0:r0+tile, c0:c0+tile, :] = rgba_tiles[idx]
            idx += 1
    atlas = (atlas * 255.0 + 0.5).astype(np.uint8)
    return Image.fromarray(atlas, mode="RGBA")


# =========================
# generate and prewarm helper
# =========================
def _generate_single_channel_mask(img, ch: int, slc: slice) -> np.ndarray:
    # Zarr basic indexing does not support list indexing for axes; use integers/slices
    data = np.asarray(img[ch, slc, :, :], dtype=np.float32)
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
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    if not (0 <= ch < C):
        raise RuntimeError(f"channel {ch} out of range [0,{C-1}]")
    if not (0 <= chunk_id < n_chunks):
        raise RuntimeError("chunk_id out of range")
    cache_path = single_cache_path(ch, chunk_id, int(tile))
    if os.path.exists(cache_path):
        return cache_path
    start = chunk_id * n_per_chunk
    end = min(start + n_per_chunk, N)
    slc = slice(start, end)
    mask = _generate_single_channel_mask(img, ch, slc)
    atlas_img = tiles_to_atlas(mask, tile=int(tile))
    buf = io.BytesIO()
    atlas_img.save(buf, format="PNG", compress_level=1)
    data_bytes = buf.getvalue()
    with open(cache_path, "wb") as f:
        f.write(data_bytes)
    return cache_path

def _prewarm_channel_async(ch: int, tile: int):
    key = (int(ch), int(tile))
    if key in _PREWARM_SET:
        return
    _PREWARM_SET.add(key)
    def _task():
        try:
            img = open_zarr()
            C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
            futures = []
            for cid in range(n_chunks):
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

# =========================
# data generation functions
# =========================
def get_channel_info(df: pd.DataFrame, img=None):
    columns = list(df.columns)
    channel_columns = columns[9:] #9 to the last column
    channels = []
    for i, col_name in enumerate(channel_columns):
        channel_data = img[i, :, :, :]
        sorted_pixels = np.sort(channel_data.flatten())
        total_pixels = len(sorted_pixels)
        min_idx = int(0 * total_pixels)
        max_idx = int(1 * total_pixels) - 1
        min_value = float(sorted_pixels[min_idx])
        max_value = float(sorted_pixels[max_idx])
        channels.append({
            'id': i,
            'name': col_name,
            'column_index': i + 9,
            'pixel_value_range': {'min': min_value, 'max': max_value}
        })
    return channels

async def generate_json_files():
    csv_path = os.path.join(DATA_DIR, "data.csv")
    if not os.path.exists(csv_path):
        return
    try:
        df = pd.read_csv(csv_path)
        img = None
        if os.path.isdir(ZARR_DIR):
            try:
                img = open_zarr()
            except Exception as e:
                print(f"Zarr read failed: {str(e)}")
        if img is not None:
            C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
            N = min(len(df), N)
        else:
            N = len(df)
            n_per_chunk = 1
            n_chunks = N
        coords = [process_coord_row(df.iloc[idx], idx, n_per_chunk) for idx in range(N)]
        channels = get_channel_info(df, img)
        with open(os.path.join(DATA_DIR, "coords.json"), 'w', encoding='utf-8') as f:
            json.dump(coords, f, ensure_ascii=False, indent=2)
        with open(os.path.join(DATA_DIR, "channel_info.json"), 'w', encoding='utf-8') as f:
            json.dump({"channels": channels, "total_channels": len(channels)}, f, ensure_ascii=False, indent=2)
        print(f"Generated JSON files: coords.json ({len(coords)} points), channel_info.json ({len(channels)} channels)")
    except Exception as e:
        print(f"Generated JSON files failed: {str(e)}")

def _to_native(val):
    """Convert numpy/pandas scalars to native Python types for JSON serialization."""
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

def _parse_col_descriptor(name: str):
    s = str(name or "").strip()
    desc = None
    base = s
    if "(" in s and ")" in s and s.rfind("(") < s.rfind(")"):
        l = s.rfind("(")
        r = s.rfind(")")
        desc = s[l+1:r].strip()
        base = s[:l].strip()
    return base if base else s, (desc or None)

def _is_categorical(desc: str, series: pd.Series) -> bool:
    if desc and ":" in desc:
        return True
    try:
        from pandas.api import types as ptypes
        if ptypes.is_numeric_dtype(series):
            return False
    except Exception:
        pass
    return True

def generate_raw_json(raw_csv_path: str, out_path: str):
    """Read a raw CSV and write an array JSON to `out_path`.

    Output format: [ {"schema": [{name, rawName, type, description}]}, {"id":.., "raw": {...}}, ... ]
    """
    if not os.path.exists(raw_csv_path):
        return
    df = pd.read_csv(raw_csv_path)
    cols = list(df.columns)
    id_col = 'id' if 'id' in cols else ('ID' if 'ID' in cols else None)

    # Build schema from first row and column names
    schema = []
    for c in cols:
        if c == id_col:
            continue
        base, desc = _parse_col_descriptor(c)
        ctype = 'categorical' if _is_categorical(desc, df[c]) else 'numeric'
        schema.append({
            'name': base,
            'rawName': c,
            'type': ctype,
            'description': desc or ''
        })

    items = []
    for idx, row in df.iterrows():
        rid = int(_to_native(row[id_col])) if id_col is not None and not pd.isna(row[id_col]) else int(idx)
        raw_map = {}
        for c in cols:
            if c == id_col:
                continue
            raw_map[c] = _to_native(row[c])
        items.append({"id": rid, "raw": raw_map})

    data = [{"schema": schema}] + items
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

# =========================
# API endpoints
# =========================
@app.get("/")
async def root():
    return {"message": "API is running"}

@app.api_route("/upload/{file_type}", methods=["POST", "DELETE"])
async def upload_or_delete(file_type: str, request: Request, file: UploadFile | None = File(None)):
    if file_type not in ["zarr", "csv", "raw"]:
        raise HTTPException(status_code=400, detail="Unsupported file type")

    if request.method == "DELETE":
        if file_type == "zarr":
            remove_path(ZARR_DIR)
            reset_zarr_handle()
            clear_cache_dir()
            return {"message": "Zarr data cleared"}

        remove_path(os.path.join(DATA_DIR, "data.csv"))
        remove_path(os.path.join(DATA_DIR, "coords.json"))
        remove_path(os.path.join(DATA_DIR, "channel_info.json"))
        return {"message": "CSV data cleared"}

        
    # DELETE for raw
    if request.method == "DELETE" and file_type == "raw":
        remove_path(os.path.join(DATA_DIR, "raw.csv"))
        remove_path(os.path.join(DATA_DIR, "raw.json"))
        return {"message": "Raw CSV data cleared"}

    if file is None:
        raise HTTPException(status_code=400, detail="No file provided")

    file_path = os.path.join(
        DATA_DIR,
        file.filename if file_type == "zarr" else ("raw.csv" if file_type == "raw" else "data.csv")
    )
    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)
    if file_type == "zarr":
        remove_path(ZARR_DIR)
        with zipfile.ZipFile(file_path, 'r') as zip_ref:
            zip_ref.extractall(DATA_DIR)
        os.remove(file_path)
        reset_zarr_handle()
        clear_cache_dir()
    elif file_type == "csv":
        await generate_json_files()
    elif file_type == "raw":
        try:
            generate_raw_json(os.path.join(DATA_DIR, "raw.csv"), os.path.join(DATA_DIR, "raw.json"))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate raw.json: {e}")
    return {"message": f"{file.filename} uploaded successfully"}


@app.get("/upload/status")
async def upload_status():
    has_zarr = False
    if os.path.isdir(ZARR_DIR):
        try:
            has_zarr = any(os.scandir(ZARR_DIR))
        except Exception:
            has_zarr = True
    csv_path = os.path.join(DATA_DIR, "data.csv")
    return {
        "zarr": has_zarr,
        "csv": os.path.exists(csv_path),
        "raw": os.path.exists(os.path.join(DATA_DIR, "raw.csv")) and os.path.exists(os.path.join(DATA_DIR, "raw.json"))
    }

@app.get("/channels")
async def get_channels():
    csv_path = os.path.join(DATA_DIR, "data.csv")
    if not os.path.exists(csv_path):
        return {"channels": [], "total_channels": 0}
    try:
        df = pd.read_csv(csv_path)
        channels = get_channel_info(df)
        return {"channels": channels, "total_channels": len(channels)}
    except Exception as e:
        return {"channels": [], "total_channels": 0}

@app.get("/meta")
def meta():
    if not os.path.isdir(ZARR_DIR):
        return {"error": "No data loaded", "message": "Please upload zarr data first"}
    try:
        img = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
        rows, cols = grid_for_count(n_per_chunk)
        atlas_w = cols * DEFAULT_TILE
        atlas_h = rows * DEFAULT_TILE
        return {
            "C": int(C), "N": int(N), "H": int(H), "W": int(W),
            "dtype": str(img.dtype),
            "chunks": tuple(int(x) for x in img.chunks),
            "n_chunks": int(n_chunks), "n_per_chunk": int(n_per_chunk),
            "atlas": {"tile": DEFAULT_TILE, "cols": int(cols), "rows": int(rows), "width": int(atlas_w), "height": int(atlas_h)}
        }
    except Exception as e:
        return {"error": "Failed to load data", "message": str(e)}

def process_coord_row(row, idx, n_per_chunk):
    """process single row of coordinate data"""
    x_raw = float(row.get('X_centroid', 0))
    y_raw = float(row.get('Y_centroid', 0))
    return {
        "id": idx, 
        "chunk_id": int(idx // n_per_chunk), 
        "local_index": int(idx % n_per_chunk),
        "raw": {"x": x_raw, "y": y_raw, "z": 0},
        "umap2d": {"x": float(row.get('umap2_x', x_raw)), "y": float(row.get('umap2_y', y_raw)), "z": 0},
        "umap3d": {"x": float(row.get('umap3_x', x_raw)), "y": float(row.get('umap3_y', y_raw)), "z": float(row.get('umap3_z', 0))},
        "label": int(row.get('label', stable_label(idx)))
    }

@app.get("/coords")
def coords(limit: Optional[int] = Query(None)):
    if not os.path.exists(os.path.join(DATA_DIR, "data.csv")):
        return JSONResponse([])
    try:
        df = pd.read_csv(os.path.join(DATA_DIR, "data.csv"))
        img = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
        N = min(len(df), N)
        total = N if limit is None else min(N, int(limit))
        
        out = [process_coord_row(df.iloc[idx], idx, n_per_chunk) for idx in range(total)]
        return JSONResponse(out)
    except Exception as e:
        return JSONResponse([])

@app.get("/atlas_uv/{chunk_id}")
def atlas_uv(chunk_id: int, tile: int = Query(DEFAULT_TILE)):
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    if not (0 <= chunk_id < n_chunks):
        raise HTTPException(status_code=404, detail="chunk_id out of range")
    rows, cols = grid_for_count(n_per_chunk)
    width = cols * tile
    height = rows * tile
    uvs = []
    for i in range(n_per_chunk):
        gindex = chunk_id * n_per_chunk + i
        if gindex >= N:
            break
        r = i // cols; c = i % cols
        x0 = c * tile; y0 = r * tile
        x1 = x0 + tile; y1 = y0 + tile
        uvs.append({
            "local_index": int(i),
            "u0": x0 / width, "v0": y0 / height,
            "u1": x1 / width, "v1": y1 / height
        })
    return {
        "tile": int(tile),
        "cols": int(cols),
        "rows": int(rows),
        "width": int(width),
        "height": int(height),
        "uv": uvs
    }

@app.post("/atlas/{chunk_id}")
def atlas(chunk_id: int, req: AtlasRequest = Body(...)):
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    chans = sorted(set(int(c) for c in req.channels))
    if len(chans) != 1:
        raise HTTPException(status_code=400, detail="Only single-channel is supported. Use GET /atlas/{chunk_id}?channel=..")
    ch = chans[0]
    if not (0 <= ch < C):
        raise HTTPException(status_code=400, detail=f"channel {ch} out of range [0,{C-1}]")

    # single channel fixed cache path
    cache_path = single_cache_path(ch, chunk_id, int(req.tile))
    etag = f"ch{ch}-chunk{chunk_id}-tile{int(req.tile)}"
    if os.path.exists(cache_path):
        headers = {"Cache-Control": "public, max-age=604800", "ETag": etag}
        return FileResponse(cache_path, media_type="image/png", headers=headers)

    # render and cache (if hit, return file directly)
    _render_and_cache_atlas(img, ch, chunk_id, int(req.tile))
    try:
        print(f"Saved atlas cache: {cache_path}")
    except Exception:
        pass
    # prewarm other chunks of the same channel
    _prewarm_channel_async(ch, int(req.tile))
    headers = {"Cache-Control": "public, max-age=604800", "ETag": etag}
    # return disk cache by FileResponse (for browser cache and transmission)
    return FileResponse(cache_path, media_type="image/png", headers=headers)

@app.get("/atlas/{chunk_id}")
def atlas_get(chunk_id: int, channel: int = Query(...), tile: int = Query(DEFAULT_TILE), request: Request = None):
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    if not (0 <= channel < C):
        raise HTTPException(status_code=400, detail=f"channel {channel} out of range [0,{C-1}]")
    if not (0 <= chunk_id < n_chunks):
        raise HTTPException(status_code=404, detail="chunk_id out of range")

    chans = [int(channel)]
    cache_path = single_cache_path(chans[0], chunk_id, int(tile))
    etag = f"ch{chans[0]}-chunk{chunk_id}-tile{int(tile)}"

    if os.path.exists(cache_path):
        if request is not None:
            inm = request.headers.get("if-none-match")
            if inm and inm.strip('"') == etag:
                return Response(status_code=304)
        headers = {"Cache-Control": "public, max-age=604800", "ETag": etag}
        return FileResponse(cache_path, media_type="image/png", headers=headers)

    _render_and_cache_atlas(img, chans[0], chunk_id, int(tile))
    try:
        print(f"Saved atlas cache: {cache_path}")
    except Exception:
        pass
    _prewarm_channel_async(chans[0], int(tile))
    headers = {"Cache-Control": "public, max-age=604800", "ETag": etag}
    return FileResponse(cache_path, media_type="image/png", headers=headers)

@app.post("/prewarm")
def prewarm(channel: int = Query(...), tile: int = Query(DEFAULT_TILE)):
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    if not (0 <= channel < C):
        raise HTTPException(status_code=400, detail=f"channel {channel} out of range [0,{C-1}]")
    _prewarm_channel_async(int(channel), int(tile))
    return {"status": "ok", "message": "prewarm started", "channel": int(channel), "tile": int(tile)}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
