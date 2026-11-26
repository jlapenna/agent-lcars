# Signed source metadata and delivery receipts are retained beyond the host
# subscription's seven-day retention, then deleted. Creator attestations are
# immutable ownership metadata, not a duplicate terminal registry.
resource "google_firestore_field" "outline_event_expiry" {
  for_each = toset(["outlineAgentNotices", "outlineAgentReceipts"])

  project    = var.project_id
  database   = google_firestore_database.dispatch_controller.name
  collection = each.value
  field      = "expiresAt"
  ttl_config {}
}
