variable "name" {
  description = "Prefix for every resource name, e.g. avg-staging."
  type        = string
}

variable "cidr" {
  description = "VPC CIDR."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "Availability zones to span."
  type        = number
  default     = 3
}

variable "single_nat_gateway" {
  description = "One NAT gateway for the VPC (cheaper, staging) instead of one per AZ (prod)."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
