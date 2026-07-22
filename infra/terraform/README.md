# Agent LCARS infrastructure

Terraform owns the project services, default Firestore database, transcript and
tool buckets, runtime secret containers, service accounts, GitHub Workload
Identity Federation, and the $5/month billing budget. Secret _values_ are never
stored in Terraform state.

Bootstrap state once with `gcloud storage buckets create
gs://agent-lcars-terraform-state --project agent-lcars --location us`, then add
a GCS backend and run `terraform init -migrate-state`. Supply the billing account
as `TF_VAR_billing_account`.

Firebase App Hosting's GitHub connection remains an explicit bootstrap action:
run `firebase apphosting:backends:create --project agent-lcars` and select
`jlapenna/agent-lcars`, root `apps/console`, backend id `agent-lcars`, and region
`us-central1`. Thereafter pushes to `main` deploy through App Hosting.
