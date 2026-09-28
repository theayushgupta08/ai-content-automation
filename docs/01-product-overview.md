# 01 — Product Overview

## 1. Vision

**"Type one line, get a finished video."**

A creator subscribes, types a one-line story idea, optionally defines the characters, and
receives a fully produced short film: script, consistent characters, animated scenes,
voiceover, music, sound effects, subtitles, and a platform-ready MP4. No editing skills, no
prompt engineering, no stitching together six different AI tools.

The product competes on **end-to-end automation and consistency**, not on any single model.
Individual AI models are commodities; the orchestration, quality gates, and character
consistency are the moat.

## 2. Target users

| Persona | Need | Typical output | Volume |
|---------|------|----------------|--------|
| **Faceless-channel creator** (YouTube Shorts, TikTok, Reels) | Daily story content without filming | 30–90 s vertical, subtitled | 5–30 videos/week |
| **Kids/edu storyteller** | Bedtime stories, moral tales, nursery rhymes | 1–3 min, bright style, gentle narration | 3–10 videos/week |
| **Indie marketer / small brand** | Product story ads, explainer narratives | 15–60 s, brand character, CTA end-card | 2–10 videos/week |
| **Author / worldbuilder** | Trailers and teasers for books, comics, games | 30–120 s cinematic, recurring cast | 1–4 videos/month |
| **Agency / studio (later)** | White-label bulk production for clients | Mixed, API-driven | 100+ videos/month |

Launch focus: personas 1 and 2. They have the clearest pain, the highest volume, and the
lowest quality bar for "good enough to publish".

## 3. Core user journey

```
Sign up ─► Pick plan (Stripe Checkout) ─► Dashboard
   │
   ├─► New Video
   │      1. Story idea (one line, 10–300 chars)
   │      2. Optional: pick/create characters (name, description, reference image, voice)
   │      3. Optional: style preset (Pixar-like 3D, anime, cinematic realism, watercolor, comic)
   │      4. Optional: format (9:16 / 16:9 / 1:1), target length, language, tone
   │      5. Cost preview in credits ─► Confirm
   │
   ├─► Progress screen (live per-stage status, previews as they land)
   │      ─ Script ready (editable, "regenerate")
   │      ─ Characters ready (approve / swap)   ← optional human-in-the-loop checkpoint
   │      ─ Scenes rendering (thumbnail grid)
   │      ─ Audio mixed
   │      ─ Final render
   │
   └─► Result page
          ─ Player, download MP4, subtitles (.srt/.vtt), thumbnail, script
          ─ Regenerate a single scene (partial credit)
          ─ Publish to YouTube / TikTok (OAuth, Phase 3)
          ─ Share link
```

Two modes:

* **Auto mode (default):** zero interaction after clicking Generate. All checkpoints auto-approve.
* **Director mode:** pause after script and after character sheets for user approval. Pauses
  are free; credits are charged per stage as it runs.

## 4. Feature scope

### MVP (Phase 1, launch)

* Email + Google auth, single-user workspaces
* Story → finished MP4 pipeline, auto mode
* Up to 2 user-defined characters per video, text description only
* 3 visual style presets, 9:16 and 16:9
* 30–90 second videos
* English voiceover, 6 stock voices, burned-in subtitles
* Royalty-free background music from a curated library, AI SFX
* Credit-based plans (Starter, Creator), Stripe Checkout + Customer Portal
* Download MP4, SRT, thumbnail, script
* Public status page, basic email notifications

### Phase 2 (growth)

* Director mode (script and character approval checkpoints)
* Character library with reference images and locked visual identity (reusable across videos)
* Voice cloning (with consent flow), 20+ languages
* Per-scene regeneration, script editing in-place
* Longer videos (up to 3 min), 1:1 format, 8 style presets
* Team workspaces, roles, shared character library
* Public API + webhooks (Pro plan)

### Phase 3 (scale)

* Direct publishing (YouTube, TikTok, Instagram) with scheduled posts
* Series mode: recurring cast, episode continuity, brand kits
* Template marketplace, custom style training (LoRA per workspace)
* Agency white-label, usage-based enterprise contracts
* Self-hosted video model tier to protect margins

### Explicitly out of scope

* General-purpose video editor UI (timeline editing)
* Real-person likeness generation without verified consent
* Live/real-time generation

## 5. Plans and pricing (launch proposal)

Pricing is credit-based so the product can absorb wildly different per-second costs across
providers and styles. One **credit ≈ one second of finished video at standard quality**.
See [07-billing-and-credits.md](07-billing-and-credits.md) for the ledger mechanics and
[10-unit-economics.md](10-unit-economics.md) for the margin math behind these numbers.

| Plan | Price | Credits / month | ≈ Videos (60 s) | Max length | Resolution | Concurrency | Extras |
|------|-------|-----------------|-----------------|------------|------------|-------------|--------|
| **Free trial** | $0 | 60 (one-time) | 1 | 30 s | 720p, watermark | 1 | No download of source assets |
| **Starter** | $29/mo | 600 | ~10 | 60 s | 1080p | 1 | Standard voices |
| **Creator** | $79/mo | 2,000 | ~33 | 90 s | 1080p | 2 | Premium video model, character library, director mode |
| **Pro** | $199/mo | 6,000 | ~100 | 180 s | 1080p / 4K upscale | 4 | API, voice cloning, teams (3 seats), priority queue |
| **Studio** | $499/mo | 18,000 | ~300 | 180 s | 4K | 10 | 10 seats, white-label, SLA, dedicated support |
| **Enterprise** | Custom | Custom | — | Custom | 4K | Custom | Self-hosted models, SSO/SAML, DPA, invoicing |

Overage: buy credit packs (e.g. 500 credits for $25) that never expire while subscribed.
Annual billing: 2 months free. Unused monthly credits roll over one month on Creator and up.

Credit multipliers (applied at cost-preview time, visible to the user):

| Option | Multiplier |
|--------|-----------|
| Standard video model (e.g. self-hosted Wan / Kling Standard) | 1.0× |
| Premium video model (Runway Gen-4, Kling Pro, Veo) | 2.0× |
| 4K upscale | +0.5× |
| Voice clone | +0.2× |
| Regenerate single scene | charged only for that scene's seconds |

## 6. Success metrics

| Metric | Target at 6 months post-launch |
|--------|-------------------------------|
| Activation (trial user completes first video) | ≥ 60 % |
| Trial → paid conversion | ≥ 8 % |
| Pipeline success rate (job reaches final MP4 without manual intervention) | ≥ 97 % |
| P50 / P95 wall-clock for a 60 s video | 6 min / 15 min |
| Gross margin per credit (blended) | ≥ 65 % |
| Monthly churn (paid) | ≤ 6 % |
| "Published without edits" (self-reported) | ≥ 50 % |
| Support tickets per 100 videos | ≤ 2 |

## 7. Principles that shape the design

1. **Every stage is resumable and independently retryable.** A failure in scene 7's video
   generation must never throw away the script, characters, or scenes 1–6.
2. **Character consistency is a first-class artifact,** not a prompt trick. Reference sheets
   are generated once, stored, and injected into every image and video call.
3. **Provider-agnostic.** Every AI call goes through an adapter with a common contract so we can
   route by cost, quality, or availability, and swap providers without touching the pipeline.
4. **Cost is visible before, during, and after.** Users see a credit estimate before confirming;
   the system records actual provider cost per stage for margin tracking.
5. **Deterministic where possible.** Seeds, prompts, model versions, and parameters are stored
   with every artifact so any output can be reproduced or explained.
6. **Safety by default.** Prompt and image moderation at input and at each generation boundary;
   no real-person likeness without a consent record.
