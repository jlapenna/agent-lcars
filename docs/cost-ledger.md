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
from the existing literal `gh pr create` command's correlated result. That
literal-only rule is unchanged; compound shell text is never parsed to establish
creation (#2730, rejected parser approach #2732).

For compound commands, the Claude reducer also retains `publicationCandidates`: URLs
from a successful, single-use correlated creating-command result. These are
lookup hints, never qualified publication evidence. The original strict path
qualifies a candidate only when the stored GitHub projection agrees with all of:

- the hook-observed authenticated GitHub actor (`githubActor`),
- a creation timestamp inside the session's inclusive start/last-activity window,
- the hook-observed exact head branch (`doc.branch`), and
- the session's repository as the head repository (no repository guessing).

An exact `Claude-Session: https://claude.ai/code/<sessionId>` line in GitHub's
PR body is additionally required for this strict path, and every such line
must match the session.
Actor/window/head facts alone are ambiguous when another session uses the same
credential and branch. Missing, blockquoted, fenced, commented, incidental or conflicting session links
fail closed. The original strict path still requires identical stored and public
IDs. Native Claude `bridge-session` records additionally bind a local session to
its public session: consistent `cse_` identities map to the provider's `session_`
URL form. Conflicting, malformed or sidechain bridge records supply no identity;
model text and the provider's regex-based `gitOperation` classification supply
no authority. This path accepts the provider's exact standalone URL footer as
well as the labeled form, preserving comment/fence/conflict rejection.

For a bridged session, current `main` is not substituted for a PR's branch.
The host hook observes up to 64 linked worktrees with one two-second Git command,
64 KiB output bound and matching Git common-directory checks. It records exact
refs/40-character HEADs, actor/repository and observation time, not shell cwd.
The projection must match both that ref and immutable head SHA, the actor and
repository, and the genuine creation window. The checkout observation must be
after creation and no later than the hook observer clock. Missing/truncated or
foreign checkout observations fail closed. Up to 200 distinct immutable
observations survive normal writes after checkout retirement; overflow supplies
no checkout credit. Codex/OpenCode retain the literal-publication path.

The hook resolves the actor through `gh api --hostname
github.com user --jq .login` using its existing credential, with a two-second
subprocess deadline and bounded output, after ordinary event throttling. It
never reads actor identity from transcript content. Missing `gh`, offline/token
failure, unsupported installation-token `/user` access, or failed live branch
resolution leaves the actor unknown; a new failed observation clears any prior
stored actor. Lifecycle-only end events preserve the last observed context.
Runner sessions retain the existing literal-publication path; this additional
actor observation is Claude CLI-only.

Arbitrary transcript mentions, unrelated output, failed or replayed results,
and legacy number-only associations cannot establish this denominator. Their
unqualified reference count remains visible; costs still contribute to the
numerator and subtotal without qualified references. GitHub facts come through
the existing exact projection refresh, never render-time GitHub enumeration.
The hook spool parser preserves both qualified references and candidates.
Retained summaries must be re-ingested through normal telemetry delivery to
record the new actor/candidate fields, and old projections need normal refresh
to record creation/head facts. No production backfill is performed. Deploying
the Console and updated workstation CLI, then observing a real live session,
remain runtime acceptance gates separate from source/regression coverage.

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

An operator-owned alert integration **for this Console subtotal** must use the
same selection, rate source,
reported/estimated distinction and coverage state. Record the limit, warning
percentage, selection, evaluation interval, alert owner and destination in its
reviewed configuration. Alert at/above the limit or near the warning threshold;
route incomplete or invalid configuration as unavailable data, not a healthy
budget. Test delivery and recovery through that integration's owning workflow.
This feature provides visible threshold states and the handoff contract; it does
not create notification credentials, channels, monitoring writes, IAM or
Terraform resources, or activate an external alert.

### Operator readout

`GET /api/work/v1/costs/budget?days=<1h|1..90>` requires the narrow
`costs.reader` grant through existing Work API authentication. Selection is
explicit; optional `source`, `repo`, `agent`, `issue` and `q` match Costs. Invalid,
duplicate or unknown parameters are rejected rather than silently broadening
the view. The JSON response is private/no-store and includes selection,
observation time, configured limit/warning, the shared machine assessment,
reported/estimated known subtotal and coverage. It reuses the Costs archive and
`estimateCostUsd`; the consumer must not independently reprice sessions.

The readout itself sends nothing. A subtotal collector must be explicitly
configured before it can evaluate this selection; the existing Homelab
collector is disabled. Missing configuration remains unavailable.

### Native inference budget delivery

The approved inference budget uses LiteLLM’s existing key accounting, not the
Console’s selected cumulative-session subtotal. The
`agent-lcars-handoff-summary` key has a **$5 / 7d** cap and **$4** warning
threshold. Its local-only `default` route has zero provider charges and no paid
fallback. LiteLLM owns budget enforcement and the weekly reset.

The key belongs to the native `agent-lcars-handoff-summary` team, also restricted
to `default`; the team adds no separate budget. Keep that assignment when
rotating the key: the installed LiteLLM initializer excludes keys with no team
([upstream #37292](https://github.com/BerriAI/litellm/issues/37292)). Qualify both
budget gauges after a scheduled refresh without making an inference request.

Homelab enables LiteLLM’s native five-minute budget-gauge refresh and uses the
existing Prometheus scrape and Alertmanager Slack receiver in `#oc-oncall`.
Alerts cover 80% usage, exhaustion, and missing budget gauges; they omit hashed
key labels. This covers that inference key, not all coding subscriptions or the
Console’s cumulative session estimates. No second spend ledger or custom cost
collector is needed.

The deployed contract and qualification belong to
[Homelab’s LiteLLM guide](https://github.com/jlapenna/homelab/blob/main/docs/litellm.md#lcars-inference-budget-alerts)
and [#3000](https://github.com/jlapenna/agent-lcars/issues/3000).
