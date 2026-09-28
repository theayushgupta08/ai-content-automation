variable "region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "domain" {
  description = "Base domain; the dashboard is app.<domain> and the api is api.<domain>."
  type        = string
}

variable "kubernetes_api_allowed_cidrs" {
  description = "Office/VPN CIDRs allowed to reach the EKS API. Tighten after bootstrap."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "worker_max_nodes" {
  type    = number
  default = 10
}

variable "extra_secrets" {
  description = "Provider keys to seed into Secrets Manager. Prefer entering them in the console."
  type        = map(string)
  default     = {}
  sensitive   = true
}
