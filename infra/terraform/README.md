# Agent LCARS infrastructure

Terraform owns the project services, default Firestore database, transcript
bucket, runtime secret containers, service accounts, GitHub Workload Identity
Federation, the $5/month billing budget, and (via the `github` provider) the
`Protect main` repository ruleset. Secret _values_ are never stored in
Terraform state.

Bootstrap state once with `gcloud storage buckets create
gs://agent-lcars-terraform-state --project agent-lcars --location us`, then add
a GCS backend and run `terraform init -migrate-state`. Supply the billing account
as `TF_VAR_billing_account`.

Firebase App Hosting's GitHub connection remains an explicit bootstrap action:
run `firebase apphosting:backends:create --project agent-lcars` and select
`jlapenna/agent-lcars`, root `apps/console`, backend id `agent-lcars`, and region
`us-central1`. Thereafter pushes to `main` deploy through App Hosting.

## GitHub ruleset (`Protect main`)

`infra/terraform/github.tf`'s `github_repository_ruleset.protect_main` is the
version-controlled record of the ruleset that is the only thing protecting
`main` (`agent-lcars-dev/references/pr.md`). Change branch protection here,
not by hand through the GitHub UI or API — a hand edit now only creates drift
for the next `plan` to report, rather than a change anyone can review.

The `github` provider needs a token with admin rights on this repository
(ruleset read/write requires admin) at every plan and apply. No CI workflow
runs Terraform, so this is always operator-supplied, never a repo secret or a
value committed anywhere: export it into the environment before running
Terraform, e.g.

```sh
export GITHUB_TOKEN=$(gh auth token)
```

The resource was adopted with `terraform import` rather than created, so the
live ruleset was never recreated (which would have briefly left `main`
unprotected):

```sh
terraform import github_repository_ruleset.protect_main agent-lcars:19524095
```

Keep the admin bypass (`bypass_actors { actor_type = "RepositoryRole" ... }`)
exactly as configured. Terraform manages the very ruleset that gates its own
pull requests circularly: a bad apply that misconfigures it can only be
recovered through that bypass, so any change touching this resource should be
reviewed like the safety-critical config it is, not applied unattended.

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
