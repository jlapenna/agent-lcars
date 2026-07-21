output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "deployer_service_account" { value = google_service_account.github_deployer.email }
output "telemetry_writer_service_account" { value = google_service_account.telemetry_writer.email }
output "transcript_bucket" { value = google_storage_bucket.transcripts.name }
output "tools_bucket" { value = google_storage_bucket.tools.name }
