# Agent LCARS infrastructure

Terraform owns the project services, default Firestore database, transcript
bucket, runtime secret containers, service accounts, GitHub Workload Identity
Federation, and the $5/month billing budget. Secret _values_ are never stored
in Terraform state. (The `Protect main` repository ruleset moved to the
homelab repo's terraform root — see the GitHub ruleset section below.)

Bootstrap state once with `gcloud storage buckets create
gs://agent-lcars-terraform-state --project agent-lcars --location us`, then add
a GCS backend and run `terraform init -migrate-state`. Supply the billing account
as `TF_VAR_billing_account`.

Firebase App Hosting's GitHub connection remains an explicit bootstrap action:
run `firebase apphosting:backends:create --project agent-lcars` and select
`jlapenna/agent-lcars`, root `apps/console`, backend id `agent-lcars`, and region
`us-central1`. Thereafter pushes to `main` deploy through App Hosting.

## CI verification

The required `Verify` job initializes this root with `-backend=false`, checks
formatting and configuration validity, and runs its mock-provider tests. That
path reads neither GCS state nor live Google or GitHub resources and requires
no cloud credentials. Real plans and applies remain operator-only operations
with the normal backend and credentials.

## GitHub ruleset (`Protect main`)

Branch protection for this repo is currently managed in the **homelab** repo's
terraform root (homelab#523, unified fleet governance 2026-08-11):
`homelab/terraform/github_rulesets.tf` instantiates one `protect-main`
module for homelab, agent-lcars, and supersprinklesracing/sprinkles, and
homelab's scheduled drift check reports hand edits. The live ruleset
(id 19524095) was imported there with a 0-diff plan and removed from
this state with a `removed` block (`github.tf`), so it was never
recreated. The repository-owned successor is
[`../github-ruleset`](../github-ruleset/): it holds Agent LCARS's
check-context configuration while Homelab retains credentials, state, and
execution. Until the reviewed state handoff completes, the Homelab module
remains live; never change branch protection through this retired root or by
hand through the GitHub UI or API.

## Dispatch webhook queue backlog alert

`monitoring.tf` defines a Cloud Monitoring alert policy, "Dispatch webhook
queue backlog", that pages when the `dispatch-webhooks` Cloud Tasks queue
either grows past 200 tasks or its non-`ok` task attempt rate stays above
~15/5min for 30 minutes -- the two symptoms of the 2026-09-15/16 incident
where one poisoned GitHub anchor's projection refresh 500'd forever and
starved unrelated webhook deliveries for 40+ minutes with no alert
(agent-lcars#1985, #1988). It notifies a single email channel backed by
`var.alert_email`, which has no default and is supplied at apply time only
(`-var alert_email=<address>` or `TF_VAR_alert_email`) -- the value is never
committed. See the alert policy's own `documentation` block for first
checks, and the homelab oncall runbook
(`jlapenna/homelab` `docs/incidents.md` and `.agents/skills/oncall/SKILL.md`
§1) for the full incident writeup.

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
