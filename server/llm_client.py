import json
import os
from typing import Optional
from urllib import request as urlrequest

from .config import (
    LLM_API_BASE,
    LLM_MODEL,
    LLM_TEMPERATURE,
    LLM_TOKEN_FILE,
    HF_TOKEN_FILE,
)


def _read_token_from_file(path: str) -> Optional[str]:
    try:
        if not path:
            return None
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return None


class LLMClient:
    _hf_local_cache = {}
    def __init__(
        self,
        api_base: str,
        model: str,
        temperature: float,
        api_key: Optional[str],
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.model = model
        self.temperature = float(temperature)
        # priority: explicit parameters > env(LLM_API_KEY / OPENAI_API_KEY) > file
        env_key = os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")
        file_key = _read_token_from_file(LLM_TOKEN_FILE)
        self.api_key = api_key or env_key or file_key
        # HF token
        self.hf_token = os.environ.get("HF_TOKEN") or _read_token_from_file(HF_TOKEN_FILE)

    def chat(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: Optional[str] = None,
        model_override: Optional[str] = None,
        api_base_override: Optional[str] = None,
        temperature_override: Optional[float] = None,
        provider_override: Optional[str] = None,
        hf_model_override: Optional[str] = None,
    ) -> str:

        provider = (provider_override or "").lower()
        if provider == "hf-local":
            if not self.hf_token:
                raise RuntimeError("HF token not found. Please set HF_TOKEN or server/secrets/hf_token.txt")
            model_id = hf_model_override or model_override
            if not model_id:
                raise RuntimeError("HF model id is required for provider='hf-local'")
            try:
                import torch  # type: ignore
                from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
            except Exception as exc:
                raise RuntimeError("transformers/torch not installed. Please add them to requirements and install.") from exc
            # lazy load and cache
            if model_id not in LLMClient._hf_local_cache:
                try:
                    print(f"[LLM] Loading model: {model_id}")
                    dtype = torch.bfloat16 if hasattr(torch, "bfloat16") else torch.float32
                    model_kwargs = dict(torch_dtype=dtype, device_map="auto", token=self.hf_token)
                    model = AutoModelForCausalLM.from_pretrained(model_id, **model_kwargs)
                    tokenizer = AutoTokenizer.from_pretrained(model_id, token=self.hf_token)
                    # Ensure pad token is set
                    if tokenizer.pad_token is None:
                        tokenizer.pad_token = tokenizer.eos_token
                    LLMClient._hf_local_cache[model_id] = (model, tokenizer)
                    print(f"[LLM] Model loaded successfully: {model_id}")
                except Exception as load_exc:
                    print(f"[LLM][error] Failed to load model {model_id}: {load_exc}")
                    raise RuntimeError(f"Failed to load model {model_id}: {load_exc}") from load_exc
            model, tokenizer = LLMClient._hf_local_cache[model_id]
            
            # Check if this is a Mistral/BioMistral model (they need special handling)
            is_mistral = "mistral" in model_id.lower() or "biomistral" in model_id.lower()
            
            # For Mistral-based models, use manual formatting (they don't support system role in chat template)
            if is_mistral:
                # Mistral format: <s>[INST] System\n\nUser [/INST]
                if system_prompt:
                    formatted = f"<s>[INST] {system_prompt}\n\n{user_prompt} [/INST]"
                else:
                    formatted = f"<s>[INST] {user_prompt} [/INST]"
                inputs = tokenizer(formatted, return_tensors="pt").to(model.device)
            else:
                # Try chat template first (for models that support it)
                messages = [
                    {"role": "system", "content": [{"type": "text", "text": system_prompt or ""}]},
                    {"role": "user", "content": [{"type": "text", "text": user_prompt or ""}]},
                ]
                try:
                    # Check if tokenizer has chat_template and try to use it
                    if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template is not None:
                        try:
                            # Try the original method first (tokenize=True, return_dict=True, return_tensors="pt")
                            inputs = tokenizer.apply_chat_template(
                                messages,
                                add_generation_prompt=True,
                                tokenize=True,
                                return_dict=True,
                                return_tensors="pt",
                            ).to(model.device)
                        except Exception:
                            # Fallback: get formatted string then tokenize
                            formatted = tokenizer.apply_chat_template(
                                messages,
                                add_generation_prompt=True,
                                tokenize=False,
                            )
                            inputs = tokenizer(formatted, return_tensors="pt").to(model.device)
                    else:
                        # Generic format
                        prompt = (system_prompt or "").strip()
                        if prompt:
                            prompt = f"{prompt}\n\n{user_prompt or ''}"
                        else:
                            prompt = user_prompt or ""
                        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
                except Exception as template_exc:
                    # If chat template fails, fall back to simple format
                    print(f"[LLM][warn] Chat template failed for {model_id}, using simple format: {template_exc}")
                    prompt = (system_prompt or "").strip()
                    if prompt:
                        prompt = f"{prompt}\n\n{user_prompt or ''}"
                    else:
                        prompt = user_prompt or ""
                    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
            
            # Generate response
            try:
                input_len = inputs["input_ids"].shape[-1]
                with torch.inference_mode():
                    generation = model.generate(
                        **inputs,
                        max_new_tokens=512,
                        do_sample=False,
                        pad_token_id=tokenizer.pad_token_id,
                        eos_token_id=tokenizer.eos_token_id,
                    )
                    generation = generation[0][input_len:]
                text = tokenizer.decode(generation, skip_special_tokens=True)
                return text
            except Exception as gen_exc:
                print(f"[LLM][error] Generation failed for {model_id}: {gen_exc}")
                raise RuntimeError(f"Failed to generate with {model_id}: {gen_exc}") from gen_exc
        raise RuntimeError("Only 'hf-local' provider is supported. Please configure HF models and HF_TOKEN.")


def create_default_client() -> LLMClient:
    return LLMClient(
        api_base=LLM_API_BASE,
        model=LLM_MODEL,
        temperature=LLM_TEMPERATURE,
        api_key=None,
    )


