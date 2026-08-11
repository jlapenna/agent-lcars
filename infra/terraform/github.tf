# The "Protect main" ruleset is the only thing protecting `main` (classic
# branch protection was retired in #898). It was configured entirely
# through the API until now (issue #900); this resource codifies that live
# configuration verbatim and is adopted with `terraform import`
# (README.md#github-ruleset), never created fresh -- recreating it would
# briefly leave `main` unprotected.
resource "github_repository_ruleset" "protect_main" {
  name        = "Protect main"
  repository  = var.github_repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  # Admins (RepositoryRole:5) keep bypass_mode "always" as a deliberate
  # escape hatch -- see agent-lcars-dev/references/pr.md. Terraform manages
  # the very ruleset that gates its own pull requests, so a bad apply that
  # dropped this would leave the fix unmergeable through the normal path;
  # this bypass is the only way out.
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
      # Harmonized with the sprinkles repo (2026-08-11): non-strict, so an
      # armed PR merges on green without requiring a branch update per
      # main-side merge. The stale-tested-tree risk is accepted in both
      # repos; post-merge Verify re-runs on main are the safety net.
      strict_required_status_checks_policy = false
      do_not_enforce_on_create             = false

      required_check {
        context = "Verify"
      }
    }
  }
}
