mock_provider "google" {
  override_during = plan

  mock_resource "google_service_account" {
    defaults = {
      email = "mock-service-account@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/mock-service-account@agent-lcars.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_iam_workload_identity_pool" {
    defaults = {
      name = "projects/611425338852/locations/global/workloadIdentityPools/github"
    }
  }
}
mock_provider "google-beta" {
  override_during = plan
}

variables {
  billing_account = "000000-000000-000000"
}

run "renders_exact_repository_authorization" {
  command = plan

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository in ['jlapenna/agent-lcars', 'supersprinklesracing/sprinkles', 'jlapenna/homelab']"
    error_message = "The WIF provider must authorize exactly Agent LCARS, Sprinkles, and Homelab."
  }

  assert {
    condition     = !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "*")
    error_message = "The WIF provider condition must not contain a repository wildcard."
  }

  assert {
    condition     = google_service_account_iam_member.agent_lcars_writer_impersonation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/jlapenna/agent-lcars"
    error_message = "The Agent LCARS telemetry-writer grant must remain intact."
  }

  assert {
    condition     = google_service_account_iam_member.members_writer_impersonation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/supersprinklesracing/sprinkles"
    error_message = "The Sprinkles telemetry-writer grant must remain intact."
  }

  assert {
    condition     = google_service_account_iam_member.homelab_writer_impersonation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/jlapenna/homelab"
    error_message = "The Homelab telemetry-writer grant must use the exact repository principal."
  }

  assert {
    condition     = google_service_account_iam_member.codex_agent_impersonation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/jlapenna/agent-lcars"
    error_message = "The Agent LCARS Codex grant must remain intact."
  }

  assert {
    condition     = google_service_account_iam_member.homelab_codex_agent_impersonation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/jlapenna/homelab"
    error_message = "The Homelab Codex grant must use the exact repository principal."
  }

  assert {
    condition     = google_service_account_iam_member.homelab_writer_impersonation.role == "roles/iam.workloadIdentityUser" && google_service_account_iam_member.homelab_codex_agent_impersonation.role == "roles/iam.workloadIdentityUser"
    error_message = "Both Homelab grants must use roles/iam.workloadIdentityUser."
  }
}

run "rejects_repository_wildcards" {
  command = plan

  variables {
    github_owner         = "*"
    github_repository    = "*"
    sprinkles_repository = "supersprinklesracing/*"
    homelab_repository   = "jlapenna/*"
  }

  expect_failures = [
    var.github_owner,
    var.github_repository,
    var.sprinkles_repository,
    var.homelab_repository,
  ]
}
