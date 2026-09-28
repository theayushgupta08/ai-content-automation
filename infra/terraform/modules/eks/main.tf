terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = var.name
  cluster_version = var.kubernetes_version

  vpc_id                   = var.vpc_id
  subnet_ids               = var.private_subnet_ids
  control_plane_subnet_ids = var.private_subnet_ids

  cluster_endpoint_public_access           = true
  cluster_endpoint_public_access_cidrs     = var.api_allowed_cidrs
  enable_cluster_creator_admin_permissions = true
  enable_irsa                              = true

  cluster_addons = {
    coredns                = { most_recent = true }
    kube-proxy             = { most_recent = true }
    vpc-cni                = { most_recent = true }
    eks-pod-identity-agent = { most_recent = true }
    aws-ebs-csi-driver = {
      most_recent              = true
      service_account_role_arn = module.ebs_csi_irsa.iam_role_arn
    }
  }

  cluster_enabled_log_types = ["api", "audit", "authenticator"]

  eks_managed_node_group_defaults = {
    ami_type      = "AL2023_x86_64_STANDARD"
    disk_size     = 50
    capacity_type = "ON_DEMAND"
    iam_role_additional_policies = {
      ssm = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    }
  }

  eks_managed_node_groups = {
    # ingress, argocd, external-secrets, keda, monitoring
    system = {
      instance_types = [var.system_instance_type]
      min_size       = 2
      max_size       = 4
      desired_size   = 2
      labels         = { "avg.io/pool" = "system" }
    }
    # api + web
    api = {
      instance_types = [var.api_instance_type]
      min_size       = var.api_min_nodes
      max_size       = var.api_max_nodes
      desired_size   = var.api_min_nodes
      labels         = { "avg.io/pool" = "api" }
    }
    # pipeline workers (CPU-bound FFmpeg renders); KEDA scales pods, the cluster autoscaler
    # scales this group
    workers = {
      instance_types = [var.worker_instance_type]
      min_size       = var.worker_min_nodes
      max_size       = var.worker_max_nodes
      desired_size   = var.worker_min_nodes
      labels         = { "avg.io/pool" = "workers" }
      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size = 100
            volume_type = "gp3"
            throughput  = 250
          }
        }
      }
    }
  }

  tags = var.tags
}

module "ebs_csi_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name             = "${var.name}-ebs-csi"
  attach_ebs_csi_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }

  tags = var.tags
}

# Cluster autoscaler role; the controller itself is installed by bootstrap.sh.
module "cluster_autoscaler_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name                        = "${var.name}-cluster-autoscaler"
  attach_cluster_autoscaler_policy = true
  cluster_autoscaler_cluster_names = [module.eks.cluster_name]

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:cluster-autoscaler"]
    }
  }

  tags = var.tags
}

# External Secrets Operator role: read the environment's secrets from Secrets Manager.
module "external_secrets_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name                             = "${var.name}-external-secrets"
  attach_external_secrets_policy        = true
  external_secrets_secrets_manager_arns = ["arn:aws:secretsmanager:*:*:secret:avg/${var.environment}/*"]
  external_secrets_ssm_parameter_arns   = []

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["external-secrets:external-secrets"]
    }
  }

  tags = var.tags
}
