"""Bearer-token authentication for ``/v1/*``."""

from __future__ import annotations

import hmac

from fastapi import Request

from asr_engine.api.errors import ApiError


def _extract_bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def token_allowed(token: str | None, keys: list[str]) -> bool:
    """Constant-time comparison against every configured key."""
    if not keys:
        return True
    if token is None:
        return False
    ok = False
    for key in keys:
        ok |= hmac.compare_digest(token.encode(), key.encode())
    return ok


async def require_api_key(request: Request) -> None:
    keys: list[str] = request.app.state.settings.api_key_list
    if not token_allowed(_extract_bearer(request), keys):
        raise ApiError(
            401,
            "Invalid or missing API key. Send 'Authorization: Bearer <key>'.",
            error_type="invalid_request_error",
            code="invalid_api_key",
        )
