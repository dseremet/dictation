from __future__ import annotations

from pathlib import Path

import pytest

from asr_engine.audio.decode import DecodeError, decode_to_pcm, duration_seconds, ffmpeg_available
from asr_engine.audio.sniff import extension_for, sniff

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


@pytest.mark.parametrize(
    ("name", "kind"),
    [("tone_10s.wav", "wav"), ("tone_10s.webm", "webm"), ("tone_10s.m4a", "mp4"),
     ("tone_10s.ogg", "ogg"), ("tone_10s.mp3", "mp3"), ("silence_5s.wav", "wav")],
)
def test_sniff_fixtures(name: str, kind: str) -> None:
    head = (FIXTURES / name).read_bytes()[:16]
    assert sniff(head) == kind
    assert extension_for(kind)


def test_sniff_rejects_garbage() -> None:
    assert sniff(b"") is None
    assert sniff(b"<html><body>") is None
    assert sniff(b"%PDF-1.4 ...") is None
    assert sniff(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8) is None
    assert sniff(b"fLaC" + b"\x00" * 12) == "flac"
    assert sniff(b"ID3\x04" + b"\x00" * 12) == "mp3"
    assert sniff(b"\xff\xfb\x90\x00" + b"\x00" * 12) == "mp3"


@pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")
@pytest.mark.parametrize("name", ["tone_10s.wav", "tone_10s.webm", "tone_10s.m4a", "tone_10s.ogg", "tone_10s.mp3"])
def test_decode_fixture_durations(name: str) -> None:
    pcm = decode_to_pcm(FIXTURES / name, max_seconds=60)
    assert pcm.dtype.name == "float32"
    assert 9.7 <= duration_seconds(pcm) <= 10.3
    assert abs(pcm).max() > 0.05


@pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")
def test_decode_caps_length() -> None:
    pcm = decode_to_pcm(FIXTURES / "tone_10s.wav", max_seconds=2)
    assert duration_seconds(pcm) <= 12.0  # cap = max + 10 s


@pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")
def test_decode_garbage_raises(tmp_path: Path) -> None:
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"RIFF\x00\x00\x00\x00WAVE" + b"\x01" * 100)
    with pytest.raises(DecodeError):
        decode_to_pcm(bad, max_seconds=10)
