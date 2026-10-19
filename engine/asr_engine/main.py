"""App factory and entry point (``python -m asr_engine.main``)."""

from __future__ import annotations

import asyncio
import logging
import tempfile
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from asr_engine import __version__
from asr_engine.api import health, models, transcriptions
from asr_engine.api.errors import install_error_handlers
from asr_engine.asr.engine import AsrEngine, Slots
from asr_engine.config import Settings, get_settings
from asr_engine.normalizer import Glossary, load_glossary

log = logging.getLogger("asr")


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def create_app(settings: Settings | None = None, engine: Any | None = None, glossary: Glossary | None = None) -> FastAPI:
    """Build the FastAPI app. ``engine``/``glossary`` can be injected (tests, benchmarks)."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.started_at = time.time()
        app.state.ready = False
        settings.tmp_dir.mkdir(parents=True, exist_ok=True)
        tempfile.tempdir = str(settings.tmp_dir)  # multipart spool files stay on the tmpfs too
        app.state.glossary = glossary or load_glossary(settings.glossary_dir)
        log.info("glossary %s: %d terms", app.state.glossary.version, len(app.state.glossary.terms))
        app.state.engine = engine or AsrEngine(settings)
        if engine is None and settings.preload:
            await asyncio.to_thread(app.state.engine.load)
        app.state.ready = app.state.engine.loaded
        if not settings.api_key_list:
            log.warning("ASR_API_KEYS is empty: the API is unauthenticated")
        yield

    app = FastAPI(
        title="ditactic ASR engine",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
    )
    app.state.settings = settings
    app.state.slots = Slots(settings.max_concurrency, settings.queue_depth)
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(models.router)
    app.include_router(transcriptions.router)
    return app


def main() -> None:
    import uvicorn

    settings = get_settings()
    configure_logging(settings.log_level)
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        workers=1,
        timeout_keep_alive=30,
        timeout_graceful_shutdown=settings.request_timeout_s + 30,
    )


if __name__ == "__main__":
    main()
