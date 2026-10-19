"""Detect the audio container from magic bytes (never trust the client's MIME type)."""

from __future__ import annotations

ALLOWED_KINDS: frozenset[str] = frozenset({"webm", "mp4", "wav", "ogg", "mp3", "flac"})


def sniff(head: bytes) -> str | None:
    """Return ``webm|mp4|wav|ogg|mp3|flac`` or ``None`` for unknown data."""
    if len(head) < 4:
        return None
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"  # EBML: WebM or Matroska
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "mp4"  # MP4 / M4A / 3GP family
    if head[:4] == b"RIFF" and len(head) >= 12 and head[8:12] == b"WAVE":
        return "wav"
    if head[:4] == b"OggS":
        return "ogg"
    if head[:4] == b"fLaC":
        return "flac"
    if head[:3] == b"ID3":
        return "mp3"
    if head[0] == 0xFF and (head[1] & 0xE0) == 0xE0 and (head[1] & 0x06) != 0:
        return "mp3"  # raw MPEG audio frame sync
    return None


def extension_for(kind: str) -> str:
    return {"webm": "webm", "mp4": "m4a", "wav": "wav", "ogg": "ogg", "mp3": "mp3", "flac": "flac"}[
        kind
    ]
