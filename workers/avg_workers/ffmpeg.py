"""Thin async wrapper around the ffmpeg / ffprobe binaries."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


@dataclass
class ProbeResult:
    duration_sec: float
    has_video: bool
    has_audio: bool
    width: int | None
    height: int | None
    fps: float | None


class FFmpeg:
    def __init__(self, ffmpeg_bin: str = "ffmpeg", ffprobe_bin: str = "ffprobe") -> None:
        self.ffmpeg_bin = ffmpeg_bin
        self.ffprobe_bin = ffprobe_bin

    async def run(self, args: list[str], timeout_sec: float = 600) -> str:
        """Run ffmpeg with ``args`` (without the binary). Returns stderr (ffmpeg logs there)."""
        cmd = [self.ffmpeg_bin, "-hide_banner", "-nostdin", "-y", *args]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except TimeoutError as e:
            proc.kill()
            raise FFmpegError(f"ffmpeg timed out after {timeout_sec}s: {' '.join(cmd)}") from e
        text = err.decode("utf-8", "replace")
        if proc.returncode != 0:
            raise FFmpegError(f"ffmpeg failed ({proc.returncode}): {' '.join(cmd)}\n{text[-4000:]}")
        return text

    async def probe(self, path: Path) -> ProbeResult:
        cmd = [
            self.ffprobe_bin,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            raise FFmpegError(f"ffprobe failed: {err.decode('utf-8', 'replace')[-2000:]}")
        data = json.loads(out.decode())
        streams = data.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
        fmt = data.get("format", {})
        duration = float(fmt.get("duration") or (video or audio or {}).get("duration") or 0.0)
        fps = None
        if video and video.get("avg_frame_rate") and video["avg_frame_rate"] != "0/0":
            num, den = video["avg_frame_rate"].split("/")
            fps = float(num) / float(den) if float(den) else None
        return ProbeResult(
            duration_sec=duration,
            has_video=video is not None,
            has_audio=audio is not None,
            width=int(video["width"]) if video else None,
            height=int(video["height"]) if video else None,
            fps=fps,
        )

    async def ken_burns(
        self,
        *,
        image: Path,
        out: Path,
        duration_sec: float,
        fps: int,
        width: int,
        height: int,
        zoom_from: float = 1.0,
        zoom_to: float = 1.12,
        pan: str = "center",
    ) -> None:
        """Animate a still into a clip with a slow zoom and optional pan."""
        frames = max(1, int(round(duration_sec * fps)))
        # Work on an upscaled canvas so zoompan's integer stepping does not jitter.
        big_w, big_h = width * 2, height * 2
        zoom_expr = f"{zoom_from}+({zoom_to}-{zoom_from})*on/{frames}"
        if pan == "left":
            x_expr = f"(iw-iw/zoom)*(1-on/{frames})"
        elif pan == "right":
            x_expr = f"(iw-iw/zoom)*on/{frames}"
        else:
            x_expr = "iw/2-(iw/zoom/2)"
        y_expr = "ih/2-(ih/zoom/2)"
        vf = (
            f"scale={big_w}:{big_h}:force_original_aspect_ratio=increase,"
            f"crop={big_w}:{big_h},"
            f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}':d={frames}:s={width}x{height}:fps={fps},"
            f"format=yuv420p"
        )
        out.parent.mkdir(parents=True, exist_ok=True)
        await self.run(
            [
                "-loop",
                "1",
                "-i",
                str(image),
                "-vf",
                vf,
                "-t",
                f"{duration_sec:.3f}",
                "-r",
                str(fps),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-an",
                str(out),
            ]
        )

    async def normalise_clip(
        self, src: Path, out: Path, *, fps: int, width: int, height: int
    ) -> None:
        """Constant frame rate, exact resolution (cover-crop), yuv420p, high-bitrate H.264."""
        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},fps={fps},format=yuv420p"
        )
        out.parent.mkdir(parents=True, exist_ok=True)
        await self.run(
            [
                "-i",
                str(src),
                "-vf",
                vf,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "16",
                "-an",
                str(out),
            ]
        )

    async def black_frame_seconds(self, path: Path, min_duration: float = 2.0) -> float:
        """Total seconds of black detected in ``path`` (segments >= min_duration)."""
        log = await self.run(
            [
                "-i",
                str(path),
                "-vf",
                f"blackdetect=d={min_duration}:pix_th=0.10",
                "-an",
                "-f",
                "null",
                "-",
            ]
        )
        total = 0.0
        for m in re.finditer(r"black_duration:(\d+(?:\.\d+)?)", log):
            total += float(m.group(1))
        return total

    async def extract_frame(
        self, src: Path, out: Path, at_sec: float, width: int | None = None
    ) -> None:
        vf = f"scale={width}:-2" if width else "null"
        out.parent.mkdir(parents=True, exist_ok=True)
        await self.run(
            ["-ss", f"{at_sec:.3f}", "-i", str(src), "-frames:v", "1", "-vf", vf, str(out)]
        )
