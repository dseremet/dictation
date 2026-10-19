"""``GET /health`` (no auth): 503 ``loading`` until the model is in memory."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from asr_engine import __version__
from asr_engine.api.schemas import Health

router = APIRouter()


@router.get("/health", response_model=None)
async def health(request: Request) -> JSONResponse:
    state = request.app.state
    engine = getattr(state, "engine", None)
    ready = bool(getattr(state, "ready", False)) and engine is not None and engine.loaded
    body = Health(
        status="ok" if ready else "loading",
        model=engine.info.model if engine else None,
        device=engine.info.device if engine else None,
        compute_type=engine.info.compute_type if engine else None,
        glossary_version=getattr(getattr(state, "glossary", None), "version", None),
        inflight=state.slots.inflight if hasattr(state, "slots") else 0,
        waiting=state.slots.waiting if hasattr(state, "slots") else 0,
        uptime_s=round(time.time() - state.started_at, 1) if hasattr(state, "started_at") else 0.0,
        version=__version__,
    )
    return JSONResponse(status_code=200 if ready else 503, content=body.model_dump())
