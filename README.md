# Agent LCARS

Agent LCARS is the standalone operations console and telemetry pipeline for the
automation running in [`jlapenna/supersprinklesracing`](https://github.com/jlapenna/supersprinklesracing).
It is intentionally isolated in the `agent-lcars` GCP project and does not read
or write the racing application's databases.

## Workspace

- `apps/console` — Next.js operations console, deployed with Firebase App Hosting
- `apps/telemetry-watcher` — host watcher and versioned runner sidecar bundle
- `libs/telemetry` — session model, reducers, Firestore and transcript stores
- `infra/terraform` — GCP services, storage, IAM, WIF, secrets and budget
- `apps/runner-autoscaler` — Go source for the shared GitHub Actions
  runner-fleet control plane and JIT worker image (see
  [docs/onboarding-autoscaler.md](docs/onboarding-autoscaler.md)); deployed
  by `jlapenna/homelab`, which pulls the images this repo's own CI publishes

Use Node 24 and pnpm 10. Run `pnpm install`, then `pnpm nx run-many -t test
typecheck build`.

Production remains at <https://agent-console.supersprinkles.racing>.

## Documentation

- [docs/onboarding-console-and-telemetry.md](docs/onboarding-console-and-telemetry.md)
  — wiring a new repo's dispatched agents into this console (dashboard,
  Sessions, live transcripts).
- [docs/onboarding-autoscaler.md](docs/onboarding-autoscaler.md) — adding a
  new GitHub account/repo as a registration on the shared runner fleet.

## Cutover

The migration starts with an empty default Firestore database and transcript
bucket. Provision Terraform, populate secret versions, create the App Hosting
backend, publish the sidecar bundle, and deploy the watcher before moving the
custom domain. Verify login, GitHub actions, session ingestion, and transcript
viewing. Only then remove the old `supersprinklesracing` resources.
