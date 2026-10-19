"""Generate the synthetic audio fixtures (run inside the dev image: ``make fixtures``).

No copyrighted audio: 5 s of digital silence and a 10 s tone + noise signal,
re-encoded to WebM/Opus and M4A/AAC with ffmpeg for the container sniff/decode tests.
"""

from __future__ import annotations

import math
import random
import struct
import subprocess
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
RATE = 16_000


def write_wav(path: Path, samples: list[int]) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(struct.pack("<" + "h" * len(samples), *samples))


def silence(seconds: float) -> list[int]:
    return [0] * int(RATE * seconds)


def tone_noise(seconds: float) -> list[int]:
    rng = random.Random(42)
    out: list[int] = []
    for i in range(int(RATE * seconds)):
        t = i / RATE
        env = 0.5 + 0.5 * math.sin(2 * math.pi * 0.5 * t)  # slow amplitude modulation
        v = 0.25 * env * math.sin(2 * math.pi * 220 * t) + 0.05 * (rng.random() * 2 - 1)
        out.append(int(max(-1.0, min(1.0, v)) * 32767))
    return out


def ffmpeg(src: Path, dst: Path, *args: str) -> None:
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(src), *args, str(dst)], check=True)


def main() -> None:
    write_wav(HERE / "silence_5s.wav", silence(5))
    tone = HERE / "tone_10s.wav"
    write_wav(tone, tone_noise(10))
    ffmpeg(tone, HERE / "tone_10s.webm", "-c:a", "libopus", "-b:a", "24k")
    ffmpeg(tone, HERE / "tone_10s.m4a", "-c:a", "aac", "-b:a", "32k")
    ffmpeg(tone, HERE / "tone_10s.ogg", "-c:a", "libopus", "-b:a", "24k")
    ffmpeg(tone, HERE / "tone_10s.mp3", "-c:a", "libmp3lame", "-b:a", "32k")
    for p in sorted(HERE.glob("*.*")):
        if p.suffix in {".wav", ".webm", ".m4a", ".ogg", ".mp3"}:
            print(f"{p.name:16s} {p.stat().st_size:>8d} bytes")


if __name__ == "__main__":
    main()
