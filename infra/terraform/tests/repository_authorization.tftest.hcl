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

  override_resource {
    target          = google_service_account.codex_agent
    override_during = plan
    values = {
      email = "codex-agent@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/codex-agent@agent-lcars.iam.gserviceaccount.com"
    }
  }

  override_resource {
    target          = google_service_account.homelab_codex_agent
    override_during = plan
    values = {
      email = "homelab-codex-agent@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/homelab-codex-agent@agent-lcars.iam.gserviceaccount.com"
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
    condition     = google_service_account_iam_member.homelab_codex_agent_impersonation.service_account_id == google_service_account.homelab_codex_agent.name && google_service_account_iam_member.homelab_codex_agent_impersonation.service_account_id != google_service_account.codex_agent.name
    error_message = "Homelab must use its own Codex service account so rotating credentials cannot race across repositories."
  }

  assert {
    condition     = google_secret_manager_secret.homelab_codex_auth.secret_id == "HOMELAB_CODEX_AUTH_JSON"
    error_message = "Homelab must use its own rotating Codex credential secret."
  }

  assert {
    condition     = google_secret_manager_secret_iam_member.homelab_codex_auth_accessor.role == "roles/secretmanager.secretAccessor" && google_secret_manager_secret_iam_member.homelab_codex_auth_accessor.member == "serviceAccount:${google_service_account.homelab_codex_agent.email}"
    error_message = "The Homelab Codex service account must be able to read only its dedicated secret."
  }

  assert {
    condition     = google_secret_manager_secret_iam_member.homelab_codex_auth_version_adder.role == "roles/secretmanager.secretVersionAdder" && google_secret_manager_secret_iam_member.homelab_codex_auth_version_adder.member == "serviceAccount:${google_service_account.homelab_codex_agent.email}"
    error_message = "The Homelab Codex service account must be able to append refreshed versions to its dedicated secret."
  }

  assert {
    condition     = google_service_account_iam_member.homelab_writer_impersonation.role == "roles/iam.workloadIdentityUser" && google_service_account_iam_member.homelab_codex_agent_impersonation.role == "roles/iam.workloadIdentityUser"
    error_message = "Both Homelab grants must use roles/iam.workloadIdentityUser."
  }

  assert {
    condition     = google_project_iam_member.apphosting_dispatch_controller.role == "roles/datastore.user" && google_project_iam_member.apphosting_dispatch_controller.member == "serviceAccount:firebase-app-hosting-compute@agent-lcars.iam.gserviceaccount.com"
    error_message = "The hosted controller must hold the dedicated dispatch writer grant."
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github_deployer.attribute_condition == "assertion.repository == 'jlapenna/agent-lcars' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'jlapenna/agent-lcars/.github/workflows/deploy-console.yml@refs/heads/main'"
    error_message = "The project-IAM deployer provider must accept only deploy-console.yml from main."
  }

  assert {
    condition     = google_service_account_iam_member.github_deployer_impersonation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_deployer.name}/attribute.repository/jlapenna/agent-lcars"
    error_message = "The project-IAM deployer must not be impersonable through the repo-wide worker pool."
  }

  assert {
    condition     = google_service_account_iam_member.dispatch_preflight_impersonation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/jlapenna/agent-lcars" && google_service_account_iam_member.dispatch_preflight_impersonation.service_account_id == google_service_account.dispatch_preflight.name
    error_message = "Workers may impersonate only the dedicated dispatch preflight reader through the shared pool."
  }

  assert {
    condition     = google_project_iam_member.dispatch_preflight_firestore.role == "roles/datastore.viewer" && google_project_iam_member.dispatch_preflight_firestore.member == "serviceAccount:${google_service_account.dispatch_preflight.email}"
    error_message = "Worker preflight must be read-only."
  }

  assert {
    condition     = google_project_iam_member.apphosting_dispatch_controller.condition[0].expression == "resource.name == \"projects/agent-lcars/databases/dispatch-controller\"" && google_project_iam_member.dispatch_preflight_firestore.condition[0].expression == "resource.name == \"projects/agent-lcars/databases/dispatch-controller\""
    error_message = "Hosted controller writer and preflight reader must be confined to the dedicated dispatch database."
  }

  assert {
    condition     = google_project_iam_member.writer_firestore.condition[0].expression == "resource.name == \"projects/agent-lcars/databases/(default)\"" && google_project_iam_member.apphosting_firestore.condition[0].expression == "resource.name == \"projects/agent-lcars/databases/(default)\""
    error_message = "Telemetry identities must remain confined to the default database and unable to access dispatch authority."
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
