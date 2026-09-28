# Remote state. Create the bucket and lock table once with ../../bootstrap-state.sh, then
# `terraform init -backend-config=bucket=avg-terraform-state-<account-id>`.
terraform {
  backend "s3" {
    key            = "staging/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "avg-terraform-lock"
    encrypt        = true
  }
}
