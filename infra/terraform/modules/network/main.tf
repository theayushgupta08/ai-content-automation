terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.17"

  name = "${var.name}-vpc"
  cidr = var.cidr

  azs              = local.azs
  private_subnets  = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, i)]
  public_subnets   = [for i in range(var.az_count) : cidrsubnet(var.cidr, 8, 48 + i)]
  database_subnets = [for i in range(var.az_count) : cidrsubnet(var.cidr, 8, 64 + i)]

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat_gateway
  one_nat_gateway_per_az = !var.single_nat_gateway
  enable_dns_hostnames   = true
  enable_dns_support     = true

  create_database_subnet_group = true

  # Tags the AWS load balancer controller and Karpenter read.
  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
    "karpenter.sh/discovery"          = var.name
  }

  tags = var.tags
}
