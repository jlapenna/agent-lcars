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

resource "github_repository_ruleset" "protect_main" {
  name        = "Protect main"
  repository  = "agent-lcars"
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  # Repository administrators retain the emergency escape hatch needed to
  # repair the ruleset that gates its own pull requests.
  bypass_actors {
    actor_id    = 5
    actor_type  = "RepositoryRole"
    bypass_mode = "always"
  }

  rules {
    deletion                = true
    non_fast_forward        = true
    required_linear_history = true

    pull_request {
      required_approving_review_count   = 0
      dismiss_stale_reviews_on_push     = true
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = true
      allowed_merge_methods             = ["merge", "squash", "rebase"]
    }

    required_status_checks {
      strict_required_status_checks_policy = false
      do_not_enforce_on_create             = false

      required_check {
        context = "E2E"
      }
      required_check {
        context = "Verify"
      }
      required_check {
        context = "Runner image pnpm-store seed"
      }
      required_check {
        context = "repository-owned Terraform"
      }
    }
  }
}
