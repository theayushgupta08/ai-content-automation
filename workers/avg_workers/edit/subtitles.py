"""SRT / WebVTT sidecars and an ASS file for burn-in, from timeline subtitle cues."""

from __future__ import annotations

from avg_workers.contracts import SubtitleCue

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_NAME = "DejaVu Sans"


def _ts_srt(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _ts_vtt(sec: float) -> str:
    return _ts_srt(sec).replace(",", ".")


def _ts_ass(sec: float) -> str:
    cs = int(round(sec * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6_000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def to_srt(cues: list[SubtitleCue]) -> str:
    out: list[str] = []
    for i, c in enumerate(cues, start=1):
        out.append(f"{i}\n{_ts_srt(c.startSec)} --> {_ts_srt(c.endSec)}\n{c.text}\n")
    return "\n".join(out) + ("\n" if out else "")


def to_vtt(cues: list[SubtitleCue]) -> str:
    out = ["WEBVTT", ""]
    for c in cues:
        out.append(f"{_ts_vtt(c.startSec)} --> {_ts_vtt(c.endSec)}\n{c.text}\n")
    return "\n".join(out)


def to_ass(cues: list[SubtitleCue], *, width: int, height: int, style: str) -> str:
    if style == "lower_third":
        fontsize = max(18, height // 26)
        margin_v = int(height * 0.06)
    else:  # bold_center
        fontsize = max(20, height // 20)
        margin_v = int(height * 0.22)
    outline = max(2, fontsize // 12)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{FONT_NAME},{fontsize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,{outline},0,2,{int(width * 0.06)},{int(width * 0.06)},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for c in cues:
        text = c.text.replace("{", "(").replace("}", ")").replace("\n", "\\N")
        lines.append(
            f"Dialogue: 0,{_ts_ass(c.startSec)},{_ts_ass(c.endSec)},Default,,0,0,0,,{text}"
        )
    return header + "\n".join(lines) + ("\n" if lines else "")
