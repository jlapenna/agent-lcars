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
    github      = { source = "integrations/github", version = "~> 6.0" }
  }
}

# user_project_override makes the providers bill API calls to this project
# rather than to the credential's own. Without it the google provider ignores
# ADC's quota_project_id entirely and requests go out against Google's default
# OAuth client project (764086051850), where billingbudgets.googleapis.com is
# not enabled -- so refreshing google_billing_budget.monthly fails with a 403
# SERVICE_DISABLED for every operator, even one whose ADC quota project and
# API enablement are already correct. billing_project names the project the
# override should charge.
provider "google" {
  project               = var.project_id
  billing_project       = var.project_id
  user_project_override = true
}

provider "google-beta" {
  project               = var.project_id
  billing_project       = var.project_id
  user_project_override = true
}

# CI initializes with `-backend=false` and runs credential-free validation and
# mock-provider tests only; it never reads real GitHub resources. A real plan
# or apply therefore still uses an operator-supplied credential, never a repo
# secret. The provider reads the token from the GITHUB_TOKEN env var by default
# (no `token` argument here, so none can ever be committed) -- an operator with
# admin on this repository exports it themselves, e.g.
# `export GITHUB_TOKEN=$(gh auth token)`, before `plan` or `apply`. Ruleset
# reads/writes require admin, which is why this can't be a narrower classic PAT
# the way apps/dispatch-broker's tokens are scoped.
provider "github" {
  owner = var.github_owner
}
