locals {
  services = toset([
    "firebaseapphosting.googleapis.com", "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com", "cloudbuild.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com", "firebase.googleapis.com",
    "firestore.googleapis.com", "iam.googleapis.com",
    "iamcredentials.googleapis.com", "run.googleapis.com",
    "secretmanager.googleapis.com", "serviceusage.googleapis.com",
    "storage.googleapis.com", "sts.googleapis.com",
  ])
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
  domain_id       = "agent-console.supersprinkles.racing"
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

resource "google_storage_bucket" "tools" {
  name                        = "${var.project_id}-tools"
  location                    = "US"
  uniform_bucket_level_access = true
  versioning { enabled = true }
  depends_on = [google_project_service.services]
}

resource "google_storage_bucket_iam_member" "public_tools" {
  bucket = google_storage_bucket.tools.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_storage_bucket_iam_member" "deployer_tools" {
  bucket = google_storage_bucket.tools.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_service_account" "telemetry_writer" {
  account_id   = "telemetry-writer"
  display_name = "Agent LCARS telemetry writer"
}

resource "google_project_iam_member" "writer_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.telemetry_writer.email}"
}

resource "google_project_iam_member" "apphosting_firestore" {
  project    = var.project_id
  role       = "roles/datastore.viewer"
  member     = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
  depends_on = [google_firebase_project.this]
}

resource "google_storage_bucket_iam_member" "apphosting_transcripts" {
  bucket = google_storage_bucket.transcripts.name
  role   = "roles/storage.objectViewer"
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
  attribute_condition = "assertion.repository in ['${var.github_owner}/${var.github_repository}', '${var.github_owner}/supersprinklesracing']"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_service_account_iam_member" "github_impersonation" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${var.github_repository}"
}

resource "google_service_account_iam_member" "members_writer_impersonation" {
  service_account_id = google_service_account.telemetry_writer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/supersprinklesracing"
}

# This repo's own claude.yml now ships its issue-agent sessions' telemetry
# too (mirroring supersprinklesracing/members's ride-along wiring) - the WIF
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

resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(["AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AGENT_LCARS_GITHUB_TOKEN"])
  secret_id = each.value
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
