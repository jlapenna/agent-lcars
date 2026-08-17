output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "deployer_workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github_deployer.name }
output "deployer_service_account" { value = google_service_account.github_deployer.email }
output "github_app_webhook_configurator_service_account" { value = google_service_account.github_app_webhook_configurator.email }
output "github_app_webhook_configurator_workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github_app_webhook_configurator.name }
output "telemetry_writer_service_account" { value = google_service_account.telemetry_writer.email }
output "dispatch_firestore_database_id" { value = google_firestore_database.dispatch_controller.name }
output "transcript_bucket" { value = google_storage_bucket.transcripts.name }
output "quick_task_evidence_bucket" { value = google_storage_bucket.quick_task_evidence.name }
output "app_hosting_domain_dns_status" {
  description = "Firebase App Hosting's current DNS requirements for lcars.jlapenna.net; apply these in the homelab Cloudflare Terraform."
  value       = google_firebase_app_hosting_domain.production.custom_domain_status
}
