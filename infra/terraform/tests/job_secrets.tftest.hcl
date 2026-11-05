mock_provider "google" {
  override_during = plan
  mock_resource "google_service_account" {
    defaults = {
      email = "mock-service-account@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/mock-service-account@agent-lcars.iam.gserviceaccount.com"
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
run "isolates_job_credentials_and_separates_read_from_upload" {
  command = plan
  assert {
    condition     = google_project.job_secrets.project_id != var.project_id && google_project.job_secrets.deletion_policy == "PREVENT"
    error_message = "Job secrets must have a separate protected project."
  }
  assert {
    condition = (
      google_secret_manager_secret.job_credentials["github-jlapenna"].project == google_project.job_secrets.project_id &&
      google_secret_manager_secret.job_credentials["github-jlapenna"].deletion_protection &&
      google_secret_manager_secret.job_credentials["github-jlapenna"].version_destroy_ttl == "2592000s"
    )
    error_message = "Job credentials require isolated containers and recovery protection."
  }
  assert {
    condition = (
      google_secret_manager_secret_iam_member.job_runtime_read["github-jlapenna"].role == "roles/secretmanager.secretAccessor" &&
      google_secret_manager_secret_iam_member.job_writer_versions["github-jlapenna"].role == "roles/secretmanager.secretVersionAdder" &&
      google_service_account.job_secret_writer.project == google_project.job_secrets.project_id
    )
    error_message = "Job readers and version uploaders must retain separate least-privilege roles."
  }
}
