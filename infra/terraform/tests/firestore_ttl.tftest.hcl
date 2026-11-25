mock_provider "google" {
  override_during = plan
}
mock_provider "google-beta" {
  override_during = plan
}
variables {
  billing_account = "000000-000000-000000"
  alert_email     = "test@example.com"
}

run "expiring_telemetry_has_ttl_policies" {
  command = plan
  assert {
    condition = (
      google_firestore_field.sessions_expire_at_ttl.collection == "sessions" &&
      google_firestore_field.sessions_expire_at_ttl.field == "expireAt" &&
      length(google_firestore_field.sessions_expire_at_ttl.ttl_config) == 1
    )
    error_message = "Sessions must be deleted by Firestore TTL once their expireAt passes."
  }
  assert {
    condition = (
      google_firestore_field.runner_status_expire_at_ttl.collection == "runner-status" &&
      google_firestore_field.runner_status_expire_at_ttl.field == "expireAt" &&
      length(google_firestore_field.runner_status_expire_at_ttl.ttl_config) == 1
    )
    error_message = "Retired runner-status snapshots must be deleted by Firestore TTL once their expireAt passes."
  }
  assert {
    condition = (
      length(google_firestore_field.sessions_expire_at_ttl.index_config) == 0 &&
      length(google_firestore_field.runner_status_expire_at_ttl.index_config) == 0
    )
    error_message = "The TTL fields must keep their automatic single-field indexes."
  }
}
