# Agent LCARS contributor notes

Keep this repository independent from the supersprinklesracing source tree.
Shared telemetry integration is delivered through the versioned standalone
bundle; do not add cross-repository source imports or build contexts.

Never commit credentials. Runtime secrets belong in GCP Secret Manager and the
host writer credential belongs in the encrypted homelab secret store. Terraform
owns secret containers but not secret values.

Before publishing, run the affected Nx test, typecheck, and build targets.
