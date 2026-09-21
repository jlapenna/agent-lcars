# Agent LCARS GitHub ruleset

This is the repository-owned declaration for its `Protect main` GitHub
ruleset. It intentionally has no credential, state-bucket value, or backend
prefix. The trusted Homelab executor supplies those at runtime and owns the
scheduled drift check.

The shared `protect-main` module is pinned to a Homelab commit. Update the
pin only when deliberately adopting a reviewed shared-policy change. This
root owns only Agent LCARS-specific inputs: its repository name, required
check contexts, and any future explicit strictness opt-in.

Do not run an unconfigured local apply. The migration runbook will first move
the live ruleset state from Homelab without destroying the ruleset, then run a
reviewed, zero-diff plan through the central executor.
