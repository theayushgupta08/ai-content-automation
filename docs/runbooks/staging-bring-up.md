# Runbook — bringing up staging from zero

Target: the layout in [06 — Infrastructure](../06-infrastructure-and-scaling.md) on one AWS
account, with Temporal Cloud, Clerk and Stripe test mode. Budget about half a day the first
time; every step is idempotent so it can be re-run.

What you end up with:

```
GitHub main ─► release.yml ─► GHCR images ─► deploy/envs/staging/values.yaml (image tag bump)
                                                 │
                                        ArgoCD (in cluster) syncs deploy/helm/avg
                                                 │
   RDS Postgres ── EKS (api, web, workers) ── ElastiCache Redis ── S3 media
                        │
                 Temporal Cloud namespace
```

## 0. Accounts and keys to have ready

| Service   | What you need                                                      | Where it goes                      |
| --------- | ------------------------------------------------------------------ | ---------------------------------- |
| AWS       | An account with admin for bootstrap; `aws` CLI logged in           | Terraform                          |
| Domain    | `staging.example.com` you control (Route 53 or any DNS)            | `terraform.tfvars`, values         |
| Temporal  | A [Temporal Cloud](https://cloud.temporal.io) namespace + API key  | values (`config.temporal`), secret |
| Clerk     | A Clerk application: publishable + secret key                      | GitHub variable, secret            |
| Stripe    | Test-mode secret key, webhook secret, price ids (see 07 — Billing) | secret                             |
| Providers | `ANTHROPIC_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`               | secret                             |
| GitHub    | Repo variables `STAGING_API_URL`, `STAGING_CLERK_PUBLISHABLE_KEY`  | release workflow (web image)       |

Never put any of these in git. The Secrets Manager document created in step 2 is the only
place they live; External Secrets copies it into the cluster.

## 1. Remote state (once per account)

```bash
bash infra/terraform/bootstrap-state.sh us-east-1
```

## 2. Infrastructure

```bash
cd infra/terraform/envs/staging
cp terraform.tfvars.example terraform.tfvars    # set domain, tighten kubernetes_api_allowed_cidrs
terraform init -backend-config=bucket=avg-terraform-state-<account-id>
terraform plan -out=plan.tfplan
terraform apply plan.tfplan                      # ~20 min: VPC, EKS, RDS, Redis, S3, IAM, secret
terraform output -json helm_values               # role ARNs + bucket for the values file
```

Then fill the provider and vendor keys into the secret Terraform seeded (it already holds
`DATABASE_URL`, `REDIS_URL` and random internal tokens):

```bash
aws secretsmanager get-secret-value --secret-id avg/staging/app --query SecretString --output text > /tmp/app.json
# edit /tmp/app.json: CLERK_SECRET_KEY, TEMPORAL_API_KEY, ANTHROPIC_API_KEY, FAL_KEY,
#                     ELEVENLABS_API_KEY, STRIPE_*; then
aws secretsmanager put-secret-value --secret-id avg/staging/app --secret-string file:///tmp/app.json
shred -u /tmp/app.json
```

## 3. Cluster add-ons and ArgoCD

```bash
bash infra/terraform/bootstrap.sh staging ops@example.com
```

Installs ingress-nginx (NLB), cert-manager with a Let's Encrypt issuer, External Secrets with
the `aws-secrets-manager` ClusterSecretStore, KEDA, the cluster autoscaler,
kube-prometheus-stack and ArgoCD, then applies `deploy/argocd/project.yaml` and
`deploy/argocd/staging.yaml`.

Point DNS at the ingress:

```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
# CNAME api.staging.example.com and app.staging.example.com to that hostname
```

## 4. Environment values

Edit `deploy/envs/staging/values.yaml` with the Terraform outputs and your Temporal Cloud
target, commit and push to main:

- `config.apiUrl`, `config.webUrl`, `ingress.api.host`, `ingress.web.host`
- `config.temporal.address` / `namespace` (from the Temporal Cloud namespace page)
- `config.media.bucket`, `config.media.region`
- `api.serviceAccount.annotations` and `worker.serviceAccount.annotations` role ARNs

Set the GitHub repository variables `STAGING_API_URL` (`https://api.staging.example.com`)
and `STAGING_CLERK_PUBLISHABLE_KEY` so the dashboard image is built against them.

## 5. First release

Push to main. `release.yml` builds `avg-api`, `avg-worker` and `avg-web-staging`, pushes them
to GHCR and commits the new image tag into `deploy/envs/staging/values.yaml`. ArgoCD picks the
commit up, runs the migration Job as a PreSync hook, then rolls out the three Deployments.

If the GHCR packages are private, create a pull secret in the namespace and set
`global.imagePullSecrets` in the values file:

```bash
kubectl -n avg-staging create secret docker-registry ghcr --docker-server=ghcr.io \
  --docker-username=<github user> --docker-password=<PAT with read:packages>
```

Watch it land:

```bash
argocd app get avg-staging            # or the ArgoCD UI via port-forward svc/argocd-server 8080:80
kubectl -n avg-staging get pods
kubectl -n avg-staging logs deploy/avg-api --tail=50
```

## 6. Stripe webhook and Clerk

- Stripe → Developers → Webhooks → add `https://api.staging.example.com/v1/billing/webhook`
  with the events listed in [07 — Billing](../07-billing-and-credits.md); paste the signing
  secret into `STRIPE_WEBHOOK_SECRET` in Secrets Manager (External Secrets refreshes within
  an hour; `kubectl -n avg-staging annotate externalsecret avg-app force-sync=$(date +%s)`
  forces it).
- Clerk → Domains → add `app.staging.example.com`.

## 7. Smoke test

```bash
# a Clerk session token: sign in on app.staging.example.com, then in the browser console
# await window.Clerk.session.getToken()
API_URL=https://api.staging.example.com TOKEN=<jwt> SMOKE_DURATION=15 bash scripts/smoke.sh
```

The script creates a job, follows the SSE stream to `job.completed`, downloads the MP4
through its signed URL and prints `ffprobe` output. On live providers a 15 s job costs
roughly $1 and takes 3–6 minutes. Then run the load test read-only path against staging:

```bash
k6 run -e API_URL=https://api.staging.example.com -e TOKEN=<jwt> -e VUS=10 -e DURATION=2m scripts/load/api-smoke.js
```

## 8. Day-2 checks

| Check                                   | Where                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| Rollout state                           | ArgoCD UI; `kubectl -n avg-staging rollout status deploy/avg-api`                     |
| Worker backlog / scaling                | Temporal Cloud namespace page; `kubectl -n avg-staging get scaledobject`              |
| API latency, job starts, stage failures | Grafana (kube-prometheus-stack) → `avg_*` metrics from the ServiceMonitor             |
| Secrets sync                            | `kubectl -n avg-staging get externalsecret` (`SecretSynced` condition)                |
| Migrations                              | `kubectl -n avg-staging get jobs` (the PreSync Job is deleted after success)          |
| Cost                                    | AWS Cost Explorer tag `Project=avg`; provider dashboards (fal, ElevenLabs, Anthropic) |

## Promoting to production

Tag a release: `git tag v0.2.0 && git push origin v0.2.0`. The release workflow builds the
same commit with the `v0.2.0` tag (and `avg-web-prod` against `PROD_API_URL`), bumps
`deploy/envs/prod/values.yaml` and stops. Production has no auto-sync: review the diff in
ArgoCD and press Sync (or `argocd app sync avg-prod`). Rollback is `argocd app history` +
`argocd app rollback avg-prod <id>`, or reverting the values commit.

## Tearing staging down

```bash
argocd app delete avg-staging          # removes the namespace and its load balancer
cd infra/terraform/envs/staging && terraform destroy
```

`force_destroy` is set on the staging media bucket so destroy empties it; the RDS instance
skips the final snapshot because `deletion_protection` is off for staging.
