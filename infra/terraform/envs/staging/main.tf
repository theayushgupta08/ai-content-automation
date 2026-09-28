locals {
  name      = "avg-${var.environment}"
  namespace = "avg-${var.environment}"
  web_url   = "https://app.${var.domain}"
  api_url   = "https://api.${var.domain}"
  tags = {
    Project     = "avg"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

module "network" {
  source = "../../modules/network"

  name               = local.name
  cidr               = "10.20.0.0/16"
  single_nat_gateway = true
  tags               = local.tags
}

module "eks" {
  source = "../../modules/eks"

  name               = local.name
  environment        = var.environment
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  api_allowed_cidrs  = var.kubernetes_api_allowed_cidrs

  api_min_nodes    = 2
  api_max_nodes    = 4
  worker_min_nodes = 1
  worker_max_nodes = var.worker_max_nodes
  tags             = local.tags
}

module "rds" {
  source = "../../modules/rds"

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  db_subnet_group_name       = module.network.database_subnet_group_name
  allowed_security_group_ids = [module.eks.node_security_group_id]
  instance_class             = "db.t4g.large"
  multi_az                   = false
  deletion_protection        = false
  tags                       = local.tags
}

module "redis" {
  source = "../../modules/redis"

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [module.eks.node_security_group_id]
  node_type                  = "cache.t4g.medium"
  num_nodes                  = 1
  tags                       = local.tags
}

module "s3" {
  source = "../../modules/s3"

  bucket_name   = "${local.name}-media"
  cors_origins  = [local.web_url]
  force_destroy = true
  tags          = local.tags
}

module "iam" {
  source = "../../modules/iam"

  name              = local.name
  oidc_provider_arn = module.eks.oidc_provider_arn
  namespace         = local.namespace
  media_bucket_arn  = module.s3.bucket_arn
  tags              = local.tags
}

module "secrets" {
  source = "../../modules/secrets"

  environment  = var.environment
  database_url = module.rds.database_url
  redis_url    = module.redis.redis_url
  extra        = var.extra_secrets
  tags         = local.tags
}
