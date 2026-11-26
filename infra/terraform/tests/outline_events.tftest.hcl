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
mock_provider "github" {
  override_during = plan
}
variables {
  billing_account = "000000-000000-000000"
  alert_email     = "test@example.com"
}
run "outline_source_receipts_expire_in_the_dispatch_database" {
  command = plan
  assert {
    condition = alltrue([
      for collection, policy in google_firestore_field.outline_event_expiry :
      policy.database == google_firestore_database.dispatch_controller.name &&
      policy.collection == collection &&
      policy.field == "expiresAt" && length(policy.ttl_config) == 1
    ])
    error_message = "Outline source and delivery receipts must expire after the host replay window, in the isolated dispatch database."
  }
}
