terraform {
  # 1.11, not 1.8: tests/repository_authorization.tftest.hcl uses
  # `override_during`, which 1.10.5 and earlier reject outright at `init` --
  # so the old floor advertised a version that could not run this config at
  # all. Verified empirically: 1.10.5 rejects, 1.11.0 accepts.
  required_version = ">= 1.11"
  backend "gcs" {
    bucket = "agent-lcars-terraform-state"
    prefix = "terraform/default"
  }
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 7.0" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 7.0" }
  }
}

provider "google" { project = var.project_id }
provider "google-beta" { project = var.project_id }
