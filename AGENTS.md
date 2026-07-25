# Agent LCARS contributor notes

Keep this repository independent from the supersprinklesracing source tree.
Shared telemetry integration is delivered by baking
`apps/telemetry-watcher`'s bundle into the shared runner image at
image-build time, built fresh from this repo's own `main`
(`apps/runner-autoscaler/runner-image/Dockerfile` — see issue #30); this
replaced an earlier versioned-standalone-bundle-on-GCS scheme (issue #29,
retired for good in #66) whose published pin went stale for months. Do
not add cross-repository _source_ imports or build contexts elsewhere —
this one image-build integration point is the sanctioned exception, not a
precedent for others.

Never commit credentials. Runtime secrets belong in GCP Secret Manager and the
host writer credential belongs in the encrypted homelab secret store. Terraform
owns secret containers but not secret values.

Before publishing, run the affected Nx test, typecheck, and build targets.
