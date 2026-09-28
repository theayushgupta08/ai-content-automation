# Terraform

AWS reference layout from `docs/06-infrastructure-and-scaling.md`, one root per environment
under `envs/` composed from the modules in `modules/`.

| Module    | Creates                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `network` | VPC across 3 AZs, public/private subnets, one NAT gateway (staging) or one per AZ (prod) |
| `eks`     | EKS cluster, managed node groups (`system`, `api`, `workers`), IRSA, core add-ons        |
| `rds`     | PostgreSQL 16 (Multi-AZ in prod), parameter group, subnet group, master password in SM   |
| `redis`   | ElastiCache Redis 7 replication group with TLS and auth token                            |
| `s3`      | Versioned, encrypted media bucket with lifecycle rules and CORS for browser uploads      |
| `iam`     | IRSA roles for the api (presign) and workers (read/write) scoped to the media bucket     |
| `secrets` | Secrets Manager entries the External Secrets Operator syncs into the cluster             |

Workflow:

```bash
cd infra/terraform/envs/staging
cp terraform.tfvars.example terraform.tfvars   # fill in account, domain, Temporal Cloud target
terraform init                                  # backend: S3 + DynamoDB lock (see backend.tf)
terraform plan -out=plan.tfplan
terraform apply plan.tfplan
```

After apply, `terraform output -json` prints the values `deploy/envs/staging/values.yaml`
needs (IRSA role ARNs, bucket name, RDS endpoint) and `kubeconfig_command` for kubectl access.
Cluster add-ons that are not AWS-native (ingress-nginx, cert-manager, External Secrets Operator,
KEDA, kube-prometheus-stack, ArgoCD) are installed by `bootstrap.sh` in this directory, which
is idempotent.

Conventions:

- Remote state lives in `avg-terraform-state-<account>` with a DynamoDB lock table, both
  created once by hand (`bootstrap-state.sh`).
- Plans run in CI on pull requests touching `infra/` (`.github/workflows/infra.yml`);
  applies are manual from a laptop or Terraform Cloud.
- Provider versions are pinned in `versions.tf`; upgrade with `terraform init -upgrade` on a
  branch and commit the lock file.
