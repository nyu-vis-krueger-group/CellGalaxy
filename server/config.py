import os
import shutil


DATA_DIR = "public"

CACHE_DIR = os.path.join(os.getcwd(), ".cache")
ZARR_DIR = os.path.join(DATA_DIR, "output.zarr")
DEFAULT_TILE = 16


os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

LLM_TOKEN_FILE = os.environ.get(
    "LLM_TOKEN_FILE",
    os.path.join(os.getcwd(), "server", "secrets", "llm_token.txt"),
)
LLM_API_BASE = os.environ.get("LLM_API_BASE", "https://api.openai.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.2"))
CLUSTER_LABELS_JSON = os.path.join(DATA_DIR, "cluster_labels.json")

HF_TOKEN_FILE = os.environ.get(
    "HF_TOKEN_FILE",
    os.path.join(os.getcwd(), "server", "secrets", "hf_token.txt"),
)

LLM_MODELS_REGISTRY = {
    "Biomni": {
        "provider": os.environ.get("BIOMNI_PROVIDER", "hf-local"),
        "hf_model": os.environ.get("HF_MODEL_BIOMNI", ""),
        "api_base": os.environ.get("LLM_API_BASE_BIOMNI", LLM_API_BASE),
        "model": os.environ.get("LLM_MODEL_BIOMNI", LLM_MODEL),
    },
    "MedGemma": {
        "provider": os.environ.get("MedGemma_PROVIDER", "hf-local"),
        "hf_model": os.environ.get("HF_MODEL_MedGemma", "google/medgemma-4b-it"),
        "api_base": os.environ.get("LLM_API_BASE_MedGemma", LLM_API_BASE),
        "model": os.environ.get("LLM_MODEL_MedGemma", LLM_MODEL),
    },
    "BioMistral": {
        "provider": os.environ.get("BioMistral_PROVIDER", "hf-local"),
        "hf_model": os.environ.get("HF_MODEL_BioMistral", "BioMistral/BioMistral-7B-DARE"),
        "api_base": os.environ.get("LLM_API_BASE_BioMistral", LLM_API_BASE),
        "model": os.environ.get("LLM_MODEL_BioMistral", LLM_MODEL),
    },
}


def remove_path(path: str) -> None:
    """remove file or directory, silently fail on error"""
    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        elif os.path.exists(path):
            os.remove(path)
    except FileNotFoundError:
        pass
    except Exception as exc:
        print(f"failed to remove {path}: {exc}")


def clear_cache_dir() -> None:
    """clear cache directory and recreate it"""
    if os.path.isdir(CACHE_DIR):
        shutil.rmtree(CACHE_DIR)
    os.makedirs(CACHE_DIR, exist_ok=True)


