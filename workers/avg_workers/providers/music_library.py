"""Curated royalty-free music library as a music provider.

Layout of ``MUSIC_LIBRARY_DIR``::

    index.json
    tracks/<file>.mp3|.wav

``index.json`` is a list of entries::

    {"file": "tracks/quiet-dawn.mp3", "moods": ["calm", "hopeful"], "bpm": 78,
     "energy": 0.3, "license": "CC-BY-4.0", "attribution": "..."}

Selection scores mood-word overlap first, then bpm distance and energy. The chosen track is
transcoded to WAV and trimmed to the requested length (the renderer loops shorter beds).
Every artifact records the track and licence so attribution can be generated.
"""

from __future__ import annotations

import json
import logging
import random
from dataclasses import dataclass
from pathlib import Path

from avg_workers.ffmpeg import FFmpeg
from avg_workers.providers.base import AudioFile, MusicRequest, ProviderInfo, ProviderOutputError

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Track:
    file: Path
    moods: tuple[str, ...]
    bpm: int | None
    energy: float | None
    license: str
    attribution: str


def load_index(library_dir: Path) -> list[Track]:
    index = library_dir / "index.json"
    if not index.exists():
        return []
    entries = json.loads(index.read_text())
    tracks: list[Track] = []
    for e in entries:
        path = library_dir / e["file"]
        if not path.exists():
            log.warning("music library entry missing on disk: %s", path)
            continue
        tracks.append(
            Track(
                file=path,
                moods=tuple(m.lower() for m in e.get("moods", [])),
                bpm=e.get("bpm"),
                energy=e.get("energy"),
                license=e.get("license", "unknown"),
                attribution=e.get("attribution", ""),
            )
        )
    return tracks


def score(track: Track, req: MusicRequest) -> float:
    words = {w.strip(",.;").lower() for w in req.mood.split()}
    overlap = len(words & set(track.moods))
    s = overlap * 10.0
    if req.bpm and track.bpm:
        s -= abs(req.bpm - track.bpm) / 10.0
    return s


class LibraryMusic:
    def __init__(self, library_dir: Path, ffmpeg: FFmpeg) -> None:
        self.library_dir = library_dir
        self.ffmpeg = ffmpeg
        self.tracks = load_index(library_dir)
        self.info = ProviderInfo(name="library", model=f"music-library({len(self.tracks)})")

    def pick(self, req: MusicRequest) -> Track:
        if not self.tracks:
            raise ProviderOutputError(f"music library at {self.library_dir} has no tracks")
        ranked = sorted(self.tracks, key=lambda t: score(t, req), reverse=True)
        best = score(ranked[0], req)
        ties = [t for t in ranked if score(t, req) == best]
        return random.Random(req.seed).choice(ties)

    async def generate(self, req: MusicRequest, out: Path) -> AudioFile:
        track = self.pick(req)
        out.parent.mkdir(parents=True, exist_ok=True)
        await self.ffmpeg.run(
            [
                "-i",
                str(track.file),
                "-t",
                f"{req.duration_sec:.3f}",
                "-ac",
                "2",
                "-ar",
                "48000",
                "-c:a",
                "pcm_s16le",
                str(out),
            ]
        )
        probe = await self.ffmpeg.probe(out)
        log.info("music: %s (%s)", track.file.name, track.license)
        return AudioFile(
            path=out,
            duration_sec=round(probe.duration_sec, 3),
            provider=ProviderInfo(name="library", model=track.file.stem),
            cost_usd=0.0,
        )
