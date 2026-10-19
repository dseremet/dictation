"""Runtime settings (``ASR_*`` environment variables)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SUPPORTED_LANGUAGES: frozenset[str] = frozenset({"bs", "hr", "sr"})

MODEL_ALIASES: dict[str, str] = {
    "turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
    "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v2": "Systran/faster-whisper-large-v2",
    "medium": "Systran/faster-whisper-medium",
    "small": "Systran/faster-whisper-small",
    "base": "Systran/faster-whisper-base",
    "tiny": "Systran/faster-whisper-tiny",
}


class Settings(BaseSettings):
    """All knobs of the engine. Values come from the environment (prefix ``ASR_``)."""

    model_config = SettingsConfigDict(env_prefix="ASR_", env_file=None, extra="ignore")

    model: str = "deepdml/faster-whisper-large-v3-turbo-ct2"
    device: str = "auto"
    compute_type: str = "int8"
    cpu_threads: int = 0
    num_workers: int = 1
    max_concurrency: int = 1
    queue_depth: int = 4
    request_timeout_s: int = 600
    api_keys: str = ""
    default_language: str = "auto"
    decode_lang_map: str = "bs:hr"
    glossary_dir: Path = Path(__file__).resolve().parent.parent / "glossary"
    cache_dir: Path = Path("/models")
    tmp_dir: Path = Path("/tmp/asr")
    max_upload_mb: int = 50
    max_audio_seconds: int = 600
    ffmpeg_timeout_s: int = 60
    beam_size: int = 5
    best_of: int = 5
    prompt_token_budget: int = 96
    hotwords_token_budget: int = 96
    min_speech_seconds: float = 0.5
    docs_enabled: bool = False
    preload: bool = True
    log_level: str = "info"
    host: str = "0.0.0.0"
    port: int = 8000

    @field_validator("device")
    @classmethod
    def _device(cls, v: str) -> str:
        v = v.lower()
        if v not in {"auto", "cpu", "cuda"}:
            raise ValueError("ASR_DEVICE must be auto, cpu or cuda")
        return v

    @field_validator("default_language")
    @classmethod
    def _default_language(cls, v: str) -> str:
        v = v.lower()
        if v != "auto" and v not in SUPPORTED_LANGUAGES:
            raise ValueError("ASR_DEFAULT_LANGUAGE must be auto, bs, hr or sr")
        return v

    @property
    def api_key_list(self) -> list[str]:
        return [k.strip() for k in self.api_keys.split(",") if k.strip()]

    @property
    def decode_map(self) -> dict[str, str]:
        """``bs:hr,sr:sr`` -> ``{"bs": "hr", "sr": "sr"}``."""
        out: dict[str, str] = {}
        for pair in self.decode_lang_map.split(","):
            if ":" in pair:
                src, dst = pair.split(":", 1)
                if src.strip() and dst.strip():
                    out[src.strip().lower()] = dst.strip().lower()
        return out

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def resolve_model(self) -> str:
        """Alias -> HF repo; local directory -> absolute path; anything else as given."""
        spec = self.model.strip()
        if spec in MODEL_ALIASES:
            return MODEL_ALIASES[spec]
        local = Path(spec)
        if local.is_dir():
            return str(local.resolve())
        cached = self.cache_dir / spec
        if cached.is_dir():
            return str(cached.resolve())
        return spec


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
