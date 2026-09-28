"""Pydantic models generated from packages/contracts/schemas.

The ``generated`` subpackage is produced by ``pnpm gen:contracts``; never edit it by hand.
This module re-exports the top-level contract models under stable names.
"""

from avg_workers.contracts.generated.job_event_schema import JobEvent, Stage
from avg_workers.contracts.generated.job_event_schema import Payload as JobEventPayload
from avg_workers.contracts.generated.job_event_schema import Type as JobEventType
from avg_workers.contracts.generated.job_input_schema import (
    AspectRatio,
    JobInput,
    JobOptions,
    Mode,
    VideoTier,
)
from avg_workers.contracts.generated.scenes_schema import (
    Keyframe,
    Motion,
    Scene,
    ScenePlan,
    SfxCue,
    TimedLine,
    TransitionOut,
)
from avg_workers.contracts.generated.script_schema import (
    DialogueLine,
    Script,
    ScriptCharacter,
    ScriptScene,
)
from avg_workers.contracts.generated.timeline_schema import (
    AudioClip,
    Overlay,
    SubtitleCue,
    Subtitles,
    Timeline,
    Transition,
    VideoClip,
)

__all__ = [
    "AspectRatio",
    "AudioClip",
    "DialogueLine",
    "JobEvent",
    "JobEventPayload",
    "JobEventType",
    "JobInput",
    "JobOptions",
    "Keyframe",
    "Mode",
    "Motion",
    "Overlay",
    "Scene",
    "ScenePlan",
    "Script",
    "ScriptCharacter",
    "ScriptScene",
    "SfxCue",
    "Stage",
    "SubtitleCue",
    "Subtitles",
    "TimedLine",
    "Timeline",
    "Transition",
    "TransitionOut",
    "VideoClip",
    "VideoTier",
]
