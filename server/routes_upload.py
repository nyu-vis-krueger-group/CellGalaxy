import asyncio
import os
import time
import zipfile

from fastapi import APIRouter, File, UploadFile, HTTPException, Request

_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024


async def _stream_upload_to_path(upload: UploadFile, dest: str) -> None:
    """Write multipart upload to disk in chunks (avoid loading whole file into RAM)."""
    with open(dest, "wb") as out:
        while True:
            chunk = await upload.read(_UPLOAD_CHUNK_BYTES)
            if not chunk:
                break
            out.write(chunk)

from .config import DATA_DIR, ZARR_DIR, remove_path
from .data_paths import (
    channel_list_csv_path,
    csv_sidecar_paths,
    features_npy_path,
    generating_marker_path,
    raw_csv_json_paths,
    spatial_coords_path,
    zooming_csv_path,
)
from .display_subset import clear_display_subset_artifacts
from .zarr_utils import reset_zarr_handle
from .data_utils import generate_json_files, generate_raw_json
from .routes_features import invalidate_data_csv_caches


def _artifact_ready(path: str, min_bytes: int = 8) -> bool:
    try:
        return os.path.isfile(path) and os.path.getsize(path) >= min_bytes
    except OSError:
        return False


def _channel_generation_complete() -> bool:
    _, coords_json, channel_json = csv_sidecar_paths()
    return (
        _artifact_ready(coords_json)
        and _artifact_ready(channel_json)
        and _artifact_ready(spatial_coords_path(), min_bytes=64)
    )


async def _wait_until_marker_cleared(marker: str, timeout_s: float = 7200.0) -> None:
    """Do not finish the upload HTTP response while public/.generating still exists."""
    deadline = time.monotonic() + timeout_s
    while os.path.isfile(marker):
        if time.monotonic() >= deadline:
            print(f"Warning: timed out waiting for {marker} to be removed")
            return
        await asyncio.sleep(0.25)


router = APIRouter()


@router.api_route("/upload/{file_type}", methods=["POST", "DELETE"])
async def upload_or_delete(
    file_type: str,
    request: Request,
    file: UploadFile | None = File(None),
):
    if file_type not in ["zarr", "csv", "raw", "feat", "channels", "zooming"]:
        raise HTTPException(status_code=400, detail="Unsupported file type")

    if request.method == "DELETE":
        if file_type == "zarr":
            remove_path(ZARR_DIR)
            reset_zarr_handle()
            clear_display_subset_artifacts()
            return {"message": "Zarr data cleared"}

        if file_type == "csv":
            data_csv, coords_json, channel_json = csv_sidecar_paths()
            remove_path(data_csv)
            remove_path(coords_json)
            remove_path(channel_json)
            remove_path(spatial_coords_path())
            clear_display_subset_artifacts()
            invalidate_data_csv_caches()
            return {"message": "CSV data cleared"}

        if file_type == "raw":
            raw_csv, raw_json = raw_csv_json_paths()
            remove_path(raw_csv)
            remove_path(raw_json)
            return {"message": "Raw CSV data cleared"}
        
        if file_type == "feat":
            remove_path(features_npy_path())
            return {"message": "Features cleared"}
        
        if file_type == "channels":
            remove_path(channel_list_csv_path())
            return {"message": "Channel list cleared"}

        if file_type == "zooming":
            remove_path(zooming_csv_path())
            return {"message": "Zooming data cleared"}

    if file is None:
        raise HTTPException(status_code=400, detail="No file provided")

    target_name = (
        file.filename
        if file_type == "zarr"
        else (
            "raw.csv"
            if file_type == "raw"
            else ("features.npy" if file_type == "feat" else ("channel_list.csv" if file_type == "channels" else ("cluster_multilevel_hierarchy.csv" if file_type == "zooming" else "data.csv")))
        )
    )
    file_path = os.path.join(DATA_DIR, target_name)

    if file_type == "channels":
        channel_marker = generating_marker_path()
        try:
            with open(channel_marker, "w", encoding="utf-8") as f:
                f.write("generating")
            await _stream_upload_to_path(file, file_path)
            _, coords_json, channel_json = csv_sidecar_paths()
            remove_path(coords_json)
            remove_path(channel_json)
            remove_path(spatial_coords_path())
            await generate_json_files()
            invalidate_data_csv_caches()
        except Exception as e:
            if isinstance(e, HTTPException):
                raise
            raise HTTPException(
                status_code=500,
                detail=f"Failed to generate coords/channel info: {e}",
            ) from e
        finally:
            # Keep .generating until JSON sidecars exist; only clear when delete succeeds.
            if _channel_generation_complete():
                try:
                    if os.path.exists(channel_marker):
                        os.remove(channel_marker)
                    if os.path.isfile(channel_marker):
                        print(
                            f"Warning: {channel_marker} still present after remove; "
                            "UI will keep showing generating state."
                        )
                except OSError as exc:
                    print(f"Warning: failed to remove {channel_marker}: {exc}")
        await _wait_until_marker_cleared(channel_marker)
        return {"message": f"{file.filename} uploaded successfully"}

    await _stream_upload_to_path(file, file_path)

    if file_type == "zarr":
        remove_path(ZARR_DIR)
        with zipfile.ZipFile(file_path, "r") as zip_ref:
            zip_ref.extractall(DATA_DIR)
        os.remove(file_path)
        # Keep atlas cache until channel_list upload rebuilds coords + atlases.
        reset_zarr_handle(clear_cache=False)
        clear_display_subset_artifacts()
        # Coords / channel_info are rebuilt when channel_list is uploaded.
        _, coords_json, _ = csv_sidecar_paths()
        remove_path(coords_json)
        remove_path(spatial_coords_path())
    elif file_type == "csv":
        clear_display_subset_artifacts()
        invalidate_data_csv_caches()
        # Stale sidecars until channel_list upload runs generate_json_files().
        _, coords_json, _ = csv_sidecar_paths()
        remove_path(coords_json)
        remove_path(spatial_coords_path())
    elif file_type == "raw":
        raw_csv, raw_json = raw_csv_json_paths()
        try:
            generate_raw_json(raw_csv, raw_json)
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Failed to generate raw.json: {e}"
            )
    elif file_type == "feat":
        pass
    elif file_type == "zooming":
        pass
    return {"message": f"{file.filename} uploaded successfully"}


