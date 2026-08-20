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
  github_repositories = concat([
    "${var.github_owner}/${var.github_repository}",
    var.sprinkles_repository,
    var.homelab_repository,
  ], var.additional_fleet_repositories)
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

# Codex refreshes the subscription credential during an agent run.  The
# current Secret Manager lineage remains the rollback path until the fleet
# has been seeded and the lane is cut over, but it cannot safely be the
# durable writer: version adds are not conditional.  This bucket is the
# additive Phase 1 destination.  Each repository receives one object and
# can replace it only through the object's generation precondition.
resource "google_storage_bucket" "codex_auth" {
  name                        = "${var.project_id}-codex-auth"
  location                    = "US"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  soft_delete_policy { retention_duration_seconds = 0 }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.services]
}

resource "google_project_iam_custom_role" "codex_auth_runtime" {
  role_id     = "codexAuthRuntime"
  title       = "Codex auth runtime"
  description = "Read and generation-CAS replace the repository's Codex auth object."
  permissions = [
    "storage.objects.create",
    "storage.objects.get",
    "storage.objects.delete",
  ]
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
  # #1284: AGENT_LCARS_GITHUB_TOKEN's container is retired here (the console
  # runtime no longer references it - see apps/console/apphosting.yaml and
  # apps/console/src/lib/github-{client,app-tokens}.ts, both now on
  # AGENT_LCARS_APP_CLIENT_ID/AGENT_LCARS_APP_PRIVATE_KEY for every request).
  # Removing this container also drops its
  # google_secret_manager_secret_iam_member.apphosting_secrets grant below,
  # since that resource's for_each mirrors this one. This does NOT delete the
  # secret's stored VALUE or revoke the classic PAT it holds - Terraform owns
  # secret containers, never secret values (see AGENTS.md's guardrails), and
  # revocation must happen only after a maintainer verifies the App-token
  # cutover live (reads, a mutation, and home-repo dispatch). That is
  # deliberately left as manual maintainer cleanup, not part of this PR/apply.
  for_each = toset([
    "AUTH_SECRET",
    "AUTH_GITHUB_ID",
    "AUTH_GITHUB_SECRET",
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
# on the cache host and copied here with `gcloud secrets versions add`.
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
  ])
  secret_id = google_secret_manager_secret.nx_cache_access_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}"
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

# The fleet's ONE Claude subscription token (#1350). Terraform owns the
# container only - the value is minted by the maintainer
# (`claude setup-token`) and published with
# `gcloud secrets versions add CLAUDE_CODE_OAUTH_TOKEN --data-file=-`. It
# never lives in this repo or in a GitHub Actions secret.
#
# Contrast Codex authentication, which uses a repository-scoped GCS object
# with generation-CAS because it rotates on every run. This
# credential never rotates - `claude setup-token` mints it once and nothing
# writes it back - so a single shared, read-only copy is safe fleet-wide,
# and there is deliberately NO secretVersionAdder grant below. The lane
# reads; only a human writes.
resource "google_secret_manager_secret" "claude_oauth" {
  secret_id = "CLAUDE_CODE_OAUTH_TOKEN"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# Its own identity rather than codex_agent or telemetry_writer: this one is
# read-only, holds nothing but accessor on the single secret below, and -
# unlike codex_agent - is never exported as ambient ADC into the agent's
# shell (agent-lane.yml scopes the credential file to the one step that
# reads the secret). Blast radius is exactly the Claude token.
resource "google_service_account" "claude_token_reader" {
  account_id   = "claude-token-reader"
  display_name = "Claude lane subscription-token reader"
}

resource "google_secret_manager_secret_iam_member" "claude_oauth_accessor" {
  secret_id = google_secret_manager_secret.claude_oauth.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.claude_token_reader.email}"
}

# Every fleet repo may impersonate the reader, because every fleet repo may
# run the claude lane. The pool's own attribute_condition is what bounds
# this to the repositories in local.github_repositories.
resource "google_service_account_iam_member" "claude_token_reader_impersonation" {
  for_each           = toset(local.github_repositories)
  service_account_id = google_service_account.claude_token_reader.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${each.value}"
}

resource "google_service_account_iam_member" "codex_agent_impersonation" {
  service_account_id = google_service_account.codex_agent.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${var.github_repository}"
}

resource "google_service_account" "homelab_codex_agent" {
  account_id   = "homelab-codex-agent"
  display_name = "Homelab Codex issue agent"
}

# The 2026-08 fleet additions (#1354). Each repo gets its own identity because
# its GCS auth object is repository-scoped and generation-CAS protected.
#
# Project agent-lcars for all four, including the two supersprinklesracing
# repos (#1354): the shared `github` pool that admits them lives here, a
# WIF-impersonated service account must live in the pool's project, and one
# control plane beats matching each repo's owning org. This settles the
# convention fleet-credentials.md flagged as unmade.
locals {
  fleet_codex_agents = {
    "supersprinklesracing/www"    = { slug = "www" }
    "supersprinklesracing/girosf" = { slug = "girosf" }
    "jlapenna/nx-cache-server"    = { slug = "nx-cache-server" }
    "jlapenna/sync-padd"          = { slug = "sync-padd" }
  }
}

resource "google_service_account" "fleet_codex_agent" {
  for_each     = local.fleet_codex_agents
  account_id   = "${each.value.slug}-codex-agent"
  display_name = "${each.key} Codex issue agent"
}


resource "google_service_account_iam_member" "fleet_codex_agent_impersonation" {
  for_each           = local.fleet_codex_agents
  service_account_id = google_service_account.fleet_codex_agent[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${each.key}"
}

resource "google_service_account_iam_member" "homelab_codex_agent_impersonation" {
  service_account_id = google_service_account.homelab_codex_agent.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.homelab_repository}"
}

# Phase 1 grants the existing per-repository Codex identities only the three
# operations GCS needs for a conditional overwrite.  The condition is the
# security boundary: an agent may never list, read, or replace another
# repository's credential object.
locals {
  codex_auth_runtime_identities = merge(
    {
      "jlapenna/agent-lcars" = google_service_account.codex_agent.email
      "jlapenna/homelab"     = google_service_account.homelab_codex_agent.email
      # Sprinkles authenticates through its own WIF pool in the
      # supersprinklesracing project, so it has no agent-lcars service
      # account to derive here. Its conditional bucket grant is still
      # confined to this one repository prefix.
      "supersprinklesracing/sprinkles" = "claude-agent-readonly@supersprinklesracing.iam.gserviceaccount.com"
    },
    { for repository, agent in google_service_account.fleet_codex_agent : repository => agent.email },
  )
}

resource "google_storage_bucket_iam_member" "codex_auth_runtime" {
  for_each = local.codex_auth_runtime_identities

  bucket = google_storage_bucket.codex_auth.name
  role   = google_project_iam_custom_role.codex_auth_runtime.name
  member = "serviceAccount:${each.value}"
  condition {
    title       = "${replace(each.key, "/", "-")}-codex-auth"
    description = "Confines the Codex agent to its own auth.json object."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.codex_auth.name}/objects/${each.key}/\")"
  }
}

# Per-repo GitHub App installation tokens for the orchestrator drain (#1204,
# enabling the dormant `DispatchTokenProvider` seam #1197 shipped; #1245
# wired AGENT_LCARS_APP_CLIENT_ID and this secret into apphosting.yaml, live
# since 2026-08-16). Terraform owns the container only - there is no value
# here, and none belongs in this repo or in GitHub Actions secrets. A
# maintainer populates it by hand with the fleet App's private key. This is
# the SAME App and the SAME key the repos' AGENT_LCARS_PRIVATE_KEY Actions
# secrets carry -- this secret is canonical and those are fan-out copies of
# it (#1340 D3 verified that by minting an App JWT from this value: GET /app
# returns app id 4457090, client Iv23liO6X8pLJLcTFzyv). An earlier revision
# of this comment called the two "a separate lineage on purpose"; that was
# the pre-population intent and never what shipped. docs/fleet-credentials.md
# holds the rotation procedure, including the mandatory fan-out loop:
#
#   gcloud secrets versions add AGENT_LCARS_APP_PRIVATE_KEY --data-file=<key.pem>
#
# <key.pem> may be either PEM format GitHub hands you: PKCS1
# (`-----BEGIN RSA PRIVATE KEY-----`, what the App settings page's "Generate
# a private key" button downloads) or PKCS8 (`-----BEGIN PRIVATE KEY-----`).
# github-app-tokens.ts's `parsePrivateKey` accepts both directly (#1276) -- no
# conversion needed before upload.
resource "google_secret_manager_secret" "agent_lcars_app_private_key" {
  secret_id = "AGENT_LCARS_APP_PRIVATE_KEY"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# Scoped to this ONE secret rather than folded into the apphosting_secrets
# for_each above: that for_each mirrors google_secret_manager_secret.runtime,
# which apphosting.yaml wires as env vars today, and this secret was added
# before apphosting.yaml referenced it. Now that #1245 has wired it in, this
# could be folded into that for_each; kept separate here since nothing else
# requires the refactor. Same grant shape apphosting_secrets uses for e.g.
# AUTH_SECRET (project + secret_id + secretAccessor on the App Hosting
# compute SA).
resource "google_secret_manager_secret_iam_member" "agent_lcars_app_private_key_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.agent_lcars_app_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

# The App Hosting BUILD preparer resolves every apphosting.yaml secret
# reference at rollout time and needs secret METADATA access
# (secretmanager.versions.get, in roles/secretmanager.viewer) on top of the
# runtime accessor above; without it every rollout fails at the preparer with
# fah/misconfigured-secret (observed live 2026-08-16 after #1245 wired this
# secret). The older App Hosting secrets carry the same pair of grants, but
# theirs were made out-of-band by `firebase apphosting:secrets:grantaccess`;
# this one is codified here instead.
resource "google_secret_manager_secret_iam_member" "agent_lcars_app_private_key_viewer" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.agent_lcars_app_private_key.secret_id
  role      = "roles/secretmanager.viewer"
  member    = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_secret_manager_secret_iam_member" "agent_lcars_app_private_key_version_manager" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.agent_lcars_app_private_key.secret_id
  role      = "roles/secretmanager.secretVersionManager"
  member    = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-firebaseapphosting.iam.gserviceaccount.com"
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
