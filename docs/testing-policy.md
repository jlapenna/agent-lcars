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

## Development proof uses real work

During development, prefer a real issue or work item with a useful outcome
to prove functionality end to end. Exercise the normal supported intake,
dispatch, execution, and delivery paths relevant to the change; do not invent
fake work units or no-op tasks just to produce a green run. Choose suitably
scoped work, respect existing ownership, and obtain any required operational
approval. This preference does not authorize extra production changes.

Record the issue or work-item identifier, the actual path exercised, and
evidence of the useful result. A successful dispatch or worker exit alone
does not prove that the requested work was delivered. If no suitable real
work is available, state what remains unproven rather than presenting a
synthetic run as real-work acceptance.

Fixtures, mocks, deterministic regression tests, and narrowly scoped synthetic
canaries still belong where they protect a specific contract or safely
exercise a failure. Label their evidence accurately: they supplement, rather
than substitute for, real-work proof of the full development workflow.
