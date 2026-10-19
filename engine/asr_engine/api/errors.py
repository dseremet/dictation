"""OpenAI-style error envelope: ``{"error": {"message", "type", "param", "code"}}``."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = logging.getLogger("asr.api")


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        message: str,
        *,
        error_type: str = "invalid_request_error",
        code: str | None = None,
        param: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.error_type = error_type
        self.code = code
        self.param = param
        self.headers = headers or {}


def envelope(message: str, error_type: str, code: str | None = None, param: str | None = None) -> dict:
    return {"error": {"message": message, "type": error_type, "param": param, "code": code}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content=envelope(exc.message, exc.error_type, exc.code, exc.param),
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = [str(x) for x in first.get("loc", []) if x not in ("body",)]
        param = ".".join(loc) or None
        message = first.get("msg", "Invalid request")
        return JSONResponse(
            status_code=422,
            content=envelope(f"{param}: {message}" if param else message, "invalid_request_error", "invalid_value", param),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error: %s", type(exc).__name__)
        return JSONResponse(status_code=500, content=envelope("Internal server error", "server_error", "internal"))
