# 08 — Security & Compliance

## 1. Authentication and authorisation

| Concern            | Approach                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User auth          | Clerk: email + password (Argon2), Google/Apple OAuth, magic links, optional TOTP MFA. SAML/OIDC SSO for Enterprise.                                                                |
| Session            | Short-lived JWT (5 min) + refresh; verified in NestJS guard against Clerk JWKS                                                                                                     |
| API keys           | `avg_live_` / `avg_test_` prefix, 32 random bytes, stored as Argon2 hash; scopes (`jobs:write`, `jobs:read`, `characters:*`); rotate and revoke from dashboard; last-used tracking |
| Authorisation      | Role per workspace (owner/admin/editor/viewer) enforced by a CASL policy layer in the API; every query scoped by `workspace_id`; Postgres RLS as second layer                      |
| Internal endpoints | Separate listener, mTLS within cluster, Okta/Google-group protected via oauth2-proxy for humans, all actions audited                                                               |

## 2. Tenant isolation

- Every tenant table carries `workspace_id`; RLS policies use a per-request GUC set by the
  API from the verified token.
- Object storage keys are prefixed `workspaces/{workspace_id}/`; presigned URLs are generated
  only after an authorisation check; IAM policies for workers allow only paths for the job's
  workspace (passed as session tags).
- Temporal workflow IDs embed the workspace id; signals validate that the caller owns the job.

## 3. Secrets and keys

- AWS Secrets Manager (or Vault) → injected as env vars via External Secrets Operator; never
  in images or repo. `gitleaks` in CI.
- Provider API keys are per environment and rotated quarterly; usage per key monitored for
  anomalies.
- KMS-encrypted S3 (SSE-KMS) and RDS; TLS 1.2+ everywhere; HSTS.

## 4. Input handling and upload safety

- All uploads go to a quarantine bucket via presigned PUT with content-type and size limits
  (images ≤ 20 MB, audio ≤ 50 MB); ClamAV scan + image re-encode (strip EXIF, defeat
  polyglots) before promotion to the media bucket.
- FFmpeg and image decoders run in sandboxed containers (distroless, non-root, read-only FS,
  seccomp, no network) with CPU/memory/time limits; inputs are re-muxed before processing.
- Prompt injection: LLM prompts place user text in clearly delimited data sections; output
  is schema-validated; the model never has tool access beyond structured output.

## 5. Content safety

Layered moderation, every result logged in `moderation_results`:

| Gate          | Where                                      | Tooling                                                                    | Action                                          |
| ------------- | ------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------- |
| A. Input text | Job creation                               | LLM classifier + provider moderation API                                   | Block (`CONTENT_BLOCKED`) or flag               |
| B. Script     | After story stage                          | Same                                                                       | Block and refund, or flag                       |
| C. Images     | Every keyframe/sheet                       | NSFW classifier (open-source) + provider safety signals                    | Regenerate with sanitised prompt; block after 2 |
| D. Clips      | Sampled frames                             | Same as C                                                                  | Regenerate / fallback                           |
| E. Audio      | TTS text already covered by B              | —                                                                          | —                                               |
| F. Likeness   | Character reference uploads, voice samples | Consent record required; face-match against known public figures (Phase 2) | `CONSENT_REQUIRED`                              |

Policy: no sexual content involving minors (zero tolerance, report per legal obligations),
no non-consensual real-person likeness, no hate/extremist content, no instructions for
serious harm. Violence and mature themes are allowed within platform ToS but automatically
flag for the "kids/edu" style presets. Flagged jobs are visible in an internal review queue;
repeated blocks lead to account suspension.

Watermarking: trial outputs carry a visible watermark; all outputs embed C2PA content
credentials (Phase 2) and an invisible watermark to identify AI-generated media.

## 6. Intellectual property and licensing

- Every AI provider used must permit commercial use of outputs by our customers; keep a
  register of provider terms and model licences (Wan, SDXL, Flux dev vs pro, etc.), reviewed
  at each provider change.
- Music and SFX: only generated tracks with commercial licences or library assets with
  documented licences; store the licence reference with the artifact.
- Fonts for subtitles: OFL or licensed.
- Users own their outputs per ToS; we retain a licence to process and display within the
  service. Opt-in only for using outputs in marketing or model fine-tuning.

## 7. Privacy and data protection

| Topic          | Approach                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regulations    | GDPR, UK GDPR, CCPA/CPRA; COPPA-conscious (service is 18+, kids content is _made for_ kids not _by_ kids)                                                |
| Data map       | Personal data: account info, payment (Stripe holds card data), uploaded likeness/voice (biometric-adjacent → explicit consent, purpose-limited), prompts |
| DSARs          | Export (JSON + media zip) and delete endpoints in the dashboard; hard delete within 30 days including S3 versions and provider-side clones               |
| Sub-processors | Published list (Clerk, Stripe, AWS, Cloudflare, Anthropic, ElevenLabs, video providers…); DPAs with each; customer DPA available                         |
| Residency      | US default; EU region (data + processing) in Phase 3                                                                                                     |
| Retention      | See 04 §4                                                                                                                                                |
| Analytics      | PostHog self-hosted or EU cloud; no third-party ad pixels on the app                                                                                     |

## 8. Compliance roadmap

| Milestone                                          | Timing                  |
| -------------------------------------------------- | ----------------------- |
| Security policies, access reviews, vendor register | Before launch           |
| Pen test (external)                                | Pre-launch and annually |
| SOC 2 Type I                                       | Month 6                 |
| SOC 2 Type II                                      | Month 12–15             |
| ISO 27001 (if Enterprise demand)                   | Year 2                  |

## 9. Application security checklist

- OWASP ASVS level 2 as the baseline; semgrep + dependency audit in CI; Dependabot.
- CSP, SameSite cookies, CSRF tokens for the dashboard; CORS restricted to app origins.
- Rate limiting at edge (Cloudflare) and app (Redis) layers; account lockout on brute force.
- Audit log for all admin, billing, member, and API-key actions (immutable table + S3 export).
- Signed webhooks (HMAC) with timestamp tolerance; Stripe signature verification.
- Least-privilege IAM per service; no long-lived cloud credentials in pods (IRSA / Workload
  Identity).
- Incident response plan with severity levels, on-call rotation, customer notification within
  72 h for personal data breaches.
