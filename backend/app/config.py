"""Environment configuration. The API key never leaves the server."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = BACKEND_DIR / ".env"

# Threshold compaction (compact-2026-01-12), as listed in the Anthropic docs.
# Dated snapshots such as claude-sonnet-5-5-20260928 match the undated id.
# Longer ids are matched first, so claude-sonnet-5-5 does not collapse into claude-sonnet-5.
COMPACTION_MODELS = (
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-mythos-preview",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
)

KEY_MISSING = "ANTHROPIC_API_KEY is not set in backend/.env"
MODEL_MISSING = "Choose a model in the header, or set ANTHROPIC_MODEL in backend/.env"


def _positive_int_env(name: str, default: str) -> int:
    raw = os.environ.get(name, default)
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < 1:
        raise RuntimeError(f"{name} must be at least 1")
    return value


@dataclass(frozen=True)
class Settings:
    api_key: str | None
    model: str | None
    max_tokens: int
    cache_ttl: str
    compact_trigger_tokens: int
    web_search_max_uses: int
    web_fetch_max_uses: int
    web_fetch_max_content_tokens: int
    web_search_blocked_domains: tuple[str, ...]

    @property
    def compaction_supported(self) -> bool:
        return self.model is not None and model_supports_compaction(self.model)


def model_supports_compaction(model: str) -> bool:
    """True when the model id is on the threshold-compaction list.

    A trailing -YYYYMMDD snapshot suffix still matches. A longer sibling such
    as claude-opus-5-5 does not, because the docs omit it.
    """
    for name in sorted(COMPACTION_MODELS, key=len, reverse=True):
        if model == name:
            return True
        prefix = name + "-"
        if model.startswith(prefix):
            rest = model[len(prefix) :]
            if len(rest) == 8 and rest.isdigit():
                return True
    return False


def load_settings() -> Settings:
    load_dotenv(ENV_PATH, override=False)

    cache_ttl = os.environ.get("CACHE_TTL", "5m")
    if cache_ttl not in ("5m", "1h"):
        raise RuntimeError("CACHE_TTL must be '5m' or '1h'")

    raw_trigger = os.environ.get("COMPACT_TRIGGER_TOKENS", "150000")
    try:
        compact_trigger_tokens = int(raw_trigger)
    except ValueError as exc:
        raise RuntimeError("COMPACT_TRIGGER_TOKENS must be an integer") from exc
    if compact_trigger_tokens < 50_000:
        raise RuntimeError(
            "COMPACT_TRIGGER_TOKENS must be at least 50000 (the API minimum)"
        )

    raw_max = os.environ.get("MAX_TOKENS", "4096")
    try:
        max_tokens = int(raw_max)
    except ValueError as exc:
        raise RuntimeError("MAX_TOKENS must be an integer") from exc
    if max_tokens < 1:
        raise RuntimeError("MAX_TOKENS must be at least 1")

    web_search_max_uses = _positive_int_env("WEB_SEARCH_MAX_USES", "5")
    web_fetch_max_uses = _positive_int_env("WEB_FETCH_MAX_USES", "5")
    web_fetch_max_content_tokens = _positive_int_env("WEB_FETCH_MAX_CONTENT_TOKENS", "20000")
    web_search_blocked_domains = tuple(
        item.strip()
        for item in os.environ.get("WEB_SEARCH_BLOCKED_DOMAINS", "").split(",")
        if item.strip()
    )

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or None
    model = os.environ.get("ANTHROPIC_MODEL", "").strip() or None
    return Settings(
        api_key=api_key,
        model=model,
        max_tokens=max_tokens,
        cache_ttl=cache_ttl,
        compact_trigger_tokens=compact_trigger_tokens,
        web_search_max_uses=web_search_max_uses,
        web_fetch_max_uses=web_fetch_max_uses,
        web_fetch_max_content_tokens=web_fetch_max_content_tokens,
        web_search_blocked_domains=web_search_blocked_domains,
    )


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = load_settings()
    return _settings
