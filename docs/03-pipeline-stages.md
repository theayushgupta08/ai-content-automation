# 03 — Pipeline Stages

This document specifies each of the seven stages: inputs, outputs, model choices, prompt
strategy, quality gates, failure handling, and the contract between stages. All artifacts are
JSON or media files in object storage; the JSON contracts below are the source of truth and
are validated with Pydantic (workers) and Zod (API/web) generated from a shared JSON Schema.

```
1. Story Idea ─► 2. LLM Story Engine ─► 3. Character & Image Gen ─► 4. Video Gen
                                     ─► 5. Audio Engine ─► 6. Automated Editor ─► 7. Final MP4
```

Stages 3, 4, and 5 fan out per scene and run in parallel where dependencies allow.

---

## Stage 1 — Story Idea / Prompt

**Input from the user**

```jsonc
{
  "prompt": "A lonely lighthouse keeper befriends a storm.",   // 10–300 chars
  "characters": [                                              // 0–4, optional
    { "characterId": "chr_...", "role": "protagonist" },        // from library, or inline:
    { "name": "Mara", "description": "60s, weathered, kind eyes, yellow raincoat", "voiceId": "vce_..." }
  ],
  "style": "cinematic_realism",      // preset id
  "aspectRatio": "9:16",
  "targetDurationSec": 60,           // 30–180 by plan
  "language": "en",
  "tone": "heartwarming",            // optional
  "mode": "auto" | "director",
  "videoTier": "standard" | "premium"
}
```

**Processing**

1. Normalise and trim; detect language if not given.
2. **Moderation gate A** — text moderation (Claude Haiku classifier prompt + provider
   moderation API). Blocks: sexual content involving minors, CSAM adjacent, real-person
   defamation, extremist content, self-harm instruction. Flags for review: violence, real
   public figures, brand names.
3. **Cost estimate** — from duration, tier, character count, style; shown to user before
   confirmation, then a credit hold is placed.
4. Create `VideoJob` (status `queued`) and start `VideoJobWorkflow`.

**Output:** `jobs/{id}/input.json` (normalised), credit hold.

---

## Stage 2 — LLM Story Engine

Turns one line into a production-ready script and scene breakdown. This stage is the
"showrunner": every downstream prompt is derived from its output, so it is worth spending
tokens here.

**Model:** Claude Sonnet (structured output via tool use / JSON schema). Haiku for the critique
pass. Temperature 0.8 for creative draft, 0.2 for revision passes.

**Sub-steps (each an idempotent Temporal activity):**

| Step                      | Purpose                                                                                                                               | Output                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 2.1 `expand_premise`      | Logline → premise, protagonist goal, conflict, resolution, 3-act beats, emotional arc                                                 | `premise.json`                      |
| 2.2 `write_script`        | Full script: scenes with location, time, action, dialogue lines with speaker + emotion, narration                                     | `script.json`                       |
| 2.3 `critique_and_revise` | Haiku critic scores clarity, pacing, character consistency, age-appropriateness; Sonnet revises if score < threshold (max 2 loops)    | `script.json` v2                    |
| 2.4 `breakdown_scenes`    | Convert to shot list: for each scene → duration, camera movement, keyframe visual prompt(s), motion prompt, mood, SFX cues, music cue | `scenes.json`                       |
| 2.5 `time_budget`         | Fit total to target duration: reading speed for dialogue (≈ 2.5 words/s), min 3 s and max 8 s per clip (provider limits), pad/trim    | `scenes.json` with locked durations |

**Scene contract (`scenes.json`)**

```jsonc
{
  "version": 1,
  "title": "The Keeper and the Storm",
  "logline": "...",
  "style": { "preset": "cinematic_realism", "palette": ["#0b1d2a", "#f2c14e"], "negative": "text, watermark, extra fingers" },
  "characters": [{ "id": "chr_1", "name": "Mara", "visualDescriptor": "...", "voiceId": "vce_..." }],
  "scenes": [
    {
      "index": 0,
      "durationSec": 5.5,
      "location": "Lighthouse gallery at dusk",
      "characters": ["chr_1"],
      "keyframes": [
        { "position": "start", "prompt": "Mara, a weathered woman in a yellow raincoat, grips the railing of a lighthouse gallery at dusk, storm clouds gathering, cinematic, 35mm, warm rim light" },
        { "position": "end",   "prompt": "..." }
      ],
      "motion": { "camera": "slow push-in", "subject": "hair and coat whipping in wind", "intensity": 0.6 },
      "dialogue": [{ "speaker": "chr_1", "text": "You again.", "emotion": "wry", "startOffsetSec": 1.0 }],
      "narration": { "text": "Every autumn the storm returned.", "startOffsetSec": 0.2 },
      "sfx": [{ "cue": "distant thunder", "atSec": 0.5, "gainDb": -18 }],
      "music": { "cue": "intro", "energy": 0.3 },
      "transitionOut": "cut" | "crossfade" | "dip_to_black"
    }
  ],
  "music": { "mood": "melancholic, hopeful", "bpm": 80, "instruments": "piano, strings" },
  "subtitleStyle": "bold_center"
}
```

**Quality gates**

- Schema validation (hard fail → retry with error fed back to the model).
- Every character referenced exists; every scene has ≥ 1 keyframe prompt.
- Total duration within ±10 % of target.
- Dialogue per scene fits its duration at reading speed.
- Moderation gate B on the full script (cheap; catches drift from an innocent premise).

**Failure handling:** 3 retries with exponential backoff, then fail job with `STORY_FAILED`
and full refund. Rate limits are handled by a token-bucket per provider in Redis.

**Prompt management:** prompts live in `packages/prompts/` as versioned templates with
golden-file tests. Each script artifact records `promptVersion` and `model`.

---

## Stage 3 — Character & Image Generator

Goal: visually consistent characters and one or two keyframes per scene that the video model
can animate.

### 3a. Character sheets (once per character per style)

If the character already has a sheet for this style in the library, reuse it. Otherwise:

1. **Descriptor compilation** — Sonnet converts free-text description into a canonical
   "visual descriptor" (age, build, face, hair, skin, outfit, signature props, colours) that
   is injected verbatim into every prompt.
2. **Sheet generation** — generate a 4-view reference sheet (front, three-quarter, profile,
   full body) plus 3 expressions on a neutral background.
   - Primary: **Flux 1.1 Pro / Flux Kontext** (hosted) — strong prompt adherence, supports
     reference-conditioned edits for the extra views.
   - Fallback / self-hosted: **SDXL + IP-Adapter FaceID** or **InstantID** on our GPU pool.
   - If the user uploaded a reference photo: consent flow (see 08), then image-to-image with
     identity preservation.
3. **Embedding** — compute a CLIP / ArcFace embedding of the front view; store it for
   consistency scoring.
4. **QA** — Haiku vision critique: "Does this match the descriptor? Any anatomy errors?" Score
   ≥ 0.8 accepted; else regenerate with adjusted seed (max 3 attempts).
5. Persist `characters/{id}/sheet/v{n}/` and mark the character `locked` (descriptor and seed
   frozen) so future videos reuse it.

### 3b. Scene keyframes (per scene, parallel)

1. Compose prompt: `style prefix + scene.keyframes[i].prompt + character visual descriptors +
composition hints for aspect ratio + negative prompt`.
2. Generate with reference images attached (provider adapter maps to IP-Adapter / reference
   input / Kontext as supported). Fixed seed derived from `hash(job_id, scene_index, position)`
   for reproducibility.
3. Generate **end keyframe** for scenes with strong motion (helps video models that support
   first+last frame conditioning; skipped for providers that don't).
4. **Consistency check** — cosine similarity between detected character face/body embedding
   and the sheet embedding; threshold 0.72 (tuned per style). Fail → regenerate up to 2×
   with stronger reference weight; still failing → accept best-of and flag `lowConsistency`.
5. **Safety check** — image NSFW classifier; hard fail → regenerate with sanitised prompt.
6. Upscale/normalise to target resolution (1080×1920 or 1920×1080) with a fast upscaler if
   the provider output is smaller.

**Output:** `scenes/{i}/keyframe-start.png`, optional `keyframe-end.png`, metadata JSON with
prompt, seed, provider, model version, consistency score.

**Concurrency:** bounded semaphore per provider (e.g. 8 concurrent Flux calls per job, 200
platform-wide) enforced with Temporal activity task-queue rate limits.

---

## Stage 4 — Video Generation Engine

Animates each keyframe into a 3–8 second clip with intended motion and camera work.

**Provider routing**

| Tier                  | Primary                          | Fallbacks                     | Notes                                  |
| --------------------- | -------------------------------- | ----------------------------- | -------------------------------------- |
| Standard              | Kling 2.x Standard               | Luma Ray, self-hosted Wan 2.x | Cheapest acceptable quality            |
| Premium               | Kling Pro / Runway Gen-4         | Veo, Luma Ray 2               | Better motion fidelity, camera control |
| Self-hosted (Phase 3) | Wan 2.x / LTX-Video on L40S/A100 | —                             | Margin protection at scale             |

**Request construction**

- `firstFrame` = keyframe-start, `lastFrame` = keyframe-end when supported.
- Motion prompt = `scene.motion` rendered into provider-specific phrasing (camera terms differ:
  Runway uses camera control parameters; Kling accepts natural-language camera prompts).
- Duration = `scene.durationSec` rounded to the provider's supported buckets (typically 5 s or
  10 s); the editor trims to exact length later.
- Negative prompt from the style preset. Seed stored.

**Execution**

- Submit → poll (adapter normalises polling/webhooks). Temporal activity heartbeats every
  15 s; activity timeout 12 min; retry once on the same provider, then fall to the next.
- On completion download, then **normalise** with FFmpeg: constant frame rate (24 or 30 fps),
  target resolution, `yuv420p`, H.264 intermediate at high bitrate. Store both raw and
  normalised.

**Quality gates (`qa.check_clip`)**

- Duration ≥ requested − 0.5 s.
- Black/frozen-frame detection (FFmpeg `blackdetect`, `freezedetect`).
- Character consistency on 3 sampled frames vs. sheet embedding (threshold lower than for
  keyframes, 0.6).
- Optional Haiku vision spot check for gross artefacts (extra limbs, melting) on premium tier.
- NSFW frame scan.

Fail → regenerate with a new seed (max 2), then fallback provider, then accept best-of with
flag. A single scene never fails the whole job unless every attempt fails, in which case the
editor substitutes a Ken Burns pan over the keyframe so the video still completes (flag
`staticFallback`), and the user is offered a free regen of that scene.

**Cost control:** each clip call checks the remaining job budget in the credit hold; if
exhausted, the router forces the standard tier and records a `budgetDowngrade` event.

---

## Stage 5 — Audio Engine

Runs in parallel with Stage 4 since it depends only on the script.

### 5a. Dialogue and narration (TTS)

- **Provider:** ElevenLabs (Multilingual v2 / v3 with emotion tags) → OpenAI TTS fallback.
- One request per line, with `emotion` mapped to voice settings (stability, style) or v3
  audio tags. Request word-level timestamps (needed for subtitle sync).
- Voice assignment: character `voiceId` (stock or cloned), narrator voice from style preset.
- Text normalisation before TTS (numbers, abbreviations, names with phonetic hints).
- Output 48 kHz WAV; measure actual duration and feed back to the timeline (if a line
  overruns its scene by > 15 %, the editor extends the clip by slow-mo/hold frame up to 1 s,
  else the line is re-synthesised at 1.1× speed).

### 5b. Music

- **Provider:** ElevenLabs Music / Stable Audio (commercial license) with a prompt from
  `scenes.music` (mood, bpm, instruments, duration = total + 3 s tail).
- Fallback: curated royalty-free library (tagged by mood/bpm, embedded, nearest-neighbour
  pick). MVP launches with the library only, generation added in Phase 2.
- Post: loudness-normalise to −23 LUFS, ducking automation is applied in Stage 6.

### 5c. Sound effects

- **Provider:** ElevenLabs SFX for `scene.sfx[].cue`, cached by cue text hash (most cues
  repeat across jobs — "distant thunder" is generated once platform-wide).
- Fallback: Freesound-licensed internal library.

### 5d. Voice cloning (Phase 2)

- Upload 1–3 min sample → consent attestation + spoken consent phrase verification →
  ElevenLabs instant clone → stored `voiceId` scoped to the workspace.

**Output:** per-line WAV + timestamps JSON, `music.wav`, per-scene SFX WAVs.

---

## Stage 6 — Automated Video Editor

Assembles everything into the final deliverable. Deterministic, CPU-only, ~30–60 s.

### 6a. Timeline builder (`edit.build_timeline`)

Produces an Edit Decision List (`timeline.json`) — the single place where timing decisions are
made:

```jsonc
{
  "fps": 30,
  "width": 1080,
  "height": 1920,
  "durationSec": 61.2,
  "video": [
    {
      "src": "scenes/0/clip.mp4",
      "inSec": 0.0,
      "outSec": 5.5,
      "at": 0.0,
      "transform": { "scale": 1.0, "kenBurns": null },
      "transitionOut": { "type": "crossfade", "durationSec": 0.4 },
    },
  ],
  "audio": [
    { "src": "audio/narration-0.wav", "at": 0.2, "gainDb": 0, "track": "voice" },
    { "src": "scenes/0/dialogue-0.wav", "at": 1.0, "track": "voice" },
    { "src": "scenes/0/sfx-0.wav", "at": 0.5, "gainDb": -18, "track": "sfx" },
    {
      "src": "audio/music.wav",
      "at": 0.0,
      "gainDb": -14,
      "track": "music",
      "duck": { "by": "voice", "depthDb": -10, "attackMs": 120, "releaseMs": 400 },
    },
  ],
  "subtitles": { "src": "edit/subtitles.srt", "style": "bold_center", "burnIn": true },
  "overlays": [
    { "type": "title", "text": "The Keeper and the Storm", "at": 0.0, "durationSec": 2.5 },
  ],
  "endCard": { "type": "cta", "text": "Follow for more", "durationSec": 2.0 },
}
```

Rules:

- Clip length is driven by audio: `scene duration = max(planned, voice_end + 0.4 s)`,
  capped by available clip length (extend with hold-frame or 0.9× slow-mo if short).
- Transitions from the scene plan; hard cuts on beats, crossfades on mood changes.
- Aspect ratio handled at generation time; if a clip arrives in the wrong ratio, apply
  smart-crop centred on the detected character, never letterbox.

### 6b. Subtitles

- Built from TTS word timestamps (no ASR needed); fallback to WhisperX alignment if a
  provider returns no timestamps.
- Styles as ASS templates (bold centre karaoke-style for Shorts, lower-third for 16:9).
- Output `.srt` and `.vtt` sidecars always; burn-in controlled by user option (default on for
  9:16, off for 16:9).

### 6c. Render (`edit.render`)

- Single FFmpeg invocation built from the EDL via a filter-graph generator (no intermediate
  files for concat; `xfade` for transitions, `amix`/`sidechaincompress` for ducking,
  `subtitles` filter for ASS burn-in, `loudnorm` two-pass to −14 LUFS integrated for
  social platforms).
- Encode: H.264 High profile, CRF 18, `-preset medium`, `yuv420p`, AAC 192 kbps, `+faststart`.
  Optional HEVC and 4K (upscaled with Real-ESRGAN on the GPU pool) for Pro+.
- Also produce a 720p preview, a poster frame (best keyframe by aesthetic score), and a
  1280×720 thumbnail with title overlay (Remotion template, optional).
- Sandboxed: FFmpeg runs in a distroless container with no network, CPU/memory limits,
  and a 10-minute hard timeout.

### 6d. Final QA (`qa.final_checks`)

- Duration within ±5 % of timeline; audio present on every second; integrated loudness within
  ±1 LU of target; no frame > 2 s black; subtitle track parses; container is valid
  (`ffprobe`).
- Failing checks → re-render once with safe defaults; if still failing → job status
  `needs_review` with the intermediate assets available for support.

---

## Stage 7 — Final MP4 delivery

- Write `output/final.mp4`, `final-720p.mp4`, `thumb.jpg`, `poster.jpg`, `subtitles.srt/.vtt`,
  `script.pdf` (Phase 2).
- Update `VideoJob` → `completed`, settle credits (refund difference between hold and actual
  if any stage was downgraded/skipped).
- Emit `job.completed` event (SSE, email, customer webhook).
- Serve via CDN with signed URLs (24 h) and range support; downloads counted for analytics.
- Phase 3: direct publish to YouTube/TikTok/Instagram with title/description/hashtags
  generated by the story engine.

---

## Cross-cutting pipeline concerns

| Concern                  | Approach                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Idempotency**          | Every activity is keyed by `(job_id, stage, scene_index, attempt)`; re-running writes the same paths and checks for existing artifacts first. |
| **Determinism**          | Seeds derived from job id; model versions pinned per pipeline version; prompts versioned.                                                     |
| **Partial regeneration** | Regenerating scene _k_ starts a `SceneWorkflow` alone, then a new `edit.render`; costs only that scene's credits.                             |
| **Pipeline versioning**  | `pipelineVersion` on the job; Temporal workflow versioning (`patched()`) for in-flight jobs.                                                  |
| **Caching**              | Character sheets per (character, style); SFX per cue; music library embeddings; LLM prompt caching for the style/system prefix.               |
| **Budget enforcement**   | Each activity reports actual cost; workflow aborts new premium calls once 90 % of the hold is spent and downgrades tier.                      |
| **Provider health**      | Circuit breaker per provider in Redis (open after 5 failures / 60 s); router skips open providers.                                            |
| **Observability**        | One OpenTelemetry trace per job; span per activity with provider, model, cost, duration attributes.                                           |
