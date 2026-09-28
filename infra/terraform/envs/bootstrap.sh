#!/usr/bin/env bash
# Installs the cluster add-ons the chart relies on, after `terraform apply` for an environment.
# Idempotent: re-run whenever a version below changes.
#   bash infra/terraform/bootstrap.sh staging [letsencrypt-email]
set -euo pipefail
ENV="${1:?environment (staging|prod)}"
ACME_EMAIL="${2:-ops@example.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/envs/$ENV" && pwd)"

out() { terraform -chdir="$ROOT" output -raw "$1"; }
CLUSTER=$(out cluster_name)
ESO_ROLE=$(out external_secrets_role_arn)
CA_ROLE=$(out cluster_autoscaler_role_arn)
REGION=$(terraform -chdir="$ROOT" output -json helm_values | python3 -c 'import sys,json; print(json.load(sys.stdin)["region"])')

$(out kubeconfig_command)

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null
helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo add external-secrets https://charts.external-secrets.io >/dev/null
helm repo add kedacore https://kedacore.github.io/charts >/dev/null
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null
helm repo add autoscaler https://kubernetes.github.io/autoscaler >/dev/null
helm repo update >/dev/null

# Ingress: an internet-facing NLB in front of nginx (SSE-friendly, cheap).
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --version 4.12.0 \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-type"=nlb \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-scheme"=internet-facing \
  --set controller.config.proxy-read-timeout=3600 \
  --set controller.replicaCount=2 --wait

helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --version v1.16.2 --set crds.enabled=true --wait
kubectl apply -f - <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: $ACME_EMAIL
    privateKeySecretRef: { name: letsencrypt-account }
    solvers:
      - http01:
          ingress: { ingressClassName: nginx }
YAML

helm upgrade --install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace \
  --version 0.12.1 \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="$ESO_ROLE" --wait
kubectl apply -f - <<YAML
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: $REGION
      auth:
        jwt:
          serviceAccountRef: { name: external-secrets, namespace: external-secrets }
YAML

helm upgrade --install keda kedacore/keda -n keda --create-namespace --version 2.16.1 --wait

helm upgrade --install cluster-autoscaler autoscaler/cluster-autoscaler -n kube-system \
  --version 9.43.2 \
  --set autoDiscovery.clusterName="$CLUSTER" --set awsRegion="$REGION" \
  --set rbac.serviceAccount.name=cluster-autoscaler \
  --set rbac.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="$CA_ROLE" --wait

helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack -n monitoring --create-namespace \
  --version 67.4.0 --set grafana.enabled=true --set prometheus.prometheusSpec.retention=15d \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false --wait

helm upgrade --install argocd argo/argo-cd -n argocd --create-namespace --version 7.7.11 \
  --set configs.params."server\.insecure"=true --wait
kubectl apply -f "$(dirname "${BASH_SOURCE[0]}")/../../deploy/argocd/project.yaml"
kubectl apply -f "$(dirname "${BASH_SOURCE[0]}")/../../deploy/argocd/$ENV.yaml"

echo
echo "ArgoCD admin password: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
echo "Ingress hostname:      kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'"
