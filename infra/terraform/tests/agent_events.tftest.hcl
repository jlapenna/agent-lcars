mock_provider "google" {
  override_during = plan
  mock_resource "google_service_account" {
    defaults = {
      email = "agent-events-pike@agent-lcars.iam.gserviceaccount.com"
      name  = "projects/agent-lcars/serviceAccounts/agent-events-pike@agent-lcars.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_pubsub_subscription" {
    defaults = {
      id = "projects/agent-lcars/subscriptions/agent-events-pike"
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

run "each_host_receives_only_its_own_deliveries" {
  command = plan
  assert {
    condition = alltrue([
      for host in var.agent_event_delivery_hosts :
      google_pubsub_subscription.agent_events_host[host].filter == "attributes.host = \"${host}\""
    ])
    error_message = "Each host's subscription must be filtered to deliveries addressed to that host."
  }
  assert {
    condition = alltrue([
      for host in var.agent_event_delivery_hosts :
      google_pubsub_subscription.agent_events_host[host].name == "agent-events-${host}" &&
      google_service_account.agent_events_host[host].account_id == "agent-events-${host}"
    ])
    error_message = "Each host has its own subscription and its own delivery identity, both named for the host."
  }
  assert {
    condition = alltrue([
      for host in var.agent_event_delivery_hosts :
      google_pubsub_subscription.agent_events_host[host].message_retention_duration == "604800s" &&
      google_pubsub_subscription.agent_events_host[host].expiration_policy[0].ttl == "" &&
      google_pubsub_subscription.agent_events_host[host].enable_exactly_once_delivery
    ])
    error_message = "Host subscriptions must retain a week of deliveries, never expire while a host is offline, and deliver exactly once."
  }
}

run "each_host_identity_may_only_pull_its_own_subscription" {
  command = plan
  assert {
    condition = alltrue([
      for host in var.agent_event_delivery_hosts :
      google_pubsub_subscription_iam_member.agent_events_host_subscribes[host].role == "roles/pubsub.subscriber" &&
      google_pubsub_subscription_iam_member.agent_events_host_subscribes[host].subscription == google_pubsub_subscription.agent_events_host[host].id
    ])
    error_message = "A host's delivery identity may only subscribe, and only to its own subscription."
  }
  assert {
    condition     = google_pubsub_topic_iam_member.console_publishes_agent_events.role == "roles/pubsub.publisher"
    error_message = "The console may only publish deliveries."
  }
  assert {
    condition     = length(var.agent_event_delivery_hosts) == 4 && contains(var.agent_event_delivery_hosts, "pike")
    error_message = "The default delivery hosts are the four telemetry hosts."
  }
}

run "rejects_a_host_that_cannot_name_a_service_account" {
  command = plan
  variables {
    agent_event_delivery_hosts = ["Pike.lan"]
  }
  expect_failures = [var.agent_event_delivery_hosts]
}
