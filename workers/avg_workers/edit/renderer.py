"""Timeline -> MP4 with a single FFmpeg filter graph.

Video: per-clip trim/scale/fps normalisation, hold-frame padding when a clip is shorter than
its slot, xfade / fadeblack / concat transitions, drawtext overlays, ASS subtitle burn-in.
Audio: per-clip gain and placement, per-track mixing, music looping and sidechain ducking
under voice, loudness normalisation, exact-length padding/trim.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from avg_workers.contracts import Timeline
from avg_workers.edit.subtitles import FONT_PATH, to_ass
from avg_workers.ffmpeg import FFmpeg

INT32_MAX = 2_147_483_647


@dataclass
class RenderOutputs:
    mp4: Path
    preview: Path
    thumb: Path
    poster: Path
    duration_sec: float


def _esc_filter_path(p: Path) -> str:
    # Escape characters that are special inside a filter-graph option value.
    return str(p).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _fmt(x: float) -> str:
    return f"{x:.3f}"


class TimelineRenderer:
    def __init__(self, ffmpeg: FFmpeg, *, preset: str = "medium", crf: int = 18) -> None:
        self.ffmpeg = ffmpeg
        self.preset = preset
        self.crf = crf

    async def render(
        self,
        timeline: Timeline,
        resolve: dict[str, Path],
        work_dir: Path,
        out_mp4: Path,
        *,
        preview_mp4: Path,
        thumb_jpg: Path,
        poster_jpg: Path,
    ) -> RenderOutputs:
        work_dir.mkdir(parents=True, exist_ok=True)
        out_mp4.parent.mkdir(parents=True, exist_ok=True)
        args, _ = await self.build_command(timeline, resolve, work_dir, out_mp4)
        await self.ffmpeg.run(args, timeout_sec=900)

        await self.ffmpeg.run(
            [
                "-i",
                str(out_mp4),
                "-vf",
                "scale=-2:720",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                str(preview_mp4),
            ]
        )
        poster_at = min(1.0, max(0.0, timeline.durationSec / 2))
        await self.ffmpeg.extract_frame(out_mp4, poster_jpg, poster_at)
        await self.ffmpeg.extract_frame(out_mp4, thumb_jpg, poster_at, width=640)
        probe = await self.ffmpeg.probe(out_mp4)
        return RenderOutputs(
            mp4=out_mp4,
            preview=preview_mp4,
            thumb=thumb_jpg,
            poster=poster_jpg,
            duration_sec=probe.duration_sec,
        )

    async def build_command(
        self, tl: Timeline, resolve: dict[str, Path], work_dir: Path, out_mp4: Path
    ) -> tuple[list[str], str]:
        """Return (ffmpeg args, filter_complex) for the timeline. Exposed for tests."""
        w, h, fps = tl.width, tl.height, int(tl.fps)
        total = tl.durationSec
        inputs: list[str] = []
        filters: list[str] = []

        # ---- video inputs -------------------------------------------------
        for i, clip in enumerate(tl.video):
            src = resolve[clip.src]
            slot = clip.outSec - clip.inSec
            if clip.kenBurns is not None:
                frames = max(1, int(round(slot * fps)))
                zf, zt = clip.kenBurns.zoomFrom, clip.kenBurns.zoomTo
                inputs += ["-loop", "1", "-t", _fmt(slot), "-i", str(src)]
                filters.append(
                    f"[{i}:v]scale={w * 2}:{h * 2}:force_original_aspect_ratio=increase,"
                    f"crop={w * 2}:{h * 2},"
                    f"zoompan=z='{zf}+({zt}-{zf})*on/{frames}':x='iw/2-(iw/zoom/2)':"
                    f"y='ih/2-(ih/zoom/2)':d={frames}:s={w}x{h}:fps={fps},"
                    f"format=yuv420p,setpts=PTS-STARTPTS,settb=AVTB[v{i}]"
                )
            else:
                inputs += ["-i", str(src)]
                probe = await self.ffmpeg.probe(src)
                available = max(0.0, probe.duration_sec - clip.inSec)
                pad = max(0.0, slot - available)
                chain = (
                    f"[{i}:v]trim=start={_fmt(clip.inSec)}:end={_fmt(clip.outSec)},"
                    f"setpts=PTS-STARTPTS,"
                    f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
                    f"fps={fps},format=yuv420p"
                )
                if pad > 0.001:
                    chain += f",tpad=stop_mode=clone:stop_duration={_fmt(pad + 0.05)}"
                filters.append(chain + f",settb=AVTB[v{i}]")

        # ---- transitions --------------------------------------------------
        cur = "v0"
        cur_len = tl.video[0].outSec - tl.video[0].inSec
        for i in range(1, len(tl.video)):
            prev = tl.video[i - 1]
            clip_len = tl.video[i].outSec - tl.video[i].inSec
            trans = prev.transitionOut
            d = trans.durationSec if trans and trans.type.value != "cut" else 0.0
            d = min(d, cur_len - 0.05, clip_len - 0.05)
            label = f"x{i}"
            if d > 0.01:
                kind = "fadeblack" if trans and trans.type.value == "dip_to_black" else "fade"
                filters.append(
                    f"[{cur}][v{i}]xfade=transition={kind}:duration={_fmt(d)}:"
                    f"offset={_fmt(cur_len - d)}[{label}]"
                )
                cur_len = cur_len + clip_len - d
            else:
                filters.append(f"[{cur}][v{i}]concat=n=2:v=1:a=0,settb=AVTB[{label}]")
                cur_len += clip_len
            cur = label

        # ---- overlays -----------------------------------------------------
        for k, ov in enumerate(tl.overlays or []):
            text_file = work_dir / f"overlay-{k}.txt"
            text_file.write_text(ov.text, encoding="utf-8")
            size = max(16, h // (16 if ov.type.value == "title" else 24))
            y = "h*0.10" if ov.type.value == "title" else "h*0.82"
            filters.append(
                f"[{cur}]drawtext=fontfile='{_esc_filter_path(Path(FONT_PATH))}':"
                f"textfile='{_esc_filter_path(text_file)}':fontsize={size}:fontcolor=white:"
                f"borderw={max(2, size // 12)}:bordercolor=black@0.85:"
                f"x=(w-text_w)/2:y={y}:"
                f"enable='between(t,{_fmt(ov.at)},{_fmt(ov.at + ov.durationSec)})'[o{k}]"
            )
            cur = f"o{k}"

        # ---- subtitles ----------------------------------------------------
        if tl.subtitles.burnIn and tl.subtitles.cues and tl.subtitles.style.value != "none":
            ass = work_dir / "subtitles.ass"
            ass.write_text(
                to_ass(tl.subtitles.cues, width=w, height=h, style=tl.subtitles.style.value),
                encoding="utf-8",
            )
            filters.append(f"[{cur}]subtitles=filename='{_esc_filter_path(ass)}'[subs]")
            cur = "subs"

        filters.append(f"[{cur}]trim=duration={_fmt(total)},setpts=PTS-STARTPTS[vout]")

        # ---- audio --------------------------------------------------------
        n_video = len(tl.video)
        tracks: dict[str, list[str]] = {"voice": [], "sfx": [], "music": []}
        duck_cfg = None
        for j, a in enumerate(tl.audio):
            idx = n_video + j
            inputs += ["-i", str(resolve[a.src])]
            chain = f"[{idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
            if a.loopToSec:
                chain += f",aloop=loop=-1:size={INT32_MAX},atrim=duration={_fmt(a.loopToSec)}"
            if a.gainDb:
                chain += f",volume={_fmt(a.gainDb)}dB"
            delay_ms = int(round(a.at * 1000))
            if delay_ms > 0:
                chain += f",adelay=delays={delay_ms}:all=1"
            chain += f",apad=whole_dur={_fmt(total)},atrim=duration={_fmt(total)}[a{j}]"
            filters.append(chain)
            tracks[a.track.value].append(f"a{j}")
            if a.track.value == "music" and a.duck is not None:
                duck_cfg = a.duck

        def mix(labels: list[str], out: str) -> None:
            if len(labels) == 1:
                filters.append(f"[{labels[0]}]acopy[{out}]")
            else:
                ins = "".join(f"[{lab}]" for lab in labels)
                filters.append(f"{ins}amix=inputs={len(labels)}:normalize=0:duration=first[{out}]")

        final_inputs: list[str] = []
        if tracks["voice"]:
            mix(tracks["voice"], "voice")
            if tracks["music"] and duck_cfg is not None:
                filters.append("[voice]asplit=2[voice_mix][voice_sc]")
                final_inputs.append("voice_mix")
            else:
                final_inputs.append("voice")
        if tracks["sfx"]:
            mix(tracks["sfx"], "sfx")
            final_inputs.append("sfx")
        if tracks["music"]:
            mix(tracks["music"], "music")
            if tracks["voice"] and duck_cfg is not None:
                ratio = max(2.0, min(20.0, -duck_cfg.depthDb))
                filters.append(
                    f"[music][voice_sc]sidechaincompress=threshold=0.02:ratio={_fmt(ratio)}:"
                    f"attack={duck_cfg.attackMs or 120}:"
                    f"release={duck_cfg.releaseMs or 400}[music_d]"
                )
                final_inputs.append("music_d")
            else:
                final_inputs.append("music")

        if not final_inputs:
            inputs += ["-f", "lavfi", "-t", _fmt(total), "-i", "anullsrc=r=48000:cl=stereo"]
            filters.append(f"[{n_video + len(tl.audio)}:a]acopy[mixed]")
        elif len(final_inputs) == 1:
            filters.append(f"[{final_inputs[0]}]acopy[mixed]")
        else:
            ins = "".join(f"[{lab}]" for lab in final_inputs)
            filters.append(
                f"{ins}amix=inputs={len(final_inputs)}:normalize=0:duration=first[mixed]"
            )

        lufs = tl.loudnessLufs if tl.loudnessLufs is not None else -14.0
        filters.append(
            f"[mixed]loudnorm=I={_fmt(lufs)}:TP=-1.5:LRA=11,aresample=48000,"
            f"apad=whole_dur={_fmt(total)},atrim=duration={_fmt(total)},asetpts=PTS-STARTPTS[aout]"
        )

        filter_complex = ";\n".join(filters)
        script = work_dir / "filter_complex.txt"
        script.write_text(filter_complex, encoding="utf-8")

        args = [
            *inputs,
            "-filter_complex_script",
            str(script),
            "-map",
            "[vout]",
            "-map",
            "[aout]",
            "-c:v",
            "libx264",
            "-preset",
            self.preset,
            "-crf",
            str(self.crf),
            "-pix_fmt",
            "yuv420p",
            "-r",
            str(fps),
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            "-t",
            _fmt(total),
            str(out_mp4),
        ]
        return args, filter_complex
