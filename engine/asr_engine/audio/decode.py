"""ffmpeg -> float32 mono 16 kHz PCM."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16_000


class DecodeError(Exception):
    """ffmpeg could not decode the file (corrupt, truncated, not audio)."""


class DecodeTimeoutError(DecodeError):
    """ffmpeg exceeded the time limit."""


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def decode_to_pcm(path: Path, *, max_seconds: int, timeout_s: int = 60) -> np.ndarray:
    """Decode ``path`` to float32 PCM in [-1, 1]. Output is capped at ``max_seconds + 10`` s.

    The cap lets the caller detect "too long" without decoding a whole hour of audio.
    """
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-i",
        str(path),
        "-vn",
        "-t",
        str(max_seconds + 10),
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout_s, check=False)
    except FileNotFoundError as exc:
        raise DecodeError("ffmpeg is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise DecodeTimeoutError(f"ffmpeg timed out after {timeout_s}s") from exc
    if proc.returncode != 0 or not proc.stdout:
        # stderr may contain the file name but never audio content; keep it short.
        detail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no output"]
        raise DecodeError(f"could not decode audio: {detail[0][:200]}")
    pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return pcm


def duration_seconds(pcm: np.ndarray) -> float:
    return float(len(pcm)) / SAMPLE_RATE
