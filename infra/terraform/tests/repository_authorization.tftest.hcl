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
    target          = google_project_iam_custom_role.codex_auth_runtime
    override_during = plan
    values = {
      name = "projects/agent-lcars/roles/codexAuthRuntime"
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
    target          = google_project_iam_custom_role.quick_task_evidence_runtime
    override_during = plan
    values = {
      name = "projects/agent-lcars/roles/quickTaskEvidenceRuntime"
    }
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository in ['jlapenna/agent-lcars', 'supersprinklesracing/sprinkles', 'jlapenna/homelab', 'supersprinklesracing/www', 'supersprinklesracing/girosf', 'jlapenna/nx-cache-server', 'jlapenna/sync-padd']"
    error_message = "The WIF provider must authorize exactly the seven fleet repositories, in order."
  }

  assert {
    condition     = google_storage_bucket.codex_auth.name == "agent-lcars-codex-auth" && google_storage_bucket.codex_auth.uniform_bucket_level_access && google_storage_bucket.codex_auth.public_access_prevention == "enforced" && google_storage_bucket.codex_auth.versioning[0].enabled && google_storage_bucket.codex_auth.soft_delete_policy[0].retention_duration_seconds == 0 && alltrue([for lifecycle in google_storage_bucket.codex_auth.lifecycle_rule : alltrue([for condition in lifecycle.condition : condition.days_since_noncurrent_time == 7 && condition.with_state == "ARCHIVED"])])
    error_message = "Codex auth must use a private versioned bucket with seven-day noncurrent recovery and no soft-delete retention."
  }

  assert {
    condition     = google_project_iam_custom_role.codex_auth_runtime.role_id == "codexAuthRuntime" && toset(google_project_iam_custom_role.codex_auth_runtime.permissions) == toset(["storage.objects.create", "storage.objects.get", "storage.objects.delete"])
    error_message = "The Codex auth runtime role must grant only generation-CAS read/replace operations."
  }

  assert {
    condition     = length(google_storage_bucket_iam_member.codex_auth_runtime) == 6 && alltrue([for repository, binding in google_storage_bucket_iam_member.codex_auth_runtime : binding.bucket == google_storage_bucket.codex_auth.name && binding.role == google_project_iam_custom_role.codex_auth_runtime.name && binding.condition[0].expression == "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.codex_auth.name}/objects/${repository}/\")"])
    error_message = "Each Codex identity must be confined to its own object prefix in the auth bucket."
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
    condition     = google_secret_manager_secret.admin_storage_state.secret_id == "AGENT_LCARS_ADMIN_STORAGE_STATE"
    error_message = "The production verifier storage state must use its documented dedicated secret."
  }

  assert {
    condition     = google_secret_manager_secret_iam_member.admin_storage_state_accessor.role == "roles/secretmanager.secretAccessor" && google_secret_manager_secret_iam_member.admin_storage_state_accessor.member == "serviceAccount:${google_service_account.codex_agent.email}"
    error_message = "The Agent LCARS Codex service account must have read-only access to the verifier session secret."
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

  # #1350: one shared, READ-ONLY Claude subscription token. The absence of a
  # secretVersionAdder grant is the point - the lane reads, only a human
  # writes - so assert the identity holds exactly one role on exactly one
  # secret. Contrast the codex agents below, which must be able to rotate.
  assert {
    condition     = google_secret_manager_secret.claude_oauth.secret_id == "CLAUDE_CODE_OAUTH_TOKEN" && google_secret_manager_secret_iam_member.claude_oauth_accessor.role == "roles/secretmanager.secretAccessor" && google_secret_manager_secret_iam_member.claude_oauth_accessor.member == "serviceAccount:${google_service_account.claude_token_reader.email}"
    error_message = "The Claude subscription token must be one secret read by one dedicated read-only identity."
  }

  assert {
    condition     = length(google_service_account_iam_member.claude_token_reader_impersonation) == length(local.github_repositories)
    error_message = "Every authorized repository must be able to impersonate the Claude token reader, and no others."
  }

  # #1354: one lineage and one identity PER repo. A shared credential would
  # let concurrent runs invalidate each other, and a shared identity would
  # let one repo's agent rotate another's credential.
  assert {
    condition     = alltrue([for key, agent in local.fleet_codex_agents : google_secret_manager_secret.fleet_codex_auth[key].secret_id == agent.secret])
    error_message = "Each fleet repository must have its own rotating Codex credential secret."
  }

  assert {
    condition     = length(distinct([for key, _ in local.fleet_codex_agents : google_service_account.fleet_codex_agent[key].account_id])) == length(local.fleet_codex_agents)
    error_message = "Each fleet repository must have its own Codex service account so rotating credentials cannot race across repositories."
  }

  assert {
    condition     = alltrue([for key, _ in local.fleet_codex_agents : google_secret_manager_secret_iam_member.fleet_codex_auth_accessor[key].role == "roles/secretmanager.secretAccessor" && google_secret_manager_secret_iam_member.fleet_codex_auth_version_adder[key].role == "roles/secretmanager.secretVersionAdder"])
    error_message = "Each fleet Codex identity must read and append versions to its own secret - never secretAdmin."
  }

  assert {
    condition     = alltrue([for key, _ in local.fleet_codex_agents : google_service_account_iam_member.fleet_codex_agent_impersonation[key].member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${key}"])
    error_message = "Each fleet Codex identity must be impersonable only from its own repository."
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
    condition     = google_project_iam_member.apphosting_dispatch_controller.condition[0].expression == "resource.name == \"projects/agent-lcars/databases/dispatch-controller\""
    error_message = "The hosted controller writer must be confined to the dedicated dispatch database."
  }

  assert {
    condition     = google_project_iam_member.writer_firestore.condition[0].expression == "resource.name == \"projects/agent-lcars/databases/(default)\"" && google_project_iam_member.apphosting_firestore.condition[0].expression == "resource.name == \"projects/agent-lcars/databases/(default)\""
    error_message = "Telemetry identities must remain confined to the default database and unable to access dispatch authority."
  }

  assert {
    condition     = google_storage_bucket.quick_task_evidence.name == "agent-lcars-quick-task-evidence" && google_storage_bucket.quick_task_evidence.uniform_bucket_level_access && google_storage_bucket.quick_task_evidence.public_access_prevention == "enforced" && !google_storage_bucket.quick_task_evidence.versioning[0].enabled && google_storage_bucket.quick_task_evidence.soft_delete_policy[0].retention_duration_seconds == 0
    error_message = "Quick Task evidence must use its dedicated private uniform-access bucket without versioning or soft-delete retention."
  }

  assert {
    condition     = google_project_iam_custom_role.quick_task_evidence_runtime.role_id == "quickTaskEvidenceRuntime" && toset(google_project_iam_custom_role.quick_task_evidence_runtime.permissions) == toset(["storage.objects.create", "storage.objects.get", "storage.objects.delete"])
    error_message = "The evidence runtime role must grant only create, get, and delete."
  }

  assert {
    condition     = google_storage_bucket_iam_member.apphosting_quick_task_evidence.bucket == google_storage_bucket.quick_task_evidence.name && google_storage_bucket_iam_member.apphosting_quick_task_evidence.role == google_project_iam_custom_role.quick_task_evidence_runtime.name && google_storage_bucket_iam_member.apphosting_quick_task_evidence.member == "serviceAccount:firebase-app-hosting-compute@agent-lcars.iam.gserviceaccount.com"
    error_message = "Only the App Hosting runtime may receive the evidence bucket runtime role."
  }
}

run "rejects_repository_wildcards" {
  command = plan

  variables {
    github_owner                  = "*"
    github_repository             = "*"
    sprinkles_repository          = "supersprinklesracing/*"
    homelab_repository            = "jlapenna/*"
    additional_fleet_repositories = ["supersprinklesracing/*"]
  }

  expect_failures = [
    var.github_owner,
    var.github_repository,
    var.sprinkles_repository,
    var.homelab_repository,
    var.additional_fleet_repositories,
  ]
}
