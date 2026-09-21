# Agent LCARS GitHub ruleset

This is the repository-owned declaration for its `Protect main` GitHub
ruleset. It intentionally has no credential, state-bucket value, or backend
prefix. The trusted Homelab executor supplies those at runtime and owns the
scheduled drift check.

The ruleset is intentionally self-contained. That keeps the repository's
policy reviewable here and lets fork PRs initialize and validate it without a
credential for another private fleet repository.

Do not run an unconfigured local apply. The migration runbook will first move
the live ruleset state from Homelab without destroying the ruleset, then run a
reviewed, zero-diff plan through the central executor.

Repository CI initializes, formats, validates, and checks this root's local
contract. Only the centralized executor receives backend and state access.
