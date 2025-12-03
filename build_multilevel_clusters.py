#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Build a multi-level clustering structure for semantic zooming.

Inputs:
  - data.csv: one row per cell, including cellID, X_centroid, Y_centroid, umap2_x, umap2_y, umap3_x, umap3_y, umap3_z.

Outputs:
  1) data_raw.csv: Original data.csv plus cluster_L0, cluster_L1, ..., cluster_L5 and rank_L0, rank_L1, ..., rank_L5 for each cell.
  2) cluster_multilevel_hierarchy.csv: One row per cluster (level, cluster_id) with:
  level, cluster_id, parent_level, parent_cluster_id, size, rep_index, rep_cellID (if cellID is available),
  rep_umap2_x, rep_umap2_y, rep_umap3_x, rep_umap3_y, rep_umap3_z, X_centroid, Y_centroid,
  children_cluster_ids (comma-separated list of child cluster IDs)
"""

import collections
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans


# ======== Configuration ========

# Input data path (relative to current working directory)
DATA_CSV_PATH = "data.csv"

# Feature space used for clustering:
#   "umap2": use umap2_x, umap2_y from data.csv
#   "umap3": use umap3_x, umap3_y, umap3_z from data.csv
CLUSTER_SPACE = "umap2"

# Number of clusters per level (you can change this as needed)
# Note: level 0 is fixed to 1 (all cells in one cluster)
LEVEL_K = {
    0: 1,
    1: 3,
    2: 6,
    3: 10,
    4: 15,
    5: 20,
}

RANDOM_STATE = 0
KMEANS_N_INIT = 10

# Output file paths
OUTPUT_DATA_WITH_CLUSTERS = "data_raw.csv"
OUTPUT_CLUSTER_SUMMARY = "cluster_multilevel_hierarchy.csv"


def run_multilevel_kmeans(
    features: np.ndarray,
    level_k: Dict[int, int],
) -> Dict[int, np.ndarray]:
    """
    Run k-means independently for each level using the same feature space.

    Returns:
      labels_per_level[level] = array of cluster IDs with shape (N,)
    """
    n_cells = features.shape[0]
    labels_per_level: Dict[int, np.ndarray] = {}

    if 0 not in level_k:
        raise ValueError("LEVEL_K must contain configuration for level 0 (k=1)")
    if level_k[0] != 1:
        raise ValueError("k for level 0 must be 1")

    labels_per_level[0] = np.zeros(n_cells, dtype=int)

    for level, k in level_k.items():
        if level == 0:
            continue
        km = KMeans(
            n_clusters=k,
            random_state=RANDOM_STATE,
            n_init=KMEANS_N_INIT,
        )
        labels = km.fit_predict(features)
        labels_per_level[level] = labels.astype(int)

    return labels_per_level


def build_parent_child_relations(
    labels_per_level: Dict[int, np.ndarray],
    level_k: Dict[int, int],
) -> Tuple[
    Dict[Tuple[int, int], Tuple[int, int]],
    Dict[Tuple[int, int], List[Tuple[int, int]]],
]:
    """
    Construct parent/children relations across levels using majority voting.

    parent_map[(level, cid)] = (parent_level, parent_cid)
    children_map[(level, cid)] = [(child_level, child_cid), ...]
    """
    max_level = max(level_k.keys())
    parent_map: Dict[Tuple[int, int], Tuple[int, int]] = {}
    children_map: Dict[Tuple[int, int], List[Tuple[int, int]]] = collections.defaultdict(list)

    for level in range(0, max_level + 1):
        k = level_k[level]
        for cid in range(k):
            parent_map[(level, cid)] = (-1, -1)

    for level in range(1, max_level + 1):
        prev_labels = labels_per_level[level - 1]
        curr_labels = labels_per_level[level]
        k_curr = level_k[level]

        for cid in range(k_curr):
            idx = np.where(curr_labels == cid)[0]
            if len(idx) == 0:
                parent_map[(level, cid)] = (level - 1, -1)
                continue

            parents = prev_labels[idx]
            counter = collections.Counter(parents)
            parent_cid, _ = counter.most_common(1)[0]
            parent = (level - 1, int(parent_cid))

            parent_map[(level, cid)] = parent
            children_map[parent].append((level, cid))

    return parent_map, children_map


def compute_cluster_summaries(
    df: pd.DataFrame,
    features: np.ndarray,
    labels_per_level: Dict[int, np.ndarray],
    level_k: Dict[int, int],
    parent_map: Dict[Tuple[int, int], Tuple[int, int]],
    children_map: Dict[Tuple[int, int], List[Tuple[int, int]]],
) -> pd.DataFrame:
    """
    For each level/cluster, compute:
      - size
      - representative cell (nearest to centroid in feature space)
      - representative cell coordinates (UMAP / spatial)
      - parent / children information
    """
    n_cells = features.shape[0]
    max_level = max(level_k.keys())

    summaries = []

    for level in range(0, max_level + 1):
        labels = labels_per_level[level]
        k = level_k[level]

        for cid in range(k):
            idx = np.where(labels == cid)[0]
            size = len(idx)
            if size == 0:
                continue

            centroid = features[idx].mean(axis=0)
            sub_feats = features[idx]
            diffs = sub_feats - centroid
            dists = np.linalg.norm(diffs, axis=1)
            rep_local = int(np.argmin(dists))
            rep_index = int(idx[rep_local])

            row = {
                "level": int(level),
                "cluster_id": int(cid),
                "size": int(size),
                "rep_index": rep_index,
            }

            parent_level, parent_cid = parent_map.get((level, cid), (-1, -1))
            row["parent_level"] = int(parent_level)
            row["parent_cluster_id"] = int(parent_cid)

            children = children_map.get((level, cid), [])
            child_ids = [int(child_cid) for (_child_level, child_cid) in children]
            row["children_cluster_ids"] = ",".join(str(x) for x in sorted(child_ids)) if child_ids else ""

            if "cellID" in df.columns:
                row["rep_cellID"] = df.loc[rep_index, "cellID"]

            coord_cols = [
                "umap2_x",
                "umap2_y",
                "umap3_x",
                "umap3_y",
                "umap3_z",
                "X_centroid",
                "Y_centroid",
            ]
            for col in coord_cols:
                if col in df.columns:
                    row[f"rep_{col}"] = df.loc[rep_index, col]

            summaries.append(row)

    summary_df = pd.DataFrame(summaries)
    return summary_df


def compute_per_cell_ranks_within_cluster(
    features: np.ndarray,
    labels_per_level: Dict[int, np.ndarray],
    level_k: Dict[int, int],
) -> Dict[int, np.ndarray]:
    """
    For each level/cluster, compute a per-cell rank:
      - within the same level/cluster, sort cells by distance to the centroid
        (the closer to the centroid, the smaller the rank)
      - returns:
          ranks_per_level[level] = integer array of shape (N,)
          ranks_per_level[level][i] is the rank of cell i in its cluster (0..size-1)
    """
    n_cells = features.shape[0]
    ranks_per_level: Dict[int, np.ndarray] = {}
    max_level = max(level_k.keys())

    for level in range(0, max_level + 1):
        labels = labels_per_level[level]
        k = level_k[level]
        ranks = np.zeros(n_cells, dtype=int)

        print(f"[Ranks] computing ranks for level {level}")

        for cid in range(k):
            idx = np.where(labels == cid)[0]
            size = len(idx)
            if size == 0:
                continue
            if size == 1:
                ranks[idx[0]] = 0
                continue

            centroid = features[idx].mean(axis=0)
            sub_feats = features[idx]
            diffs = sub_feats - centroid
            dists = np.linalg.norm(diffs, axis=1)

            order = np.argsort(dists)
            ranks[idx[order]] = np.arange(size, dtype=int)

        ranks_per_level[level] = ranks

    return ranks_per_level


def main() -> None:
    print("Loading data ...")
    df = pd.read_csv(DATA_CSV_PATH)

    n_cells = len(df)
    print(f"Total number of cells: {n_cells}")

    # Select feature space for clustering
    if CLUSTER_SPACE == "umap2":
        print("\nClustering in UMAP 2D space (umap2_x, umap2_y)")
        if not {"umap2_x", "umap2_y"}.issubset(df.columns):
            raise ValueError("data.csv is missing umap2_x / umap2_y columns; cannot cluster in UMAP 2D space")
        features = df[["umap2_x", "umap2_y"]].to_numpy(dtype=float)
    elif CLUSTER_SPACE == "umap3":
        print("\nClustering in UMAP 3D space (umap3_x, umap3_y, umap3_z)")
        if not {"umap3_x", "umap3_y", "umap3_z"}.issubset(df.columns):
            raise ValueError("data.csv is missing umap3_x / umap3_y / umap3_z columns; cannot cluster in UMAP 3D space")
        features = df[["umap3_x", "umap3_y", "umap3_z"]].to_numpy(dtype=float)
    else:
        raise ValueError(f"Unknown CLUSTER_SPACE configuration: {CLUSTER_SPACE}")

    print("\n=== Run multi-level k-means clustering ===")
    labels_per_level = run_multilevel_kmeans(features, LEVEL_K)

    max_level = max(LEVEL_K.keys())
    for level in range(0, max_level + 1):
        col_name = f"cluster_L{level}"
        df[col_name] = labels_per_level[level].astype(int)
        print(f"Write column: {col_name}")

    print("\n=== Compute per-cell ranks within each level/cluster ===")
    ranks_per_level = compute_per_cell_ranks_within_cluster(
        features=features,
        labels_per_level=labels_per_level,
        level_k=LEVEL_K,
    )

    for level in range(0, max_level + 1):
        col_name = f"rank_L{level}"
        df[col_name] = ranks_per_level[level].astype(int)
        print(f"Write column: {col_name}")

    print(f"\nSave data with multi-level clusters to: {OUTPUT_DATA_WITH_CLUSTERS}")
    df.to_csv(OUTPUT_DATA_WITH_CLUSTERS, index=False)

    print("\n=== Build parent / children relations ===")
    parent_map, children_map = build_parent_child_relations(labels_per_level, LEVEL_K)

    print("\n=== Compute cluster summaries (representative cell + hierarchy) ===")
    summary_df = compute_cluster_summaries(
        df=df,
        features=features,
        labels_per_level=labels_per_level,
        level_k=LEVEL_K,
        parent_map=parent_map,
        children_map=children_map,
    )

    print(f"\nSave cluster hierarchy information to: {OUTPUT_CLUSTER_SUMMARY}")
    summary_df.to_csv(OUTPUT_CLUSTER_SUMMARY, index=False)

    print("\nDone.")
    print("  - data_raw.csv: per-cell cluster labels and ranks for each level")
    print("  - cluster_multilevel_hierarchy.csv: cluster hierarchy and representative cells")


if __name__ == "__main__":
    main()


