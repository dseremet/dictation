from __future__ import annotations

import asyncio

import pytest

from asr_engine.asr.engine import Slots, SlotsFullError, pick_compute_type, pick_device


def test_queue_depth_limits_waiters() -> None:
    async def scenario() -> None:
        slots = Slots(concurrency=1, queue_depth=1)
        first = await slots.acquire()
        waiter = asyncio.create_task(slots.acquire())
        await asyncio.sleep(0)
        assert slots.waiting == 1
        with pytest.raises(SlotsFullError):
            await slots.acquire()
        first.release()
        second = await waiter
        assert slots.inflight == 1
        second.release()
        second.release()  # idempotent
        assert slots.inflight == 0

    asyncio.run(scenario())


def test_device_and_compute_fallbacks() -> None:
    assert pick_device("cpu") == "cpu"
    assert pick_device("auto") in {"cpu", "cuda"}
    assert pick_compute_type("int8", "cpu") in {"int8", "int8_float32", "float32"}
    assert pick_compute_type("float16", "cpu") in {"int8", "int8_float32", "float32", "float16"}
