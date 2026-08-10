# Agent LCARS infrastructure

Terraform owns the project services, default Firestore database, transcript
bucket, runtime secret containers, service accounts, GitHub Workload Identity
Federation, and the $5/month billing budget. Secret _values_ are never stored
in Terraform state.

Bootstrap state once with `gcloud storage buckets create
gs://agent-lcars-terraform-state --project agent-lcars --location us`, then add
a GCS backend and run `terraform init -migrate-state`. Supply the billing account
as `TF_VAR_billing_account`.

Firebase App Hosting's GitHub connection remains an explicit bootstrap action:
run `firebase apphosting:backends:create --project agent-lcars` and select
`jlapenna/agent-lcars`, root `apps/console`, backend id `agent-lcars`, and region
`us-central1`. Thereafter pushes to `main` deploy through App Hosting.

## Custom domain DNS handoff

Terraform owns the App Hosting association for `lcars.jlapenna.net`; the public
`jlapenna.net` zone is owned separately by the `jlapenna/homelab` Terraform
configuration. Firebase generates the exact DNS records for each domain after
the App Hosting resource exists, so do not guess a CNAME target or point this
name at the homelab Caddy proxy. After an approved apply creates or updates the
domain resource, obtain its current desired records with:

```sh
terraform -chdir=infra/terraform output -json app_hosting_domain_dns_status
```

Apply every requested add or removal verbatim in
`jlapenna/homelab`'s `terraform/cloudflare_dns.tf`, keeping Cloudflare DNS-only
(`proxied = false`). The App Hosting backend will report the domain as connected
only after those records propagate and its certificate becomes active.
