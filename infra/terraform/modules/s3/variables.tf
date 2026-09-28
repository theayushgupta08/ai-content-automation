variable "bucket_name" {
  type = string
}

variable "cors_origins" {
  description = "Dashboard origins allowed to fetch media directly."
  type        = list(string)
}

variable "intermediate_retention_days" {
  description = "Days to keep per-job intermediates before expiry. Final outputs are re-keyed under output/ by the api when the retention job lands; until then this applies to whole job prefixes."
  type        = number
  default     = 180
}

variable "force_destroy" {
  description = "Allow destroying a non-empty bucket (staging only)."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
