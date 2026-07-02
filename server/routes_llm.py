import json
import os
import shutil
from typing import Any, Dict

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from datetime import datetime, timezone

from .config import (
    CLUSTER_LABELS_JSON,
    CLUSTER_LABEL_REVIEWS_JSON,
    DATA_DIR,
    LLM_MODEL,
    LLM_MODELS_REGISTRY,
    LLM_TEMPERATURE,
    ZARR_DIR,
)
from .data_paths import (
    channel_list_csv_path,
    cluster_channel_avg_csv_path,
    data_csv_path,
)
from .llm_client import create_default_client
from .prompt_templates import render_cluster_prompt
from .zarr_utils import open_zarr, meta_from_img


router = APIRouter()


@router.post("/llm/compute_cluster_channel_avg")
def compute_cluster_channel_avg() -> Dict[str, object]:
    """
    Read from the public directory:
      - output.zarr (shape [C, N, H, W])
      - data.csv (supports either:
          * legacy single-level column 'clustering', or
          * multi-level columns 'cluster_L0'..'cluster_Lk')
      - channel_list.csv (must contain channel_id, channel_name)

    Compute average intensity per (level, cluster) for each channel and save to
    public/cluster_channel_avg.csv.
    - For multi-level data: each 'cluster_Lx' column becomes level_id=x.
    - For legacy data: use 'clustering' as level_id=0.
    Chunk size is read from Zarr metadata (use chunk size along the N dimension).
    """
    try:
        csv_path = data_csv_path()
        channels_csv = channel_list_csv_path()
        out_csv = cluster_channel_avg_csv_path()

        if not os.path.isdir(ZARR_DIR):
            raise FileNotFoundError(f"Zarr directory does not exist: {ZARR_DIR}")
        if not os.path.exists(csv_path):
            raise FileNotFoundError("public/data.csv not found")
        if not os.path.exists(channels_csv):
            raise FileNotFoundError("public/channel_list.csv not found")

        try:
            if os.path.exists(out_csv):
                os.remove(out_csv)
        except Exception:
            pass

        df = pd.read_csv(csv_path)

        level_labels: dict[int, np.ndarray] = {}

        for col in df.columns:
            if not str(col).startswith("cluster_L"):
                continue
            try:
                lvl = int(str(col).replace("cluster_L", ""))
            except Exception:
                continue
            series = pd.to_numeric(df[col], errors="coerce")
            level_labels[lvl] = series.to_numpy(dtype=np.float64)

        if not level_labels:
            if "clustering" not in df.columns:
                raise ValueError("data.csv must contain either 'clustering' or 'cluster_L0'.. columns.")
            series = pd.to_numeric(df["clustering"], errors="coerce")
            level_labels[0] = series.to_numpy(dtype=np.float64)

        n_cells = len(df)

        img = open_zarr()
        C, N, H, W, chunks, n_chunks, n_per_chunk = meta_from_img(img)
        if N != n_cells:
            raise ValueError(f"Zarr N={N} does not match data.csv rows N={n_cells}")

        unique_clusters_by_level: dict[int, np.ndarray] = {}
        cluster_to_idx_by_level: dict[int, dict[int, int]] = {}
        sum_pixels_by_level: dict[int, np.ndarray] = {}
        num_pixels_by_level: dict[int, np.ndarray] = {}

        for lvl, arr in level_labels.items():
            finite_mask = np.isfinite(arr)
            if not np.any(finite_mask):
                continue
            uniq = np.sort(np.unique(arr[finite_mask]))
            uniq_int = uniq.astype(int)
            unique_clusters_by_level[lvl] = uniq_int
            cluster_to_idx_by_level[lvl] = {int(cl): i for i, cl in enumerate(uniq_int)}
            sum_pixels_by_level[lvl] = np.zeros((uniq_int.shape[0], C), dtype=np.float64)
            num_pixels_by_level[lvl] = np.zeros(uniq_int.shape[0], dtype=np.int64)

        if not unique_clusters_by_level:
            raise ValueError("No valid clusters found in data.csv for any level.")

        total_pixels_per_image = int(H) * int(W)

        for start in range(0, N, n_per_chunk):
            end = min(start + n_per_chunk, N)
            slc = slice(start, end)
            chunk_data = np.asarray(img[:, slc, :, :])

            for lvl, labels in level_labels.items():
                if lvl not in unique_clusters_by_level:
                    continue
                chunk_clusters = labels[slc]
                finite = np.isfinite(chunk_clusters)
                if not np.any(finite):
                    continue
                present = np.unique(chunk_clusters[finite])
                for cl in present:
                    if not np.isfinite(cl):
                        continue
                    cl_int = int(cl)
                    idx_cluster = cluster_to_idx_by_level[lvl].get(cl_int)
                    if idx_cluster is None:
                        continue
                    mask = chunk_clusters == cl
                    if not np.any(mask):
                        continue
                    selected = chunk_data[:, mask, :, :]
                    sum_per_channel = selected.sum(axis=(1, 2, 3))
                    sum_pixels_by_level[lvl][idx_cluster] += sum_per_channel
                    num_pixels_by_level[lvl][idx_cluster] += int(mask.sum()) * total_pixels_per_image

        ch_df = pd.read_csv(channels_csv)
        if "zarr_index" in ch_df.columns:
            def _has_zarr(v: object) -> bool:
                if pd.isna(v):
                    return False
                s = str(v).strip()
                if not s or s.lower() in ("na", "nan", "none", "-", "null"):
                    return False
                try:
                    return int(float(s)) >= 0
                except Exception:
                    return False

            ch_df = ch_df[ch_df["zarr_index"].map(_has_zarr)].sort_values("zarr_index")
        else:
            ch_df = ch_df.sort_values("channel_id")
        channel_names = ch_df["channel_name"].tolist()
        if len(channel_names) != C:
            raise ValueError(
                f"Number of channels in channel_list.csv ({len(channel_names)}) "
                f"does not match channels in Zarr ({C})"
            )

        records: list[dict[str, object]] = []
        total_clusters = 0

        for lvl in sorted(unique_clusters_by_level.keys()):
            uniq_int = unique_clusters_by_level[lvl]
            sums = sum_pixels_by_level[lvl]
            nums = num_pixels_by_level[lvl]
            valid = nums > 0
            if not np.any(valid):
                continue
            avg = np.zeros_like(sums, dtype=np.float64)
            avg[valid] = sums[valid] / nums[valid][:, None]

            for i, cl in enumerate(uniq_int):
                if nums[i] <= 0:
                    continue
                rec: dict[str, object] = {
                    "level_id": int(lvl),
                    "cluster_id": int(cl),
                }
                for j, ch_name in enumerate(channel_names):
                    rec[ch_name] = float(avg[i, j])
                records.append(rec)
            total_clusters += int(uniq_int.shape[0])

        if not records:
            raise ValueError("No valid (level, cluster) averages could be computed.")

        out_df = pd.DataFrame.from_records(records)
        out_df.to_csv(out_csv, index=False)

        return JSONResponse(
            {
                "message": "ok",
                "output": os.path.relpath(out_csv, DATA_DIR),
                "n_clusters": int(total_clusters),
                "n_channels": int(C),
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Computation failed: {e}")


def _load_cluster_avg_df() -> pd.DataFrame:
    path = cluster_channel_avg_csv_path()
    if not os.path.exists(path):
        raise FileNotFoundError("public/cluster_channel_avg.csv not found. Compute it first.")
    df = pd.read_csv(path)
    if "level_id" not in df.columns or "cluster_id" not in df.columns:
        raise ValueError("cluster_channel_avg.csv missing required columns: level_id, cluster_id")
    return df


def _as_int_scalar(value) -> int:
    """
    Robustly convert groupby keys or mixed scalars to int.
    Handles cases like value == (0,) where pandas may return a 1-tuple.
    """
    try:
        if isinstance(value, (tuple, list)):
            for v in value:
                if v is None:
                    continue
                return int(v)
            value = 0
        return int(value)
    except Exception:
        try:
            return int(float(value))
        except Exception:
            return 0


def _load_data_csv_context_required() -> dict[int, dict[int, dict[str, object]]]:
    """
    Read public/data.csv, aggregate cluster size, percentage, UMAP centroid (if columns umap_x/umap_y exist) for each level/cluster.
    Return structure: { level_id: { cluster_id: { n:int, percent:float, umap:[x,y] | None } } }
    Require data.csv must exist and must contain 'clustering' column; if missing, raise exception.
    """
    csv_path = data_csv_path()
    if not os.path.exists(csv_path):
        raise FileNotFoundError("public/data.csv not found. Please upload data.csv before generating labels.")
    df = pd.read_csv(csv_path)
    if "clustering" not in df.columns:
        raise ValueError("public/data.csv missing required column 'clustering'.")
    has_level = "level_id" in df.columns
    has_umap = "umap2_x" in df.columns and "umap2_y" in df.columns
    total = len(df)
    out: dict[int, dict[int, dict[str, object]]] = {}
    if has_level:
        groups = df.groupby(["level_id", "clustering"])
        for (level_id, cluster_id), g in groups:
            n = int(len(g))
            pct = float(n / total * 100.0) if total > 0 else 0.0
            umap = None
            if has_umap and n > 0:
                umap = [float(g["umap2_x"].mean()), float(g["umap2_y"].mean())]
            lvl_id_int = _as_int_scalar(level_id)
            clu_id_int = _as_int_scalar(cluster_id)
            out.setdefault(lvl_id_int, {})[clu_id_int] = {"n": n, "percent": pct, "umap": umap}
    else:
        level_id = 0
        groups = df.groupby(["clustering"])
        for cluster_id, g in groups:
            n = int(len(g))
            pct = float(n / total * 100.0) if total > 0 else 0.0
            umap = None
            if has_umap and n > 0:
                umap = [float(g["umap2_x"].mean()), float(g["umap2_y"].mean())]
            clu_id_int = _as_int_scalar(cluster_id)
            out.setdefault(level_id, {})[clu_id_int] = {"n": n, "percent": pct, "umap": umap}
    return out


def _top_low_markers_for_level(df_level: pd.DataFrame, cluster_row: pd.Series, k: int = 6) -> tuple[list[str], list[str]]:
    """
    Select Top-K high/low expression markers for each cluster within each level, based on z-score.
    """
    channel_cols = [c for c in df_level.columns if c not in ("level_id", "cluster_id")]
    sub = df_level[channel_cols].copy()
    means = sub.mean(axis=0)
    stds = sub.std(axis=0).replace(0.0, 1.0)
    z = (cluster_row[channel_cols] - means) / stds
    z = z.sort_values(ascending=False)
    top = [f"{name}:{zv:.2f}σ" for name, zv in z.head(int(k)).items()]
    low = [f"{name}:{zv:.2f}σ" for name, zv in z.tail(int(k)).items()]
    return top, low


@router.post("/llm/generate_cluster_labels")
def generate_cluster_labels(body: Dict[str, Any] | None = None):
    """
    Read public/cluster_channel_avg.csv, select high/low expression markers for each cluster within each level,
    call LLM to generate {title, description}, output to public/cluster_labels.json.
    """
    try:
        df = _load_cluster_avg_df()
        body = body or {}
        only_levels = body.get("levels")  # Optional[List[int]]
        top_k = int(body.get("top_k", 6))
        temperature = float(body.get("temperature", LLM_TEMPERATURE))
        model = body.get("model", LLM_MODEL)

        if only_levels is not None and isinstance(only_levels, list) and len(only_levels) > 0:
            df = df[df["level_id"].isin([int(v) for v in only_levels])]
        if df.empty:
            raise ValueError("No clusters found for requested levels.")

        client = create_default_client()
        context_by_level_cluster = _load_data_csv_context_required()
        models_req = body.get("models") if isinstance(body, dict) else None
        if not models_req:
            models_req = ["Biomni", "MedGemma", "BioMistral"]
        models_to_run: list[dict[str, str]] = []
        for item in models_req:
            if isinstance(item, str):
                name = item
                reg = LLM_MODELS_REGISTRY.get(name, {})
                entry = {
                    "name": name,
                    "provider": reg.get("provider", "hf-local"),
                    "api_base": reg.get("api_base", client.api_base),
                    "model": reg.get("model", LLM_MODEL),
                    "hf_model": reg.get("hf_model", ""),
                }
                if entry["provider"] == "hf-local" and not entry["hf_model"]:
                    continue
                models_to_run.append(entry)
            elif isinstance(item, dict):
                name = str(item.get("name") or "model")
                provider = str(item.get("provider") or "hf-local")
                api_base = str(item.get("api_base") or client.api_base)
                model_id = str(item.get("model") or LLM_MODEL)
                hf_model = str(item.get("hf_model") or "")
                if provider == "hf-local" and not hf_model:
                    continue
                models_to_run.append({"name": name, "provider": provider, "api_base": api_base, "model": model_id, "hf_model": hf_model})
        results: dict[str, dict[str, dict[str, object]]] = {}
        for level_id, df_level in df.groupby("level_id"):
            level_id_int = _as_int_scalar(level_id)
            results[str(level_id_int)] = {}
            for _, row in df_level.iterrows():
                cluster_id_int = _as_int_scalar(row["cluster_id"])
                top_m, low_m = _top_low_markers_for_level(df_level, row, k=top_k)
                channel_cols = [c for c in df_level.columns if c not in ("level_id", "cluster_id")]
                avg_pairs = [f"{c}={float(row[c]):.4f}" for c in channel_cols]
                prompt = render_cluster_prompt(
                    level_id_int,
                    cluster_id_int,
                    top_m,
                    low_m,
                    channel_list=channel_cols,
                    channel_avg_pairs=avg_pairs,
                )
                extra_ctx = context_by_level_cluster.get(level_id_int, {}).get(cluster_id_int, {})
                if extra_ctx:
                    lines = []
                    if isinstance(extra_ctx.get("n"), int):
                        lines.append(f"- number of cells: {extra_ctx['n']}")
                    if isinstance(extra_ctx.get("percent"), float):
                        lines.append(f"- percentage: {extra_ctx['percent']:.2f}%")
                    um = extra_ctx.get("umap")
                    if isinstance(um, (list, tuple)) and len(um) == 2:
                        lines.append(f"- UMAP centroid: ({float(um[0]):.2f}, {float(um[1]):.2f})")
                    if lines:
                        prompt = f"{prompt}\nAdditional context:\n" + "\n".join(lines)
                system = "You are an expert assistant for immunohistology and spatial omics. Always respond in English and return strict JSON with keys: title, description."
                per_models: dict[str, dict[str, str]] = {}
                for m in models_to_run:
                    try:
                        content = client.chat(
                            system,
                            prompt,
                            response_format=None,
                            model_override=m.get("model"),
                            api_base_override=m.get("api_base"),
                            temperature_override=temperature,
                            provider_override=m.get("provider"),
                            hf_model_override=m.get("hf_model"),
                        )
                    except Exception as call_exc:
                        content = ""
                        try:
                            print(f"[LLM][error] level={level_id_int} cluster={cluster_id_int} model={m.get('name')} exception={call_exc}")
                        except Exception:
                            pass
                    text = str(content).strip()
                    title = ""
                    desc = ""
                    if text:
                        try:
                            obj = json.loads(text)
                            if isinstance(obj, dict):
                                title = str(obj.get("title", "")).strip()
                                desc = str(obj.get("description", "")).strip()
                        except Exception:
                            pass
                        if (not title or not desc) and "title" in text and "description" in text:
                            try:
                                obj = json.loads(text[text.find("{") : text.rfind("}") + 1])
                                if isinstance(obj, dict):
                                    if not title:
                                        title = str(obj.get("title", "")).strip()
                                    if not desc:
                                        desc = str(obj.get("description", "")).strip()
                            except Exception:
                                pass
                        def _is_placeholder(s: str) -> bool:
                            if not isinstance(s, str):
                                return True
                            t = s.strip().strip('"').strip("'")
                            return (t == "" or t == "..." or len(t) < 3)
                        if _is_placeholder(title) or _is_placeholder(desc):
                            try:
                                retry_prompt = f"{prompt}\n\nRewrite requirement: Provide specific English title and description; do not use placeholders like '...' or empty strings."
                                content2 = client.chat(
                                    system,
                                    retry_prompt,
                                    response_format=None,
                                    model_override=m.get("model"),
                                    api_base_override=m.get("api_base"),
                                    temperature_override=temperature,
                                    provider_override=m.get("provider"),
                                    hf_model_override=m.get("hf_model"),
                                )
                                text2 = str(content2).strip()
                                try:
                                    obj2 = json.loads(text2)
                                    if isinstance(obj2, dict):
                                        ttl2 = str(obj2.get("title", "")).strip()
                                        dsc2 = str(obj2.get("description", "")).strip()
                                        if not _is_placeholder(ttl2):
                                            title = ttl2
                                        if not _is_placeholder(dsc2):
                                            desc = dsc2
                                except Exception:
                                    pass
                            except Exception:
                                pass
                        if not desc:
                            lines = text.splitlines()
                            if lines:
                                first = lines[0].strip().strip('"').strip("'")
                                rest = "\n".join(lines[1:]).strip()
                                if not title and first:
                                    title = first[:80]
                                desc = rest or text
                    else:
                        try:
                            print(f"[LLM][warn] empty response text for level={level_id_int} cluster={cluster_id_int} model={m.get('name')}")
                        except Exception:
                            pass
                    def _fill_placeholder_if_needed(t: str, d: str) -> tuple[str, str]:
                        def _ph(x: str) -> bool:
                            return (not x) or x.strip() == "..." or len(x.strip()) < 3
                        if _ph(t):
                            t = "Phenotype-enriched cluster"
                        if _ph(d):
                            d = (
                                "This cluster likely represents a coherent cell population with distinctive phenotypic patterns "
                                "in imaging-derived embeddings. Please validate with spatial context and additional markers."
                            )
                        return t, d
                    title, desc = _fill_placeholder_if_needed(title, desc)
                    per_models[m["name"]] = {"title": title, "description": desc}
                    try:
                        print(f"[LLM][ok] level={level_id_int} cluster={cluster_id_int} model={m.get('name')} title={title} desc={desc[:120]}")
                    except Exception:
                        pass
                results[str(level_id_int)][str(cluster_id_int)] = {
                    "models": per_models
                }

        with open(CLUSTER_LABELS_JSON, "w", encoding="utf-8") as f:
            json.dump({"levels": results}, f, ensure_ascii=False, indent=2)

        return JSONResponse(
            {
                "message": "ok",
                "output": os.path.relpath(CLUSTER_LABELS_JSON, DATA_DIR),
                "levels": len(results),
                "clusters": sum(len(v) for v in results.values()),
                "top_k": top_k,
                "models": [m["name"] for m in models_to_run],
                "temperature": temperature,
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Label generation failed: {e}")


@router.get("/llm/cluster_labels")
def get_cluster_labels():
    try:
        if not os.path.exists(CLUSTER_LABELS_JSON):
            return JSONResponse({"levels": {}}, status_code=200)
        with open(CLUSTER_LABELS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        return JSONResponse(data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load cluster labels: {e}")


def _empty_cluster_label_reviews() -> dict[str, object]:
    return {"version": 1, "updated_at": None, "levels": {}}


def _load_cluster_label_reviews() -> dict[str, object]:
    legacy = os.path.join(DATA_DIR, "cluster_label_reviews.json")
    if not os.path.exists(CLUSTER_LABEL_REVIEWS_JSON) and os.path.exists(legacy):
        try:
            os.makedirs(os.path.dirname(CLUSTER_LABEL_REVIEWS_JSON), exist_ok=True)
            shutil.copy2(legacy, CLUSTER_LABEL_REVIEWS_JSON)
        except Exception:
            pass
    if not os.path.exists(CLUSTER_LABEL_REVIEWS_JSON):
        return _empty_cluster_label_reviews()
    with open(CLUSTER_LABEL_REVIEWS_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return _empty_cluster_label_reviews()
    if "levels" not in data or not isinstance(data["levels"], dict):
        data["levels"] = {}
    if "version" not in data:
        data["version"] = 1
    return data


def _save_cluster_label_reviews(data: dict[str, object]) -> None:
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    if "version" not in data:
        data["version"] = 1
    with open(CLUSTER_LABEL_REVIEWS_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@router.get("/llm/cluster_label_reviews")
def get_cluster_label_reviews():
    try:
        return JSONResponse(_load_cluster_label_reviews())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load cluster label reviews: {e}")


@router.patch("/llm/cluster_label_reviews")
def patch_cluster_label_review(body: Dict[str, Any] | None = None):
    """
    Upsert one cluster review entry.
    Body: { "level": "4", "cluster_id": "7", "entry": { status, llm_title, ... } }
    """
    try:
        body = body or {}
        level = body.get("level")
        cluster_id = body.get("cluster_id")
        entry = body.get("entry")
        if level is None or cluster_id is None or not isinstance(entry, dict):
            raise HTTPException(
                status_code=400,
                detail="Body must include level, cluster_id, and entry object.",
            )
        status = entry.get("status")
        if status not in ("accepted", "rejected", "unsure", "corrected"):
            raise HTTPException(
                status_code=400,
                detail="entry.status must be accepted, rejected, unsure, or corrected.",
            )
        level_key = str(level)
        cluster_key = str(cluster_id)
        data = _load_cluster_label_reviews()
        levels = data.setdefault("levels", {})
        if not isinstance(levels, dict):
            levels = {}
            data["levels"] = levels
        level_map = levels.setdefault(level_key, {})
        if not isinstance(level_map, dict):
            level_map = {}
            levels[level_key] = level_map
        level_map[cluster_key] = {
            "status": status,
            "llm_title": entry.get("llm_title"),
            "llm_model": entry.get("llm_model"),
            "user_title": entry.get("user_title"),
            "reviewed_at": entry.get("reviewed_at")
            or datetime.now(timezone.utc).isoformat(),
        }
        _save_cluster_label_reviews(data)
        return JSONResponse({"message": "ok", "data": data})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save cluster label review: {e}")
