# IRSA roles for the application workloads. The Helm chart annotates the api and worker
# service accounts with these ARNs, so pods get credentials without S3_ACCESS_KEY/SECRET.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
}

data "aws_iam_policy_document" "media_rw" {
  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [var.media_bucket_arn]
  }
  statement {
    sid       = "ObjectRW"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["${var.media_bucket_arn}/*"]
  }
}

data "aws_iam_policy_document" "media_presign" {
  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [var.media_bucket_arn]
  }
  # The api presigns downloads and streams nothing itself; deletes cover DSAR/retention.
  statement {
    sid       = "ObjectRead"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${var.media_bucket_arn}/*"]
  }
}

resource "aws_iam_policy" "worker" {
  name   = "${var.name}-worker-media"
  policy = data.aws_iam_policy_document.media_rw.json
  tags   = var.tags
}

resource "aws_iam_policy" "api" {
  name   = "${var.name}-api-media"
  policy = data.aws_iam_policy_document.media_presign.json
  tags   = var.tags
}

module "worker_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name = "${var.name}-worker"
  role_policy_arns = {
    media = aws_iam_policy.worker.arn
  }
  oidc_providers = {
    main = {
      provider_arn               = var.oidc_provider_arn
      namespace_service_accounts = ["${var.namespace}:avg-worker"]
    }
  }
  tags = var.tags
}

module "api_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name = "${var.name}-api"
  role_policy_arns = {
    media = aws_iam_policy.api.arn
  }
  oidc_providers = {
    main = {
      provider_arn               = var.oidc_provider_arn
      namespace_service_accounts = ["${var.namespace}:avg-api"]
    }
  }
  tags = var.tags
}
