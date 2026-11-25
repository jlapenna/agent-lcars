# Event deliveries to agents (#3538, #3568).
#
# The console's router publishes one message per delivery to this topic, with
# the target host as the `host` attribute. Each workstation that runs agents
# has its own subscription, filtered to its host, and its own service account
# that may pull only that subscription. The delivery agent on the host holds a
# streaming pull, so the host needs no inbound path, and the subscription's
# retention covers the host being offline.

variable "agent_event_delivery_hosts" {
  description = "Workstations that run agents and receive event deliveries: the Agent LCARS telemetry hosts homegit installs the lcars CLI on."
  type        = set(string)
  default     = ["homelab", "laforge", "laptop", "pike"]
  validation {
    condition = alltrue([
      for host in var.agent_event_delivery_hosts :
      can(regex("^[a-z][a-z0-9-]{0,16}$", host))
    ])
    error_message = "each host must be a short lowercase hostname, so agent-events-<host> is a valid service account id."
  }
}

resource "google_pubsub_topic" "agent_event_deliveries" {
  name                       = "agent-event-deliveries"
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.services]
}

resource "google_pubsub_subscription" "agent_events_host" {
  for_each = var.agent_event_delivery_hosts

  name   = "agent-events-${each.key}"
  topic  = google_pubsub_topic.agent_event_deliveries.id
  filter = "attributes.host = \"${each.key}\""

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  # The delivery agent drops a repeat by delivery id as well; exactly-once
  # keeps an acked notice from being redelivered and typed twice.
  enable_exactly_once_delivery = true
  # A laptop can be off for longer than the default 31-day TTL.
  expiration_policy {
    ttl = ""
  }
}

# The console's App Hosting runtime identity publishes deliveries.
resource "google_pubsub_topic_iam_member" "console_publishes_agent_events" {
  topic      = google_pubsub_topic.agent_event_deliveries.id
  role       = "roles/pubsub.publisher"
  member     = "serviceAccount:firebase-app-hosting-compute@${var.project_id}.iam.gserviceaccount.com"
  depends_on = [google_firebase_project.this]
}

# A workstation runs outside GitHub Actions and has no OIDC identity to
# federate, so each delivery agent uses a user-managed key (allowlisted in
# tools/iam-contract/model.json), minted straight into the Homelab vault.
resource "google_service_account" "agent_events_host" {
  for_each = var.agent_event_delivery_hosts

  account_id   = "agent-events-${each.key}"
  display_name = "Agent event delivery on ${each.key}"
}

resource "google_pubsub_subscription_iam_member" "agent_events_host_subscribes" {
  for_each = var.agent_event_delivery_hosts

  subscription = google_pubsub_subscription.agent_events_host[each.key].id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.agent_events_host[each.key].email}"
}

output "agent_event_deliveries_topic" { value = google_pubsub_topic.agent_event_deliveries.id }
output "agent_event_host_subscriptions" {
  value = { for host, subscription in google_pubsub_subscription.agent_events_host : host => subscription.id }
}
output "agent_event_host_service_accounts" {
  value = { for host, account in google_service_account.agent_events_host : host => account.email }
}
