# Fleet testing policy

This policy applies to every fleet repository and every test or CI check.
Keep a test only when it protects an observable production contract or a
previously observed regression, and only when a required merge check, release
gate, or owned signal consumes the result.

Keep safety, security, data-integrity, availability, incident-regression,
public-interface, boundary, and durable-policy coverage. Prefer the narrowest
layer that observes the real contract: unit tests for durable algorithms,
contract/integration tests for interfaces, targeted E2E for external paths,
and reviewed visual tests only where appearance is the contract.

Remove private implementation assertions, hypothetical fields, framework
behavior, unchecked static text, regenerated snapshots, tautologies,
inline-reimplemented expectations, permanently skipped suites, and retired
migration code with its tests. A migration test leaves with the migration
unless it protects the final production contract. Every deletion PR cites its
applicable category from the canonical policy issue (#1486).

Required jobs have no fork/path/draft skip conditions except sanctioned
control flags. A control flag intentionally permits a skipped required check,
but the engaged state must be visible in the affected run and it cannot be
used as evidence that another test is redundant. Every job has a bounded
timeout; PR workflows cancel superseded runs; every secret scanner has a
required or release-gating consumer; and dead event triggers are removed.

For the full rationale, decision record, and rollout inventory, see
[issue #1486](https://github.com/jlapenna/agent-lcars/issues/1486), the
source of truth for this document.
