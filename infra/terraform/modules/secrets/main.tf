# One Secrets Manager document per environment holding every key the chart's Secret needs
# (deploy/helm/avg/values.yaml lists them). Terraform seeds the infrastructure-derived values
# and random shared secrets; provider and vendor keys are added out of band and ignored on
# later applies so they are never written to state or git.
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.80" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

resource "random_password" "internal_api_token" {
  length  = 48
  special = false
}

resource "random_password" "media_signing_secret" {
  length  = 48
  special = false
}

resource "random_password" "metrics_token" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "avg/${var.environment}/app"
  description             = "avg ${var.environment}: application secrets synced by External Secrets"
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "seed" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(merge({
    DATABASE_URL         = var.database_url
    REDIS_URL            = var.redis_url
    INTERNAL_API_TOKEN   = random_password.internal_api_token.result
    MEDIA_SIGNING_SECRET = random_password.media_signing_secret.result
    METRICS_TOKEN        = random_password.metrics_token.result
    # Filled in by hand (console or `aws secretsmanager put-secret-value`):
    CLERK_SECRET_KEY           = ""
    TEMPORAL_API_KEY           = ""
    ANTHROPIC_API_KEY          = ""
    FAL_KEY                    = ""
    ELEVENLABS_API_KEY         = ""
    STRIPE_SECRET_KEY          = ""
    STRIPE_WEBHOOK_SECRET      = ""
    STRIPE_PRICE_STARTER_MONTH = ""
    STRIPE_PRICE_STARTER_YEAR  = ""
    STRIPE_PRICE_CREATOR_MONTH = ""
    STRIPE_PRICE_CREATOR_YEAR  = ""
    STRIPE_PRICE_PRO_MONTH     = ""
    STRIPE_PRICE_PRO_YEAR      = ""
    STRIPE_PRICE_STUDIO_MONTH  = ""
    STRIPE_PRICE_STUDIO_YEAR   = ""
    STRIPE_PRICE_PACK_500      = ""
  }, var.extra))

  lifecycle {
    # Keys edited by hand must survive the next apply.
    ignore_changes = [secret_string]
  }
}
