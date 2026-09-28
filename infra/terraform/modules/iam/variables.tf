variable "name" {
  type = string
}

variable "oidc_provider_arn" {
  type = string
}

variable "namespace" {
  description = "Kubernetes namespace the chart is installed in (avg-staging, avg-prod)."
  type        = string
}

variable "media_bucket_arn" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
