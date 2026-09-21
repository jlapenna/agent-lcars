# Agent LCARS GitHub ruleset

This is the repository-owned declaration for its `Protect main` GitHub
ruleset. It intentionally has no credential, state-bucket value, or backend
prefix. The trusted Homelab executor supplies those at runtime and owns the
scheduled drift check.

The ruleset is intentionally self-contained. That keeps the repository's
policy reviewable here and lets fork PRs initialize and validate it without a
credential for another private fleet repository.

The live ruleset (id 19524095) was imported into this root's isolated state
prefix and removed from Homelab's former shared module state without changing
or recreating the GitHub resource. Do not run an unconfigured local apply.
Plans, approved applies, and scheduled drift checks use the trusted Homelab
executor so credentials and backend authority remain centralized.

Repository CI initializes, formats, validates, and checks this root's local
contract. Only the centralized executor receives backend and state access.
