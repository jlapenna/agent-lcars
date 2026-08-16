locals {
  services = toset([
    "firebaseapphosting.googleapis.com", "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com", "cloudbuild.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com", "firebase.googleapis.com",
    "firestore.googleapis.com", "iam.googleapis.com",
    "iamcredentials.googleapis.com", "run.googleapis.com",
    "secretmanager.googleapis.com", "serviceusage.googleapis.com",
    "storage.googleapis.com", "sts.googleapis.com",
  ])
  github_repositories = [
    "${var.github_owner}/${var.github_repository}",
    var.sprinkles_repository,
    var.homelab_repository,
  ]
}

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_project_service" "services" {
  for_each           = local.services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_firebase_project" "this" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.services]
}

resource "google_firebase_app_hosting_domain" "production" {
  provider        = google-beta
  project         = var.project_id
  location        = var.region
  backend         = "agent-lcars"
  domain_id       = "lcars.jlapenna.net"
  deletion_policy = "ABANDON"
  depends_on      = [google_firebase_project.this]
}

resource "google_firestore_database" "default" {
  provider                = google-beta
  project                 = var.project_id
  name                    = "(default)"
  location_id             = "nam5"
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  depends_on              = [google_firebase_project.this]
}

# Controller state is isolated from worker telemetry at the Firestore database
# boundary. IAM Conditions below grant every runtime identity access to exactly
# one database; a worker-held telemetry credential can therefore never mutate
# dispatchTasks or dispatchLaunchOutbox.
resource "google_firestore_database" "dispatch_controller" {
  provider                = google-beta
  project                 = var.project_id
  name                    = "dispatch-controller"
  location_id             = "nam5"
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  depends_on              = [google_firebase_project.this]
}

resource "google_storage_bucket" "transcripts" {
  name                        = "${var.project_id}-session-transcripts"
  location                    = "US"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  lifecycle_rule {
    condition {
      age        = 90
      with_state = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.services]
}

resource "google_storage_bucket" "quick_task_evidence" {
  name                        = "${var.project_id}-quick-task-evidence"
  location                    = "US"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = false }
  soft_delete_policy { retention_duration_seconds = 0 }
  depends_on = [google_project_service.services]
}

resource "google_project_iam_custom_role" "quick_task_evidence_runtime" {
  role_id     = "quickTaskEvidenceRuntime"
  title       = "Quick Task evidence runtime"
  description = "Create, read, and delete immutable Quick Task evidence objects."
  permissions = [
    "storage.objects.create",
    "storage.objects.get",
    "storage.objects.delete",
  ]
}

resource "google_service_account" "telemetry_writer" {
  account_id   = "telemetry-writer"
  display_name = "Agent LCARS telemetry writer"
}

resource "google_project_iam_member" "writer_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.telemetry_writer.email}"
  condition {
    title       = "telemetry-default-database"
    description = "Telemetry writers cannot access dispatch-controller."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${google_firestore_database.default.name}\""
  }
}

# Worker preflight deliberately has no write permission. Agent code can mint
# this identity, so it must remain harmless even when fully compromised.
resource "google_service_account" "dispatch_preflight" {
  account_id   = "dispatch-preflight"
  display_name = "Agent LCARS dispatch preflight reader"
}

resource "google_project_iam_member" "dispatch_preflight_firestore" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${google_service_account.dispatch_preflight.email}"
  condition {
    title       = "dispatch-controller-reader"
    description = "Workers may verify bindings but cannot mutate controller state."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${google_firestore_database.dispatch_controller.name}\""
  }
}

resource "google_project_iam_member" "apphosting_firestore" {
  project    = var.project_id
  role       = "roles/datastore.viewer"
  member     = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
  depends_on = [google_firebase_project.this]
  condition {
    title       = "console-default-database-reader"
    description = "The console reads telemetry only; controller access is granted separately at hosted cutover."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${google_firestore_database.default.name}\""
  }
}

# The hosted controller is the only writer for dispatch state. Keep the grant
# at the dedicated database boundary; the console remains read-only in
# telemetry's default database above.
resource "google_project_iam_member" "apphosting_dispatch_controller" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
  depends_on = [
    google_firebase_project.this,
    google_firestore_database.dispatch_controller,
  ]
  condition {
    title       = "hosted-dispatch-controller-writer"
    description = "Hosted admission writes only the dispatch controller database."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${google_firestore_database.dispatch_controller.name}\""
  }
}

# GitHub's webhook response deadline is shorter than the controller's bounded
# lease wait. Admission therefore acknowledges only after a named Cloud Task
# durably owns the exact signed request; this queue retries broker processing.
resource "google_cloud_tasks_queue" "dispatch_webhooks" {
  project         = var.project_id
  location        = var.region
  name            = "dispatch-webhooks"
  deletion_policy = "ABANDON"

  rate_limits {
    max_concurrent_dispatches = 10
    max_dispatches_per_second = 10
  }

  retry_config {
    max_attempts       = 100
    max_retry_duration = "86400s"
    min_backoff        = "1s"
    max_backoff        = "60s"
    max_doublings      = 5
  }

  stackdriver_logging_config {
    sampling_ratio = 1
  }

  depends_on = [google_project_service.services]
}

resource "google_cloud_tasks_queue_iam_member" "apphosting_dispatch_webhooks_enqueuer" {
  project  = var.project_id
  location = google_cloud_tasks_queue.dispatch_webhooks.location
  name     = google_cloud_tasks_queue.dispatch_webhooks.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "apphosting_transcripts" {
  bucket = google_storage_bucket.transcripts.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "apphosting_quick_task_evidence" {
  bucket = google_storage_bucket.quick_task_evidence.name
  role   = google_project_iam_custom_role.quick_task_evidence_runtime.name
  member = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_secret_manager_secret_iam_member" "apphosting_secrets" {
  for_each  = google_secret_manager_secret.runtime
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "writer_transcripts" {
  bucket = google_storage_bucket.transcripts.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.telemetry_writer.email}"
}

resource "google_service_account" "github_deployer" {
  account_id   = "github-deployer"
  display_name = "Agent LCARS GitHub Actions deployer"
}

# Reads one HMAC secret while configuring the GitHub App hook. It has no
# project-level role and is reachable only from its exact reviewed main
# workflow through the dedicated pool below.
resource "google_service_account" "github_app_webhook_configurator" {
  account_id   = "github-app-webhook-config"
  display_name = "Agent LCARS GitHub App webhook configurator"
}

resource "google_secret_manager_secret_iam_member" "github_app_webhook_configurator" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime["AGENT_LCARS_WEBHOOK_SECRET"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.github_app_webhook_configurator.email}"
}

resource "google_project_iam_member" "deployer_roles" {
  for_each = toset([
    "roles/firebase.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/resourcemanager.projectIamAdmin",
    "roles/serviceusage.serviceUsageConsumer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository in [${join(", ", [for repository in local.github_repositories : "'${repository}'"])}]"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

# Privileged identities never trust the repository-wide pool. A separate pool
# is required (not merely another provider in the shared pool), because WIF
# service-account principals are pool-scoped and otherwise indistinguishable
# after token exchange.
resource "google_iam_workload_identity_pool" "github_deployer" {
  workload_identity_pool_id = "github-deployer"
  display_name              = "GitHub console deployer"
}

resource "google_iam_workload_identity_pool_provider" "github_deployer" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_deployer.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub deploy-console main"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository == '${var.github_owner}/${var.github_repository}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${var.github_owner}/${var.github_repository}/.github/workflows/deploy-console.yml@refs/heads/main'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_iam_workload_identity_pool" "github_app_webhook_configurator" {
  workload_identity_pool_id = "github-app-webhook-config"
  display_name              = "GitHub App webhook config"
}

resource "google_iam_workload_identity_pool_provider" "github_app_webhook_configurator" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_app_webhook_configurator.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub App webhook config main"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository == '${var.github_owner}/${var.github_repository}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${var.github_owner}/${var.github_repository}/.github/workflows/configure-github-app-webhook.yml@refs/heads/main'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_service_account_iam_member" "github_deployer_impersonation" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_deployer.name}/attribute.repository/${var.github_owner}/${var.github_repository}"
}

resource "google_service_account_iam_member" "github_app_webhook_configurator_impersonation" {
  service_account_id = google_service_account.github_app_webhook_configurator.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_app_webhook_configurator.name}/attribute.repository/${var.github_owner}/${var.github_repository}"
}

resource "google_service_account_iam_member" "members_writer_impersonation" {
  service_account_id = google_service_account.telemetry_writer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.sprinkles_repository}"
}

resource "google_service_account_iam_member" "dispatch_preflight_impersonation" {
  service_account_id = google_service_account.dispatch_preflight.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${var.github_repository}"
}

# This repo's own claude.yml now ships its issue-agent sessions' telemetry
# too (mirroring supersprinklesracing/sprinkles's sidecar wiring) - the WIF
# provider's attribute_condition above already trusts
# ${var.github_owner}/${var.github_repository} (this repo) for OIDC token
# issuance, but that alone doesn't grant impersonation of any specific SA;
# this is the matching grant on telemetry_writer, parallel to
# members_writer_impersonation above.
resource "google_service_account_iam_member" "agent_lcars_writer_impersonation" {
  service_account_id = google_service_account.telemetry_writer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${var.github_repository}"
}

resource "google_service_account_iam_member" "homelab_writer_impersonation" {
  service_account_id = google_service_account.telemetry_writer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.homelab_repository}"
}

resource "google_secret_manager_secret" "runtime" {
  for_each = toset([
    "AUTH_SECRET",
    "AUTH_GITHUB_ID",
    "AUTH_GITHUB_SECRET",
    "AGENT_LCARS_GITHUB_TOKEN",
    "AGENT_LCARS_WEBHOOK_SECRET",
  ])
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# Playwright storage state for the dedicated production verification identity.
# This is a tooling credential, not an App Hosting runtime secret: a maintainer
# mints/rotates its VALUE with `console:mint-session`, while the headless Codex
# identity receives read access to this container only. In particular, it must
# never receive access to AUTH_SECRET, which is what makes minting possible.
resource "google_secret_manager_secret" "admin_storage_state" {
  secret_id = "AGENT_LCARS_ADMIN_STORAGE_STATE"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret" "telemetry_writer_key" {
  secret_id = "AGENT_TELEMETRY_WRITER_KEY_JSON"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# Write credential for the self-hosted Nx remote cache on spark. Terraform
# owns the container; the VALUE is minted by hand with `openssl rand -hex 32`
# on the cache host and copied here with `gcloud secrets versions add`, the
# same split used by codex_auth below.
#
# This is the second of the two sources tools/setup-nx-remote-cache.sh tries,
# and it exists for the case the first cannot serve: a run outside the
# maintainer's home directory, which has workload identity but no age key.
# See docs/nx-remote-cache.md.
#
# The lowercase-hyphen secret_id is deliberate and must match what that script
# and sprinkles' tools/setup-repo.sh look up. It is the same credential and
# the same name in both repos' projects; the cache server holds exactly one
# write token fleet-wide (homelab#500 tracks making that per-consumer).
resource "google_secret_manager_secret" "nx_cache_access_token" {
  secret_id = "nx-cache-access-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# The agent jobs are the only identities that reach this from CI, and both
# already receive the same token through the NX_CACHE_TOKEN Actions secret,
# so granting read here widens no blast radius -- it only lets a job that
# runs the setup script resolve the credential the same way a workstation
# does. Scoped to this one secret rather than a project-level role, for the
# reason spelled out on codex_auth_accessor below.
resource "google_secret_manager_secret_iam_member" "nx_cache_access_token_accessor" {
  for_each = toset([
    google_service_account.codex_agent.email,
    google_service_account.dispatch_preflight.email,
  ])
  secret_id = google_secret_manager_secret.nx_cache_access_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}"
}

# codex.yml's ChatGPT subscription credential (issue #47). Terraform owns
# the container; the VALUE is minted by hand (`codex login` on a
# workstation, then `gcloud secrets versions add`) and never lives in this
# repo or in GitHub Actions secrets.
#
# Unlike every other secret here this one ROTATES: Codex refreshes the
# token during a run, and codex.yml writes the refreshed blob back as a new
# version. That write access is why this needs its own service account
# rather than reusing telemetry_writer or github_deployer.
resource "google_secret_manager_secret" "codex_auth" {
  secret_id = "CODEX_AUTH_JSON"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_service_account" "codex_agent" {
  account_id   = "codex-agent"
  display_name = "Agent LCARS Codex issue agent"
}

# Deliberately read-only and scoped to the minted browser session alone. The
# agent can reuse the bearer credential for approved production UI checks but
# cannot mint one, rotate it, or read the Auth.js key that signs all sessions.
resource "google_secret_manager_secret_iam_member" "admin_storage_state_accessor" {
  secret_id = google_secret_manager_secret.admin_storage_state.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.codex_agent.email}"
}

# Deliberately scoped to this ONE secret, not a project-level role.
# codex.yml lets google-github-actions/auth export ambient ADC for this
# identity (the `gcloud secrets` calls need it), which means agent-authored
# code running in that job can reach whatever this SA can reach. Granting
# it exactly the subscription credential it already handles - and nothing
# else in the project - is what keeps that blast radius equal to the
# credential itself.
resource "google_secret_manager_secret_iam_member" "codex_auth_accessor" {
  secret_id = google_secret_manager_secret.codex_auth.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.codex_agent.email}"
}

# secretVersionAdder, NOT secretAdmin: the run must be able to append a
# refreshed version, never to delete/disable prior ones. A bad refresh
# should be recoverable by pinning an earlier version.
resource "google_secret_manager_secret_iam_member" "codex_auth_version_adder" {
  secret_id = google_secret_manager_secret.codex_auth.id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.codex_agent.email}"
}

resource "google_service_account_iam_member" "codex_agent_impersonation" {
  service_account_id = google_service_account.codex_agent.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${var.github_repository}"
}

# Codex rotates its subscription credential on every run. GitHub Actions
# concurrency is repository-local, so Homelab must not share Agent LCARS's
# service account or CODEX_AUTH_JSON secret: overlapping runs could restore the
# same version and persist mutually invalid refreshes.
resource "google_secret_manager_secret" "homelab_codex_auth" {
  secret_id = "HOMELAB_CODEX_AUTH_JSON"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_service_account" "homelab_codex_agent" {
  account_id   = "homelab-codex-agent"
  display_name = "Homelab Codex issue agent"
}

resource "google_secret_manager_secret_iam_member" "homelab_codex_auth_accessor" {
  secret_id = google_secret_manager_secret.homelab_codex_auth.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.homelab_codex_agent.email}"
}

resource "google_secret_manager_secret_iam_member" "homelab_codex_auth_version_adder" {
  secret_id = google_secret_manager_secret.homelab_codex_auth.id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.homelab_codex_agent.email}"
}

resource "google_service_account_iam_member" "homelab_codex_agent_impersonation" {
  service_account_id = google_service_account.homelab_codex_agent.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.homelab_repository}"
}

# Per-repo GitHub App installation tokens for the orchestrator drain (#1204,
# enabling the dormant `DispatchTokenProvider` seam #1197 shipped). Terraform
# owns the container only - there is no value here, and none belongs in this
# repo or in GitHub Actions secrets. A maintainer populates it by hand, once
# a dedicated App private key exists (kept a separate lineage from the
# Actions-secrets one on purpose):
#
#   gcloud secrets versions add AGENT_LCARS_APP_PRIVATE_KEY --data-file=<key.pem>
#
# apphosting.yaml is deliberately left unwired here - an empty secret would
# break deploys. Wiring AGENT_LCARS_APP_CLIENT_ID (plain var) and this secret
# into apphosting.yaml is a follow-up PR, after the value above exists.
resource "google_secret_manager_secret" "agent_lcars_app_private_key" {
  secret_id = "AGENT_LCARS_APP_PRIVATE_KEY"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# Scoped to this ONE secret rather than folded into the apphosting_secrets
# for_each above: that for_each mirrors google_secret_manager_secret.runtime,
# which apphosting.yaml wires as env vars today, and this secret is
# deliberately not wired yet (see comment above). Same grant shape
# apphosting_secrets uses for AGENT_LCARS_GITHUB_TOKEN (project + secret_id +
# secretAccessor on the App Hosting compute SA); the wiring follow-up can
# fold this into that for_each once apphosting.yaml references it.
resource "google_secret_manager_secret_iam_member" "agent_lcars_app_private_key_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.agent_lcars_app_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account
  display_name    = "Agent LCARS monthly budget"
  budget_filter { projects = ["projects/${data.google_project.this.number}"] }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = "5"
    }
  }
  dynamic "threshold_rules" {
    for_each = toset([0.5, 0.9, 1.0])
    content { threshold_percent = threshold_rules.value }
  }
  depends_on = [google_project_service.services]
}
