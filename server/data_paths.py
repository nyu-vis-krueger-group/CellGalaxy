"""Filesystem paths for artifacts under DATA_DIR."""

from __future__ import annotations

import os

from .config import DATA_DIR


def data_csv_path() -> str:
    return os.path.join(DATA_DIR, "data.csv")


def raw_csv_json_paths() -> tuple[str, str]:
    return (
        os.path.join(DATA_DIR, "raw.csv"),
        os.path.join(DATA_DIR, "raw.json"),
    )


def features_npy_path() -> str:
    return os.path.join(DATA_DIR, "features.npy")


def channel_list_csv_path() -> str:
    return os.path.join(DATA_DIR, "channel_list.csv")


def zooming_csv_path() -> str:
    return os.path.join(DATA_DIR, "cluster_multilevel_hierarchy.csv")


def generating_marker_path() -> str:
    return os.path.join(DATA_DIR, ".generating")


def csv_sidecar_paths() -> tuple[str, str, str]:
    """data.csv plus coords.json and channel_info.json (cleared with csv upload)."""
    return (
        os.path.join(DATA_DIR, "data.csv"),
        os.path.join(DATA_DIR, "coords.json"),
        os.path.join(DATA_DIR, "channel_info.json"),
    )


def spatial_coords_path() -> str:
    """All cells' spatial centroids (id + raw); used for spatial hover pick."""
    return os.path.join(DATA_DIR, "spatial_coords.json")


def cluster_channel_avg_csv_path() -> str:
    return os.path.join(DATA_DIR, "cluster_channel_avg.csv")
