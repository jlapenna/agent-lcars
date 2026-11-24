# GitHub Actions events for the Homelab GitHub Actions exporter (#3525).
#
# The console verifies each `workflow_job` and `workflow_run` App webhook and
# publishes its raw body here. The exporter on the Homelab LAN holds a
# streaming-pull subscription, so it receives events as GitHub sends them
# instead of polling the REST API. The LAN has no public inbound path; the
# subscription's retention covers exporter downtime, and GitHub's webhook
# delivery log covers deliveries the console failed to accept.

resource "google_pubsub_topic" "github_actions_events" {
  name                       = "github-actions-events"
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.services]
}

resource "google_pubsub_subscription" "github_actions_exporter" {
  name                       = "github-actions-exporter"
  topic                      = google_pubsub_topic.github_actions_events.id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  # A subscription with no subscriber for its TTL is deleted by default; the
  # exporter may be down for longer, so this one never expires.
  expiration_policy {
    ttl = ""
  }
}

# The console's App Hosting runtime identity publishes verified deliveries.
resource "google_pubsub_topic_iam_member" "console_publishes_actions_events" {
  topic      = google_pubsub_topic.github_actions_events.id
  role       = "roles/pubsub.publisher"
  member     = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
  depends_on = [google_firebase_project.this]
}

# The exporter runs outside GitHub Actions, so it has no OIDC identity to
# federate and uses a user-managed key (allowlisted in
# tools/iam-contract/model.json), minted straight into the Homelab vault.
resource "google_service_account" "github_actions_exporter" {
  account_id   = "github-actions-exporter"
  display_name = "GitHub Actions exporter event subscriber"
}

resource "google_pubsub_subscription_iam_member" "exporter_subscribes" {
  subscription = google_pubsub_subscription.github_actions_exporter.id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.github_actions_exporter.email}"
}

output "github_actions_events_topic" { value = google_pubsub_topic.github_actions_events.id }
output "github_actions_exporter_subscription" { value = google_pubsub_subscription.github_actions_exporter.id }
output "github_actions_exporter_service_account" { value = google_service_account.github_actions_exporter.email }
