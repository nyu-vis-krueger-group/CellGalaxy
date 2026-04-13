import os
import zipfile

from fastapi import APIRouter, File, UploadFile, HTTPException, Request

from .config import DATA_DIR, ZARR_DIR, remove_path
from .data_paths import (
    channel_list_csv_path,
    csv_sidecar_paths,
    features_npy_path,
    generating_marker_path,
    raw_csv_json_paths,
    zooming_csv_path,
)
from .zarr_utils import reset_zarr_handle
from .data_utils import generate_json_files, generate_raw_json


router = APIRouter()


@router.api_route("/upload/{file_type}", methods=["POST", "DELETE"])
async def upload_or_delete(
    file_type: str, request: Request, file: UploadFile | None = File(None)
):
    if file_type not in ["zarr", "csv", "raw", "feat", "channels", "zooming"]:
        raise HTTPException(status_code=400, detail="Unsupported file type")

    if request.method == "DELETE":
        if file_type == "zarr":
            remove_path(ZARR_DIR)
            reset_zarr_handle()
            return {"message": "Zarr data cleared"}

        if file_type == "csv":
            data_csv, coords_json, channel_json = csv_sidecar_paths()
            remove_path(data_csv)
            remove_path(coords_json)
            remove_path(channel_json)
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

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    if file_type == "zarr":
        remove_path(ZARR_DIR)
        with zipfile.ZipFile(file_path, "r") as zip_ref:
            zip_ref.extractall(DATA_DIR)
        os.remove(file_path)
        reset_zarr_handle()
    elif file_type == "csv":
        pass
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
    elif file_type == "channels":
        marker = generating_marker_path()
        try:
            with open(marker, "w", encoding="utf-8") as f:
                f.write("generating")
            await generate_json_files()
        finally:
            try:
                if os.path.exists(marker):
                    os.remove(marker)
            except Exception:
                pass

    return {"message": f"{file.filename} uploaded successfully"}


