terraform {
  required_version = ">= 1.8"
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
