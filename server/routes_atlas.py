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
    render_cell_preview_png,
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


def _parse_channel_list(channels: str) -> list[int]:
    out: list[int] = []
    for part in (channels or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            continue
    return out


def _parse_channel_windows(
    channels: list[int],
    win_min: Optional[str] = None,
    win_max: Optional[str] = None,
) -> dict[int, tuple[float, float]]:
    """Optional parallel comma lists: win_min=0,0&win_max=65535,65535 per channel."""
    mins = [float(x) for x in (win_min or "").split(",") if x.strip() != ""]
    maxs = [float(x) for x in (win_max or "").split(",") if x.strip() != ""]
    wins: dict[int, tuple[float, float]] = {}
    for i, ch in enumerate(channels):
        lo = mins[i] if i < len(mins) else 0.0
        hi = maxs[i] if i < len(maxs) else 65535.0
        wins[int(ch)] = (lo, hi)
    return wins


@router.get("/cell/{cell_id}/preview.png")
def cell_preview(
    cell_id: int,
    channels: str = Query(..., description="Comma-separated channel indices"),
    win_min: Optional[str] = Query(None),
    win_max: Optional[str] = Query(None),
    size: int = Query(128, ge=16, le=256),
):
    """On-demand single-cell preview for spatial hover (cells outside display atlas)."""
    img = open_zarr()
    C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
    chans = _parse_channel_list(channels)
    if not chans:
        raise HTTPException(status_code=400, detail="channels required")
    for ch in chans:
        _validate_channel_index(ch, C)
    if not (0 <= int(cell_id) < int(N)):
        raise HTTPException(status_code=404, detail="cell_id out of range")
    wins = _parse_channel_windows(chans, win_min, win_max)
    try:
        png = render_cell_preview_png(
            img,
            int(cell_id),
            chans,
            channel_windows=wins,
            out_size=int(size),
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    etag = f"cell-{cell_id}-{'-'.join(str(c) for c in chans)}-s{size}"
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400", "ETag": etag},
    )


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


