output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "cluster_name" {
  value = module.eks.cluster_name
}

# Paste these into deploy/envs/staging/values.yaml.
output "helm_values" {
  value = {
    api_role_arn    = module.iam.api_role_arn
    worker_role_arn = module.iam.worker_role_arn
    media_bucket    = module.s3.bucket_name
    region          = var.region
    api_url         = local.api_url
    web_url         = local.web_url
  }
}

# Consumed by bootstrap.sh.
output "external_secrets_role_arn" {
  value = module.eks.external_secrets_role_arn
}

output "cluster_autoscaler_role_arn" {
  value = module.eks.cluster_autoscaler_role_arn
}

output "secret_name" {
  value = module.secrets.secret_name
}

output "rds_endpoint" {
  value = module.rds.endpoint
}
