# Session spend and merged deliverables

The Costs destination reads the same selected sessions as Sessions and the
existing issue/week ledgers: `days` (default 14, maximum 90), `source`, `issue`,
and watched `repo`. The window selects **last activity**, not billing events.
Each selected session contributes its whole cumulative recorded usage and cost.
A session resumed today can therefore include costs incurred before the window.
The newest 200 sessions are the archive ceiling; reaching it displays a partial
coverage warning, including after repository filtering.

## Accounting

Pipeline is the persisted adapter (`claude-code` → `claude`, `codex`, or
`opencode`); any other adapter keeps its own name. Requested and resolved model
are separate dimensions. Missing resolved model is `unknown`, never inferred
from the request. Each session contributes once to each breakdown, so every
breakdown reconciles with issue/week totals for the same selection.

Reported cost is the session's finite `totalCostUsd`, floored at zero. This is
provider transcript data, not an invoice or independently metered account spend.
Without reported cost, the existing telemetry rate table estimates cost using
the resolved model when present, otherwise the requested model. Unrecognized
rates remain unpriced; they do not silently become zero. Estimates, reported
subtotals and unpriced session counts remain separate. A session-level model
field cannot allocate tokens across model switches inside a session.

Cost per merged deliverable is the selected sessions' **entire known cost**
(reported plus estimated, including failed attempts, unmerged attempts and
sessions without PR references) divided by unique repository-qualified,
known-merged PR references with qualified publication evidence from those sessions. It is an efficiency ratio, not
the allocated price of a particular successful PR. Repeated references and
multiple attempts at the same PR count one denominator. Merge date need not
fall inside the selected activity window. With no known merges or no priced
sessions, the ratio is unavailable. Unknown merge evidence and unpriced cost
make the ratio partial; missing merges can raise it while missing cost can lower
it. Counts across pipeline/model groups overlap when a PR has multiple attempts
in different groups and must not be summed.

Qualified publication evidence preserves the full GitHub repository/PR identity
from a `gh pr create` command's correlated tool result. Arbitrary transcript
mentions, URLs in user requests, unrelated tool output and legacy number-only
associations cannot establish this denominator. Their unqualified reference
count remains visible; costs still contribute to the numerator and the subtotal
without qualified references. This evidence is a command/output heuristic, not
proof that every reported PR was successfully created or authored by the session.
Adapters that cannot supply correlated publication evidence remain unavailable
for this denominator. Retained summaries must be re-ingested through normal
telemetry delivery before they can gain qualified evidence; no production
backfill is performed by this change.

Per-PR attribution splits each session's cost equally across its unique qualified publication
references, including unmerged/unknown references. The separate no-qualified-PR subtotal
keeps all spend accounted for. Unpriced session shares are fractional when a
session references multiple PRs. This deterministic allocation is not inferred
from individual turns or token traces.

Merge status comes only from stored GitHub anchor projections, refreshed by
existing webhook/exact refresh/backfill paths. A timestamp on a closed PR proves
a known merge; explicit `mergedAt: null` means known unmerged as of the
projection observation. Closed alone, legacy missing fields, failed reads and
wrong identities remain unknown. Costs never falls back to GitHub network calls
during rendering. Point reads preserve canonical publication/configured repository spelling;
case-insensitive keys are used only for deduplication and comparison. Reads are
deduplicated, capped at 200, limited to eight
concurrent reads, and share a five-second deadline. Older retained PRs may need
the existing approved projection backfill before their metrics are complete;
this change does not request or run one.

## Operator budget and alert handoff

Reviewed server configuration may set `AGENT_LCARS_COST_BUDGET_USD` to a positive
finite USD limit and `AGENT_LCARS_COST_WARNING_PERCENT` to a percentage strictly
between zero and 100 (default 80). There is no default dollar budget. Use the
normal reviewed Console environment/deployment path described in
[deployment-boundary.md](deployment-boundary.md); configuration publication and
live deployment remain separate operator operations.

This budget compares the **currently selected cumulative-session subtotal** to
one configured limit, not a calendar billing budget. Operators comparing views
must hold the selection constant. The page shows unconfigured/invalid, below
warning, near budget, or at/above budget. Missing prices or archive coverage
prevent a below-warning assessment. A known subtotal already above a threshold
still proves the threshold is reached even if additional spend is unknown.

An operator-owned alert integration must use the same selection, rate source,
reported/estimated distinction and coverage state. Record the limit, warning
percentage, selection, evaluation interval, alert owner and destination in its
reviewed configuration. Alert at/above the limit or near the warning threshold;
route incomplete or invalid configuration as unavailable data, not a healthy
budget. Test delivery and recovery through that integration's owning workflow.
This feature provides visible threshold states and the handoff contract; it does
not create notification credentials, channels, monitoring writes, IAM or
Terraform resources, or activate an external alert.
