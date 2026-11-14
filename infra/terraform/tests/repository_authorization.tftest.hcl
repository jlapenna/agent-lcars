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
  alert_email     = "test@example.com"
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
    target          = google_service_account.telemetry_writer
    override_during = plan
    values = {
      email = "telemetry-writer@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/telemetry-writer@agent-lcars.iam.gserviceaccount.com"
    }
  }

  override_resource {
    target          = google_service_account.work_reader
    override_during = plan
    values = {
      email = "work-reader@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/work-reader@agent-lcars.iam.gserviceaccount.com"
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
    condition     = google_storage_bucket_iam_member.apphosting_codex_auth_broker.bucket == google_storage_bucket.codex_auth.name && google_storage_bucket_iam_member.apphosting_codex_auth_broker.role == google_project_iam_custom_role.codex_auth_runtime.name && google_storage_bucket_iam_member.apphosting_codex_auth_broker.member == "serviceAccount:firebase-app-hosting-compute@agent-lcars.iam.gserviceaccount.com" && local.codex_auth_broker_objects == [local.codex_central_auth_object, local.codex_auth_lease_object] && google_storage_bucket_iam_member.apphosting_codex_auth_broker.condition[0].expression == join(" || ", [for object in local.codex_auth_broker_objects : "resource.name == \"${object}\""])
    error_message = "The Console broker must be confined to the one central auth.json object and one shared lease object."
  }

  assert {
    condition     = google_service_account.codex_agent.email == "codex-agent@agent-lcars.iam.gserviceaccount.com"
    error_message = "Keep the Codex agent service account: it has uses beyond the retired hosted auth path."
  }

  assert {
    condition     = !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "*")
    error_message = "The WIF provider condition must not contain a repository wildcard."
  }

  assert {
    condition     = google_service_account_iam_member.agent_lcars_writer_impersonation.service_account_id == google_service_account.telemetry_writer.name && google_service_account_iam_member.agent_lcars_writer_impersonation.member == "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/jlapenna/agent-lcars" && google_service_account_iam_member.agent_lcars_writer_impersonation.role == "roles/iam.workloadIdentityUser"
    error_message = "Only jlapenna/agent-lcars may impersonate telemetry_writer over GitHub WIF (for work-session-expiry.yml)."
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
    condition     = google_firestore_index.sessions_source_last_activity.database == "(default)" && google_firestore_index.sessions_source_last_activity.collection == "sessions" && [for field in google_firestore_index.sessions_source_last_activity.fields : "${field.field_path}:${field.order}"] == ["source:ASCENDING", "lastActivityAt:ASCENDING"]
    error_message = "The owner query's CLI-session listing needs the sessions source+lastActivityAt composite index."
  }

  assert {
    condition     = google_firestore_index.sessions_source_repo_last_activity.database == "(default)" && google_firestore_index.sessions_source_repo_last_activity.collection == "sessions" && [for field in google_firestore_index.sessions_source_repo_last_activity.fields : "${field.field_path}:${field.order}"] == ["source:ASCENDING", "repo.owner:ASCENDING", "repo.name:ASCENDING", "lastActivityAt:ASCENDING"]
    error_message = "The owner query's per-repository CLI-session listing needs the sessions source+repo+lastActivityAt composite index."
  }

  # #2502: interactive sessions ask Console who owns an issue through a
  # dedicated reader identity. Only the maintainer's Google account may mint
  # its tokens, and nothing here may widen that to another principal.
  assert {
    condition     = google_service_account.work_reader.account_id == "work-reader" && google_service_account_iam_member.work_reader_token_creator.service_account_id == google_service_account.work_reader.name && google_service_account_iam_member.work_reader_token_creator.role == "roles/iam.serviceAccountTokenCreator" && google_service_account_iam_member.work_reader_token_creator.member == "user:jlapenna@gmail.com"
    error_message = "Only the maintainer's Google account may impersonate the read-only work-reader identity."
  }

  # #1350: one shared, READ-ONLY Claude subscription token. The absence of a
  # secretVersionAdder grant is the point - only a human writes - so assert
  # the identity holds exactly one role on exactly one secret and carries no
  # GitHub Actions WIF impersonation.
  assert {
    condition     = google_secret_manager_secret.claude_oauth.secret_id == "CLAUDE_CODE_OAUTH_TOKEN" && google_secret_manager_secret_iam_member.claude_oauth_accessor.role == "roles/secretmanager.secretAccessor" && google_secret_manager_secret_iam_member.claude_oauth_accessor.member == "serviceAccount:${google_service_account.claude_token_reader.email}"
    error_message = "The Claude subscription token must be one secret read by one dedicated read-only identity."
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
