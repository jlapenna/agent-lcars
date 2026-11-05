# LCARS job credentials are application data. This project has no homegit or
# Homelab secret-store integration. Terraform provisions containers, never values.
variable "job_secrets_project_id" {
  type    = string
  default = "homeforjla-169908"
  validation {
    condition     = var.job_secrets_project_id != var.project_id && can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.job_secrets_project_id))
    error_message = "Job credentials require a separate, valid Google project."
  }
}

variable "job_secret_names" {
  type = set(string)
  # skill-evals-*: the `skill-evals` credential set (Claude token for
  # `claude plugin eval`, and an rclone profile for the dedicated LCARS-jobs
  # Garage key that archives eval history).
  default = ["github-jlapenna", "skill-evals-claude-token", "skill-evals-garage-rclone"]
  validation {
    condition     = alltrue([for name in var.job_secret_names : can(regex("^[a-z][a-z0-9-]{0,63}$", name))])
    error_message = "Job secret names must be lowercase LCARS logical identifiers."
  }
}

# Reuse the existing billed project; LCARS owns only its job-secret resources.
# Retain the former empty project without deleting it or changing its billing.
removed {
  from = google_project.job_secrets
  lifecycle { destroy = false }
}

data "google_project" "job_secrets" {
  project_id = var.job_secrets_project_id
}

resource "google_project_service" "job_secret_services" {
  for_each           = toset(["secretmanager.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com"])
  project            = data.google_project.job_secrets.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_project_iam_audit_config" "job_secret_reads" {
  project = data.google_project.job_secrets.project_id
  service = "secretmanager.googleapis.com"
  audit_log_config { log_type = "DATA_READ" }
  audit_log_config { log_type = "DATA_WRITE" }
}

resource "google_service_account" "job_secret_writer" {
  project      = data.google_project.job_secrets.project_id
  account_id   = "job-secret-writer"
  display_name = "LCARS job secret version uploader"
  depends_on   = [google_project_service.job_secret_services]
}

resource "google_service_account_iam_member" "job_secret_writer_impersonation" {
  service_account_id = google_service_account.job_secret_writer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_secret_manager_secret" "job_credentials" {
  for_each            = var.job_secret_names
  project             = data.google_project.job_secrets.project_id
  secret_id           = each.value
  labels              = { application = "lcars-job-secrets" }
  version_destroy_ttl = "2592000s"
  deletion_protection = true
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.job_secret_services]
}

resource "google_secret_manager_secret_iam_member" "job_runtime_read" {
  for_each  = google_secret_manager_secret.job_credentials
  project   = each.value.project
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_secret_manager_secret_iam_member" "job_runtime_metadata" {
  for_each  = google_secret_manager_secret.job_credentials
  project   = each.value.project
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.viewer"
  member    = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_secret_manager_secret_iam_member" "job_writer_versions" {
  for_each  = google_secret_manager_secret.job_credentials
  project   = each.value.project
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.job_secret_writer.email}"
}

# This account has no Google resource access. Its Google ID token resolves to
# the Console's narrowly declared secrets.admin grant, for protected-stdin CLI.
resource "google_service_account" "job_secret_operator" {
  account_id   = "job-secret-operator"
  display_name = "LCARS secret administration API caller"
}
resource "google_service_account_iam_member" "job_secret_operator_impersonation" {
  service_account_id = google_service_account.job_secret_operator.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "user:jlapenna@gmail.com"
}

output "job_secrets_project" { value = data.google_project.job_secrets.project_id }
output "job_secrets_writer" { value = google_service_account.job_secret_writer.email }
output "job_secrets_operator" { value = google_service_account.job_secret_operator.email }
