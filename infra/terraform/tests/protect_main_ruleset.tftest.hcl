# The `Protect main` ruleset is the only thing protecting `main` (see
# agent-lcars-dev/references/pr.md). This test pins the exact shape adopted
# from the live ruleset (issue #900) so a future edit that silently drops
# the admin bypass, the required `Verify` check, or the thread-resolution
# requirement fails here rather than by locking the repo's own PRs out of
# the normal merge path.
mock_provider "google" {
  override_during = plan
}
mock_provider "google-beta" {
  override_during = plan
}
mock_provider "github" {
  override_during = plan
}

variables {
  billing_account = "000000-000000-000000"
}

run "renders_protect_main_ruleset" {
  command = plan

  # The root module's google_secret_manager_secret_iam_member.nx_cache_access_token_accessor
  # for_each keys off two service accounts' emails; unlike
  # repository_authorization.tftest.hcl's target resources, this test never
  # asserts on them, but the mock "google" provider still leaves those
  # emails unknown until apply, which for_each rejects at plan time
  # (mirrors the override_resource blocks in
  # repository_authorization.tftest.hcl's "renders_exact_repository_authorization" run).
  override_resource {
    target          = google_service_account.codex_agent
    override_during = plan
    values = {
      email = "codex-agent@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/codex-agent@agent-lcars.iam.gserviceaccount.com"
    }
  }

  override_resource {
    target          = google_service_account.dispatch_preflight
    override_during = plan
    values = {
      email = "dispatch-preflight@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/dispatch-preflight@agent-lcars.iam.gserviceaccount.com"
    }
  }

  assert {
    condition     = github_repository_ruleset.protect_main.name == "Protect main"
    error_message = "The ruleset must keep GitHub's exact display name so it stays recognizable as the same object across a plan/apply round-trip."
  }

  assert {
    condition     = github_repository_ruleset.protect_main.repository == var.github_repository
    error_message = "The ruleset must target this repository."
  }

  assert {
    condition     = github_repository_ruleset.protect_main.target == "branch" && github_repository_ruleset.protect_main.enforcement == "active"
    error_message = "The ruleset must stay a branch ruleset that is actively enforced, not merely evaluated."
  }

  assert {
    condition     = tolist(github_repository_ruleset.protect_main.conditions[0].ref_name[0].include) == tolist(["~DEFAULT_BRANCH"])
    error_message = "The ruleset must include exactly the default branch."
  }

  assert {
    condition     = length(github_repository_ruleset.protect_main.conditions[0].ref_name[0].exclude) == 0
    error_message = "The ruleset must not exclude any refs."
  }

  assert {
    condition     = length(github_repository_ruleset.protect_main.bypass_actors) == 1 && github_repository_ruleset.protect_main.bypass_actors[0].actor_id == 5 && github_repository_ruleset.protect_main.bypass_actors[0].actor_type == "RepositoryRole" && github_repository_ruleset.protect_main.bypass_actors[0].bypass_mode == "always"
    error_message = "Admins must keep the always-bypass escape hatch -- dropping it silently re-creates the merge lockout #900 exists to prevent."
  }

  assert {
    condition     = github_repository_ruleset.protect_main.rules[0].deletion == true && github_repository_ruleset.protect_main.rules[0].non_fast_forward == true && github_repository_ruleset.protect_main.rules[0].required_linear_history == true
    error_message = "The ruleset must keep blocking branch deletion and force-pushes, and require linear history (harmonized with sprinkles, 2026-08-11)."
  }

  assert {
    condition     = github_repository_ruleset.protect_main.rules[0].pull_request[0].required_approving_review_count == 0 && github_repository_ruleset.protect_main.rules[0].pull_request[0].required_review_thread_resolution == true
    error_message = "The ruleset must require zero approvals but still require every review thread resolved, matching the live configuration."
  }

  assert {
    condition     = tolist(github_repository_ruleset.protect_main.rules[0].required_status_checks[0].required_check)[0].context == "Verify" && github_repository_ruleset.protect_main.rules[0].required_status_checks[0].strict_required_status_checks_policy == false
    error_message = "The ruleset must require the Verify check under the NON-strict up-to-date-branch policy (harmonized with sprinkles, 2026-08-11)."
  }
}
