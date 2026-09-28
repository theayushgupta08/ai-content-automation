variable "name" {
  type = string
}

variable "environment" {
  description = "Environment label used in secret ARNs (staging, prod)."
  type        = string
}

variable "kubernetes_version" {
  type    = string
  default = "1.31"
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "api_allowed_cidrs" {
  description = "CIDRs allowed to reach the Kubernetes API endpoint."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "system_instance_type" {
  type    = string
  default = "m6i.large"
}

variable "api_instance_type" {
  type    = string
  default = "c6i.xlarge"
}

variable "worker_instance_type" {
  type    = string
  default = "c6i.2xlarge"
}

variable "api_min_nodes" {
  type    = number
  default = 2
}

variable "api_max_nodes" {
  type    = number
  default = 6
}

variable "worker_min_nodes" {
  type    = number
  default = 2
}

variable "worker_max_nodes" {
  type    = number
  default = 20
}

variable "tags" {
  type    = map(string)
  default = {}
}
