"""``GET /v1/models``: the single loaded model."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from asr_engine.api.schemas import ModelList, ModelOut
from asr_engine.auth import require_api_key

router = APIRouter(dependencies=[Depends(require_api_key)])


@router.get("/v1/models", response_model=ModelList)
async def list_models(request: Request) -> ModelList:
    state = request.app.state
    created = int(state.started_at)
    return ModelList(data=[ModelOut(id=state.settings.model, created=created)])
