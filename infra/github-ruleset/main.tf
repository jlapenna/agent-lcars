// Repository-owned inputs for Agent LCARS's Protect main ruleset.
//
// Homelab remains the executor: it supplies the GCS backend configuration,
// GitHub credential, and scheduled drift check. Keeping this root here makes
// the repository's check contexts and its strictness choice reviewable with
// the workflows that produce those contexts.
terraform {
  required_version = ">= 1.11"

  // Backend values are deliberately absent. The trusted Homelab executor
  // injects the shared bucket and this repository's isolated state prefix.
  backend "gcs" {}

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "github" {
  owner = "jlapenna"
}

module "protect_main" {
  // The policy implementation remains shared and centrally versioned; this
  // repository owns only the values that genuinely vary per repository.
  source = "git::https://github.com/jlapenna/homelab.git//terraform/modules/protect-main?ref=31654d207a88e1048d859db2dc2a1c08fa1892bc"

  repository      = "agent-lcars"
  required_checks = ["E2E", "Verify", "Runner image pnpm-store seed"]
}
