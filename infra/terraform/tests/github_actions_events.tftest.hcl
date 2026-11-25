mock_provider "google" {
  override_during = plan
  mock_resource "google_service_account" {
    defaults = {
      email = "github-actions-exporter@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/github-actions-exporter@agent-lcars.iam.gserviceaccount.com"
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
run "exporter_subscription_is_durable_and_least_privilege" {
  command = plan
  assert {
    condition = (
      google_pubsub_subscription.github_actions_exporter.message_retention_duration == "604800s" &&
      google_pubsub_subscription.github_actions_exporter.expiration_policy[0].ttl == ""
    )
    error_message = "The exporter subscription must retain a week of events and never expire while the exporter is down."
  }
  assert {
    condition = (
      google_pubsub_topic_iam_member.console_publishes_actions_events.role == "roles/pubsub.publisher" &&
      google_pubsub_subscription_iam_member.exporter_subscribes.role == "roles/pubsub.subscriber"
    )
    error_message = "The console may only publish and the exporter may only subscribe."
  }
}
