# 12 — Repository Layout

A single monorepo keeps the JSON contracts, SDKs, and pipeline code in lockstep. Turborepo +
pnpm for the TypeScript side, uv workspaces for Python.

```
ai-content-automation/
├─ apps/
│  ├─ web/                     # Next.js 15 dashboard + marketing
│  │  ├─ app/(marketing)/      # public pages
│  │  ├─ app/(app)/            # authenticated dashboard: jobs, characters, billing, settings
│  │  ├─ components/           # shadcn/ui based
│  │  └─ lib/api.ts            # generated SDK client
│  └─ api/                     # NestJS control plane
│     ├─ src/modules/
│     │  ├─ auth/  workspaces/  billing/  credits/  characters/  voices/
│     │  ├─ jobs/              # controllers, estimate service, Temporal client, SSE
│     │  ├─ moderation/  webhooks/  uploads/  internal/
│     ├─ prisma/schema.prisma
│     └─ test/                 # e2e with testcontainers
├─ workers/                    # Python 3.12, one package, multiple entrypoints
│  ├─ avg_workers/
│  │  ├─ workflows/            # VideoJobWorkflow, SceneWorkflow (Temporal)
│  │  ├─ activities/
│  │  │  ├─ story/             # expand_premise, write_script, critique, breakdown, time_budget
│  │  │  ├─ image/             # character_sheets, keyframes, consistency
│  │  │  ├─ video/             # generate_clip, normalise
│  │  │  ├─ audio/             # tts, music, sfx, loudness
│  │  │  ├─ edit/              # timeline builder, ffmpeg graph, subtitles, render
│  │  │  ├─ qa/                # image/clip/final checks
│  │  │  └─ billing/           # hold, spend, settle (calls api internal endpoints)
│  │  ├─ providers/            # adapters: anthropic, flux, kling, runway, luma, elevenlabs, mock, selfhosted
│  │  ├─ router/               # provider selection, circuit breakers, budgets
│  │  ├─ storage/              # S3 client, key builder, signed URLs
│  │  └─ telemetry/            # OTel setup, cost recording
│  ├─ tests/                   # unit + integration (Temporal test env, mock providers)
│  └─ pyproject.toml
├─ packages/
│  ├─ contracts/               # JSON Schemas (script, scenes, timeline, events) → generates Zod + Pydantic
│  ├─ prompts/                 # versioned prompt templates + eval fixtures + rubric
│  ├─ sdk-ts/                  # generated TypeScript SDK
│  ├─ sdk-python/              # generated Python SDK
│  ├─ style-presets/           # preset definitions, LUTs, subtitle ASS templates, fonts
│  └─ ui/                      # shared React components (optional)
├─ infra/
│  ├─ terraform/               # modules + envs/{dev,staging,prod}
│  ├─ k8s/                     # Helm charts / Kustomize for each service, KEDA scalers, Karpenter pools
│  └─ argocd/                  # app-of-apps
├─ docker/
│  ├─ api.Dockerfile  web.Dockerfile  worker.Dockerfile  ffmpeg.Dockerfile  mock-providers.Dockerfile
├─ docs/                       # this plan, ADRs (docs/adr/), runbooks (docs/runbooks/)
├─ scripts/                    # make demo, seed, load test, cost report
├─ docker-compose.yml
├─ turbo.json  pnpm-workspace.yaml  Makefile  .github/workflows/
└─ README.md
```

## Tooling and conventions

| Area           | Choice                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------- |
| TypeScript     | strict mode, ESLint + Prettier, Vitest, Zod for runtime validation                             |
| Python         | uv, ruff, mypy strict, pytest, Pydantic v2                                                     |
| Contracts      | JSON Schema is canonical; `pnpm gen:contracts` regenerates Zod and Pydantic; CI fails on drift |
| Commits        | Conventional Commits; changesets for SDK versioning                                            |
| ADRs           | `docs/adr/NNNN-title.md` for every decision in `README.md`'s decision table                    |
| Feature flags  | PostHog flags or Unleash; used for style presets, providers, director mode                     |
| Secrets in dev | `.env.example` committed; real values via `direnv` + 1Password CLI                             |

## First implementation steps (Phase 0 checklist)

1. `pnpm init` monorepo, Turborepo, `apps/api` NestJS skeleton with health endpoint, `apps/web`
   Next.js skeleton with Clerk sign-in.
2. `docker-compose.yml` with Postgres, Redis, Temporal dev server, MinIO, Mailpit.
3. `packages/contracts` with the three schemas from 03 and the generator scripts.
4. `workers/` with `VideoJobWorkflow` calling stub activities that copy fixture assets, and an
   FFmpeg render activity that produces a real MP4 from them.
5. `apps/api` job module: `POST /jobs` → start workflow; `GET /jobs/:id/events` SSE from
   `job_events`.
6. `make demo` → job created via API, watched over SSE, MP4 downloadable from MinIO.
7. Terraform `envs/dev`, ArgoCD app-of-apps, first deploy of the stub pipeline to dev.

From here the roadmap in 11 replaces stubs with real providers stage by stage.
