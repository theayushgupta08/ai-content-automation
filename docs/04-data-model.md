# 04 — Data Model

PostgreSQL 16 is the system of record. Prisma (TypeScript) owns migrations; Python workers use
SQLAlchemy models generated from the same schema (checked in CI for drift). All tables carry
`created_at`, `updated_at`; soft delete via `deleted_at` where noted. Row-level tenancy is
enforced by `workspace_id` on every tenant table plus Postgres RLS policies as defence in depth.

## 1. Entity overview

```
User ──< WorkspaceMember >── Workspace ──< Subscription ── Plan
                                 │
                                 ├──< CreditLedger (append-only)
                                 ├──< CreditHold
                                 ├──< Character ──< CharacterSheet
                                 ├──< Voice
                                 ├──< Project ──< VideoJob ──< Scene ──< Artifact
                                 │                  ├──< JobEvent
                                 │                  ├──< ProviderCall
                                 │                  └──< ModerationResult
                                 ├──< ApiKey
                                 └──< WebhookEndpoint ──< WebhookDelivery
StylePreset (global)   ·   ProviderConfig (global)   ·   PromptTemplate (global, versioned)
```

## 2. Tables

### Identity and tenancy

```sql
create table users (
  id            uuid primary key default gen_random_uuid(),
  external_id   text unique not null,          -- Clerk user id
  email         citext unique not null,
  name          text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table workspaces (
  id            uuid primary key default gen_random_uuid(),
  slug          citext unique not null,
  name          text not null,
  owner_id      uuid not null references users(id),
  region        text not null default 'us',         -- data residency
  settings      jsonb not null default '{}',        -- default style, aspect, language, brand kit
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create type member_role as enum ('owner','admin','editor','viewer');
create table workspace_members (
  workspace_id  uuid references workspaces(id) on delete cascade,
  user_id       uuid references users(id) on delete cascade,
  role          member_role not null default 'editor',
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
```

### Billing

```sql
create table plans (
  id                  text primary key,          -- 'free','starter','creator','pro','studio','enterprise'
  name                text not null,
  stripe_price_month  text,
  stripe_price_year   text,
  credits_per_period  int not null,
  max_duration_sec    int not null,
  max_concurrency     int not null,
  max_resolution      text not null,             -- '720p','1080p','4k'
  features            jsonb not null,            -- {premiumVideo, directorMode, api, voiceClone, seats, watermark}
  rollover_months     int not null default 0,
  active              boolean not null default true
);

create type sub_status as enum ('trialing','active','past_due','canceled','unpaid','paused');
create table subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references workspaces(id),
  plan_id                 text not null references plans(id),
  stripe_customer_id      text not null,
  stripe_subscription_id  text unique,
  status                  sub_status not null,
  current_period_start    timestamptz not null,
  current_period_end      timestamptz not null,
  cancel_at_period_end    boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create unique index on subscriptions(workspace_id) where status in ('trialing','active','past_due');

-- Append-only ledger. Balance = sum(amount). Never update or delete rows.
create type ledger_reason as enum (
  'subscription_grant','rollover','pack_purchase','job_hold','job_settle','job_refund',
  'regen_charge','manual_adjustment','expiry','promo'
);
create table credit_ledger (
  id             bigserial primary key,
  workspace_id   uuid not null references workspaces(id),
  amount         int not null,                 -- positive = grant, negative = charge
  reason         ledger_reason not null,
  job_id         uuid,                         -- nullable FK to video_jobs
  hold_id        uuid,
  expires_at     timestamptz,                  -- for grants with expiry
  metadata       jsonb not null default '{}',
  idempotency_key text unique,                 -- e.g. stripe event id, job_id+stage
  created_at     timestamptz not null default now()
);
create index on credit_ledger(workspace_id, created_at desc);

create type hold_status as enum ('active','settled','released');
create table credit_holds (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  job_id         uuid not null,
  estimated      int not null,
  spent          int not null default 0,        -- updated per stage
  status         hold_status not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Materialised balance for fast reads; recomputed by trigger on ledger insert.
create table credit_balances (
  workspace_id   uuid primary key references workspaces(id),
  available      int not null default 0,        -- ledger sum − active holds
  held           int not null default 0,
  updated_at     timestamptz not null default now()
);
```

### Characters and voices

```sql
create type character_status as enum ('draft','generating','locked','failed');
create table characters (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id),
  name               text not null,
  description        text not null,               -- user free text
  visual_descriptor  text,                        -- LLM-canonicalised
  voice_id           uuid,                        -- references voices(id)
  reference_image_key text,                       -- user upload, requires consent record
  consent_id         uuid,                        -- references consents(id)
  status             character_status not null default 'draft',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create table character_sheets (
  id             uuid primary key default gen_random_uuid(),
  character_id   uuid not null references characters(id) on delete cascade,
  style_preset   text not null,
  version        int not null,
  storage_prefix text not null,                  -- characters/{id}/sheet/v{n}/
  seed           bigint not null,
  provider       text not null,
  model_version  text not null,
  embedding      vector(512),                    -- pgvector; CLIP/ArcFace
  qa_score       real,
  created_at     timestamptz not null default now(),
  unique (character_id, style_preset, version)
);

create type voice_kind as enum ('stock','cloned');
create table voices (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid references workspaces(id),  -- null = global stock voice
  kind           voice_kind not null,
  name           text not null,
  provider       text not null,
  provider_voice_id text not null,
  language_codes text[] not null,
  consent_id     uuid,
  sample_key     text,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create table consents (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  user_id        uuid not null references users(id),
  kind           text not null,                   -- 'likeness','voice'
  subject_name   text not null,
  attestation    jsonb not null,                  -- checkbox text, ip, user agent, timestamp
  evidence_key   text,                            -- spoken consent phrase recording
  created_at     timestamptz not null default now()
);
```

### Jobs and pipeline state

```sql
create table projects (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  name           text not null,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create type job_status as enum (
  'queued','running','awaiting_approval','completed','failed','canceled','needs_review'
);
create type job_stage as enum (
  'moderation','story','characters','keyframes','video','audio','edit','final'
);
create table video_jobs (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id),
  project_id         uuid references projects(id),
  created_by         uuid not null references users(id),
  status             job_status not null default 'queued',
  current_stage      job_stage,
  input              jsonb not null,               -- normalised stage-1 input
  options            jsonb not null,               -- style, aspect, tier, mode, language
  pipeline_version   text not null,
  temporal_workflow_id text unique,
  title              text,
  duration_sec       real,
  estimated_credits  int not null,
  actual_credits     int,
  actual_cost_usd    numeric(10,4),                -- provider cost, internal
  output             jsonb,                        -- {mp4Key, previewKey, srtKey, vttKey, thumbKey, posterKey}
  flags              text[] not null default '{}', -- lowConsistency, staticFallback, budgetDowngrade
  error              jsonb,                        -- {code, message, stage, retryable}
  parent_job_id      uuid,                         -- for regenerations
  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index on video_jobs(workspace_id, created_at desc);
create index on video_jobs(status) where status in ('queued','running','awaiting_approval');

create type scene_status as enum ('pending','keyframes','video','audio','done','failed','fallback');
create table scenes (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references video_jobs(id) on delete cascade,
  idx            int not null,
  status         scene_status not null default 'pending',
  plan           jsonb not null,                   -- the scene object from scenes.json
  planned_sec    real not null,
  actual_sec     real,
  consistency    real,
  attempts       jsonb not null default '{}',      -- {keyframes: 2, video: 1}
  provider_video text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (job_id, idx)
);

create type artifact_kind as enum (
  'input','premise','script','scenes','character_sheet','keyframe','clip_raw','clip',
  'dialogue','narration','music','sfx','timeline','subtitles','final_mp4','preview_mp4','thumbnail','poster','log'
);
create table artifacts (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid references video_jobs(id) on delete cascade,
  scene_id       uuid references scenes(id) on delete cascade,
  character_id   uuid references characters(id) on delete cascade,
  kind           artifact_kind not null,
  version        int not null default 1,
  storage_key    text not null,
  content_type   text not null,
  bytes          bigint,
  duration_sec   real,
  width          int, height int,
  checksum       text,
  metadata       jsonb not null default '{}',      -- prompt, seed, provider, model, params, qa scores
  created_at     timestamptz not null default now()
);
create index on artifacts(job_id, kind);

create table job_events (
  id             bigserial primary key,
  job_id         uuid not null references video_jobs(id) on delete cascade,
  seq            int not null,
  type           text not null,                    -- stage.started, stage.completed, scene.progress, preview.ready, job.completed ...
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  unique (job_id, seq)
);

create table provider_calls (
  id             bigserial primary key,
  job_id         uuid references video_jobs(id) on delete set null,
  scene_id       uuid,
  workspace_id   uuid not null,
  stage          job_stage not null,
  provider       text not null,
  model          text not null,
  operation      text not null,                    -- 'llm.complete','image.generate','video.i2v','tts','music','sfx'
  request_hash   text,
  status         text not null,                    -- ok, error, timeout, rate_limited
  latency_ms     int,
  cost_usd       numeric(10,5),
  units          jsonb,                            -- {inputTokens, outputTokens} | {seconds} | {characters}
  error          text,
  created_at     timestamptz not null default now()
);
create index on provider_calls(created_at);
create index on provider_calls(workspace_id, created_at desc);

create table moderation_results (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid references video_jobs(id) on delete cascade,
  artifact_id    uuid references artifacts(id) on delete cascade,
  gate           text not null,                    -- 'input','script','image','clip'
  verdict        text not null,                    -- pass, flag, block
  categories     jsonb not null,
  provider       text not null,
  created_at     timestamptz not null default now()
);
```

### Platform configuration and integrations

```sql
create table style_presets (
  id             text primary key,                 -- 'cinematic_realism','pixar_3d','anime',...
  name           text not null,
  prompt_prefix  text not null,
  negative_prompt text not null,
  image_provider_pref text[] not null,
  video_provider_pref text[] not null,
  narrator_voice_id uuid,
  subtitle_style text not null,
  lut            text,                             -- optional colour grade
  min_plan       text not null references plans(id),
  active         boolean not null default true
);

create table prompt_templates (
  id             text not null,                    -- 'story.expand_premise'
  version        int not null,
  model          text not null,
  template       text not null,
  schema         jsonb,                            -- expected output JSON schema
  active         boolean not null default false,
  created_at     timestamptz not null default now(),
  primary key (id, version)
);

create table api_keys (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  name           text not null,
  prefix         text not null,                    -- 'avg_live_abc1' shown to user
  hash           text not null,                    -- argon2 of full key
  scopes         text[] not null,
  last_used_at   timestamptz,
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz
);

create table webhook_endpoints (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  url            text not null,
  secret         text not null,                    -- for HMAC signature
  events         text[] not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create table webhook_deliveries (
  id             uuid primary key default gen_random_uuid(),
  endpoint_id    uuid not null references webhook_endpoints(id) on delete cascade,
  event_type     text not null,
  payload        jsonb not null,
  attempts       int not null default 0,
  last_status    int,
  next_retry_at  timestamptz,
  delivered_at   timestamptz,
  created_at     timestamptz not null default now()
);
```

## 3. Invariants and enforcement

| Invariant                             | Enforcement                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Credit balance never negative         | `credit_balances.available >= 0` check; holds placed in a serialisable transaction with `select ... for update` on `credit_balances` |
| Ledger is append-only                 | No UPDATE/DELETE grants for the app role; trigger raises on attempt                                                                  |
| One active subscription per workspace | Partial unique index                                                                                                                 |
| Job cost settles exactly once         | `idempotency_key = job_id                                                                                                            |     | ':settle'` on ledger row |
| Artifact paths are tenant-scoped      | Storage key must start with `workspaces/{workspace_id}/`; validated in API and IAM policy conditions                                 |
| Cross-tenant reads impossible         | RLS: `using (workspace_id = current_setting('app.workspace_id')::uuid)` on all tenant tables; API sets the GUC per request           |

## 4. Retention

| Data                                             | Retention                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Final outputs, character sheets                  | Lifetime of the workspace; 30 days after cancellation, then deleted |
| Intermediate artifacts (raw clips, per-line WAV) | 30 days (S3 lifecycle)                                              |
| `job_events`, `provider_calls`                   | 13 months in Postgres, then archived to Parquet in S3               |
| Moderation results                               | 2 years (abuse investigations)                                      |
| Deleted characters with likeness consent         | Hard delete within 30 days of request                               |
