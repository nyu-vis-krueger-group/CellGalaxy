from typing import Optional

import os
from fastapi import APIRouter, HTTPException, Query, Body, Request, Response
from fastapi.responses import FileResponse

from .models import AtlasRequest
from .display_subset import display_atlas_n_and_chunks
from .zarr_utils import (
    open_zarr,
    meta_from_img,
    grid_for_count,
    get_default_tile,
    single_cache_path,
    _render_and_cache_atlas,
    _prewarm_channel_async,
)


router = APIRouter()


def _validate_chunk_id(chunk_id: int, n_chunks: int) -> None:
    if not (0 <= chunk_id < n_chunks):
        raise HTTPException(status_code=404, detail="chunk_id out of range")


def _validate_channel_index(channel: int, n_channels: int) -> None:
    if not (0 <= channel < n_channels):
        raise HTTPException(
            status_code=400, detail=f"channel {channel} out of range [0,{n_channels-1}]"
        )


def _effective_tile(tile: Optional[int]) -> int:
    return int(tile) if tile is not None else get_default_tile()


def _build_etag(channel: int, chunk_id: int, tile: int) -> str:
    return f"ch{channel}-chunk{chunk_id}-tile{tile}"


def _cache_headers(etag: str) -> dict[str, str]:
    return {"Cache-Control": "public, max-age=604800", "ETag": etag}


@router.get("/atlas_uv/{chunk_id}")
def atlas_uv(chunk_id: int, tile: Optional[int] = Query(None)):
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    n_disp, n_chunks_eff = display_atlas_n_and_chunks(N, n_per_chunk)
    _validate_chunk_id(chunk_id, n_chunks_eff)
    effective_tile = _effective_tile(tile)
    rows, cols = grid_for_count(n_per_chunk)
    width = cols * effective_tile
    height = rows * effective_tile
    uvs = []
    for i in range(n_per_chunk):
        gindex = chunk_id * n_per_chunk + i
        if gindex >= n_disp:
            break
        r = i // cols
        c = i % cols
        x0 = c * effective_tile
        y0 = r * effective_tile
        x1 = x0 + effective_tile
        y1 = y0 + effective_tile
        uvs.append(
            {
                "local_index": int(i),
                "u0": x0 / width,
                "v0": y0 / height,
                "u1": x1 / width,
                "v1": y1 / height,
            }
        )
    return {
        "tile": int(effective_tile),
        "cols": int(cols),
        "rows": int(rows),
        "width": int(width),
        "height": int(height),
        "uv": uvs,
    }


@router.post("/atlas/{chunk_id}")
def atlas(chunk_id: int, req: AtlasRequest = Body(...)):
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    _n_disp, n_chunks_eff = display_atlas_n_and_chunks(N, n_per_chunk)
    chans = sorted(set(int(c) for c in req.channels))
    if len(chans) != 1:
        raise HTTPException(
            status_code=400,
            detail="Only single-channel is supported. Use GET /atlas/{chunk_id}?channel=..",
        )
    ch = chans[0]
    _validate_channel_index(ch, C)
    _validate_chunk_id(chunk_id, n_chunks_eff)

    tile = _effective_tile(req.tile)

    cache_path = single_cache_path(ch, chunk_id, tile)
    etag = _build_etag(ch, chunk_id, tile)
    if os.path.exists(cache_path):
        return FileResponse(cache_path, media_type="image/png", headers=_cache_headers(etag))

    _render_and_cache_atlas(img, ch, chunk_id, tile)
    try:
        print(f"Saved atlas cache: {cache_path}")
    except Exception:
        pass
    _prewarm_channel_async(ch, tile)
    return FileResponse(cache_path, media_type="image/png", headers=_cache_headers(etag))


@router.get("/atlas/{chunk_id}")
def atlas_get(
    chunk_id: int,
    channel: int = Query(...),
    tile: Optional[int] = Query(None),
    request: Request = None,
):
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    _n_disp, n_chunks_eff = display_atlas_n_and_chunks(N, n_per_chunk)
    _validate_channel_index(channel, C)
    _validate_chunk_id(chunk_id, n_chunks_eff)

    effective_tile = _effective_tile(tile)
    ch = int(channel)
    cache_path = single_cache_path(ch, chunk_id, effective_tile)
    etag = _build_etag(ch, chunk_id, effective_tile)

    if os.path.exists(cache_path):
        if request is not None:
            inm = request.headers.get("if-none-match")
            if inm and inm.strip('"') == etag:
                return Response(status_code=304)
        return FileResponse(cache_path, media_type="image/png", headers=_cache_headers(etag))

    _render_and_cache_atlas(img, ch, chunk_id, effective_tile)
    try:
        print(f"Saved atlas cache: {cache_path}")
    except Exception:
        pass
    _prewarm_channel_async(ch, effective_tile)
    return FileResponse(cache_path, media_type="image/png", headers=_cache_headers(etag))


@router.post("/prewarm")
def prewarm(channel: int = Query(...), tile: Optional[int] = Query(None)):
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    _validate_channel_index(channel, C)
    effective_tile = _effective_tile(tile)
    _prewarm_channel_async(int(channel), effective_tile)
    return {
        "status": "ok",
        "message": "prewarm started",
        "channel": int(channel),
        "tile": int(effective_tile),
    }


