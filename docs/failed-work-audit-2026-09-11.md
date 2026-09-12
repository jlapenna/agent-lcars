# Failed-work audit — September 11, 2026

Window: September 11 midnight America/Los_Angeles (07:00 UTC) through the
23:50 UTC run snapshot, with GitHub and archive evidence checked through
September 12 00:04 UTC. Central Loki follow-up recovered startup errors
through 00:20 UTC; a 00:25 UTC refresh found no newly settled runs. The wider UTC-day query returned 82 runs; five
failures before Pacific midnight are excluded from the counts below.

77 attempts settled during the local-day window: 18 successful, 34 unsuccessful
completions, and 25 lost attempts. The 59 failed/lost attempts belong to 42
work items. Later success is preserved in the ledger; failure does not mean
all 42 items remain unfinished.

## Findings

- **15 Claude failures:** every result contains the provider's weekly-limit
  response, with a stated reset of September 13 00:00 UTC. Retained container
  logs corroborate the response. No task decision can resolve this quota.
- **3 Codex failures:** Cloud Run request logs show `/codex-auth` returning
  HTTP 409 for #1901/r1 at 11:37:47 UTC, #1902/r1 at 11:38:08, and #1904/r1 at
  11:56:35. The protected credential was busy. All three issues are now closed.
  The bounded lease-wait fix is already on main ([#1903](https://github.com/jlapenna/agent-lcars/issues/1903)).
- **25 lost attempts:** 23 OpenCode first attempts expired together at
  15:09 UTC; two Claude attempts expired at 19:15 UTC. These were claimed
  without completion. This pattern matches the capacity-before-claim defect
  already repaired by [#1915](https://github.com/jlapenna/agent-lcars/pull/1915).
  This is cohort-level evidence, not proof of the exact launch failure of
  every individual lost container. No retry-budget bypass was applied.
- **16 OpenCode unsuccessful completions:** nine ended about 60 minutes
  after claim; retained containers corroborate the one-hour wall. A tenth
  stopped after 59 minutes. Five have bot-authored PRs carrying the exact
  failed attempt marker: #5461/r2 → #5505, #5464/r2 → #5507, #5474/r2 → #5520,
  #5476/r2 → #5518, #5479/r2 → #5521. PR #5518 merged at 16:55 UTC, before
  its run failed at 17:12 UTC. The runner skipped artifact verification
  whenever the agent exited nonzero, falsely hiding these deliverables.
- Archives for #5465/r2 and #5473/r2 end normally immediately after compaction,
  with promises to investigate and no tool call or deliverable. #5462/r2
  ends normally with questions about scope and ownership, without a
  marker-bound park. These are distinct from timeout. The standing OpenCode
  instructions incorrectly claimed automatic marker stamping and duplicated
  obsolete parking rules; they now defer to the canonical agent protocol and
  explicitly require action after compaction.
- #5455/r1, #5463/r2, and #5470/r2 failed within seconds without an archived
  session; their retained containers were unavailable. Central Loki logs recovered
  #5463/r2's startup error: OpenCode's SQLite migration failed while creating
  the `workspace` table at 15:12:48 UTC. Both the main CLI and telemetry's
  session discovery initialize that database; simultaneous first opens are
  a plausible cause, not conclusively proven by the SQL error alone. The
  runner now completes a bounded database initialization before starting
  telemetry. #5470/r2's central logs report `database is locked` immediately
  after telemetry startup at 15:57 UTC. #5455/r1's exact startup failure
  remains unresolved.

## Remediation

25 `status:needs-human` labels were removed and read back. For each, the
fresh timeline matched the audited snapshot, the label actor was
`agent-lcars[bot]`, the preceding comment reported `no-deliverable`, no
explicit park marker existed, and no later human comment introduced a
handoff. No assignee, issue state, branch, run record, or provider selection
was changed. No work was redispatched into the known exhausted provider.

The accompanying code separates derived `failed` from explicit `parked`,
keeps failed items visible with recovery controls, and applies the human label
only for explicit park results. It sets all provider invocations to 7,200
seconds, verifies exact-marker artifacts even after nonzero exit, and reports
runner, agent, timeout, provider-limit, and verification failures separately.
The concurrently merged [#1921](https://github.com/jlapenna/agent-lcars/pull/1921)
renews run-scoped Git/gh authentication through the existing checkout-token
API before token expiry, with each Git/gh command reading the renewed token,
keeping the App private key on the server and
the two-hour allowance usable beyond GitHub's one-hour token lifetime.

Code delivery does not retroactively rewrite run history. Runner behavior
requires publishing `homelab-runner` through the canonical Homelab publisher;
the console uses the normal green-main deployment workflow. Session archives
and stopped containers were read only; unpublished work was not discarded.

## Per-item ledger

`lost` means the run lease expired; `timeout window` is timing evidence, not
a recovered process exit code. PR links below were matched by exact attempt
marker and bot author, not merely by title or issue mention.

| Work item                                                                                            | Failed attempts and evidence                  | Current issue / deliverable evidence                                                      | False human label cleared |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| [jlapenna/agent-lcars#1901](https://github.com/jlapenna/agent-lcars/issues/1901)                     | r1: credential lease 409                      | closed                                                                                    | —                         |
| [jlapenna/agent-lcars#1902](https://github.com/jlapenna/agent-lcars/issues/1902)                     | r1: credential lease 409                      | closed                                                                                    | —                         |
| [jlapenna/agent-lcars#1904](https://github.com/jlapenna/agent-lcars/issues/1904)                     | r1: credential lease 409                      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5448](https://github.com/supersprinklesracing/sprinkles/issues/5448) | r1: provider quota                            | closed                                                                                    | yes                       |
| [supersprinklesracing/sprinkles#5453](https://github.com/supersprinklesracing/sprinkles/issues/5453) | r1: timeout window                            | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5455](https://github.com/supersprinklesracing/sprinkles/issues/5455) | r1: unresolved early failure; no archive      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5459](https://github.com/supersprinklesracing/sprinkles/issues/5459) | r1: lost                                      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5460](https://github.com/supersprinklesracing/sprinkles/issues/5460) | r1: lost                                      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5461](https://github.com/supersprinklesracing/sprinkles/issues/5461) | r1: lost; r2: timeout window                  | open · [PR #5505](https://github.com/supersprinklesracing/sprinkles/pull/5505) (open)     | yes                       |
| [supersprinklesracing/sprinkles#5462](https://github.com/supersprinklesracing/sprinkles/issues/5462) | r1: lost; r2: questions without park artifact | open                                                                                      | —                         |
| [supersprinklesracing/sprinkles#5463](https://github.com/supersprinklesracing/sprinkles/issues/5463) | r1: lost; r2: SQLite migration failure        | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5464](https://github.com/supersprinklesracing/sprinkles/issues/5464) | r1: lost; r2: timeout window                  | open · [PR #5507](https://github.com/supersprinklesracing/sprinkles/pull/5507) (open)     | yes                       |
| [supersprinklesracing/sprinkles#5465](https://github.com/supersprinklesracing/sprinkles/issues/5465) | r1: lost; r2: premature stop after compaction | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5466](https://github.com/supersprinklesracing/sprinkles/issues/5466) | r1: lost                                      | open                                                                                      | —                         |
| [supersprinklesracing/sprinkles#5467](https://github.com/supersprinklesracing/sprinkles/issues/5467) | r1: lost; r2: timeout window                  | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5468](https://github.com/supersprinklesracing/sprinkles/issues/5468) | r1: lost                                      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5469](https://github.com/supersprinklesracing/sprinkles/issues/5469) | r1: lost                                      | open                                                                                      | —                         |
| [supersprinklesracing/sprinkles#5470](https://github.com/supersprinklesracing/sprinkles/issues/5470) | r1: lost; r2: SQLite database locked          | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5471](https://github.com/supersprinklesracing/sprinkles/issues/5471) | r1: lost                                      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5472](https://github.com/supersprinklesracing/sprinkles/issues/5472) | r1: lost; r2: timeout window                  | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5473](https://github.com/supersprinklesracing/sprinkles/issues/5473) | r1: lost; r2: premature stop after compaction | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5474](https://github.com/supersprinklesracing/sprinkles/issues/5474) | r1: lost; r2: timeout window                  | open · [PR #5520](https://github.com/supersprinklesracing/sprinkles/pull/5520) (open)     | yes                       |
| [supersprinklesracing/sprinkles#5475](https://github.com/supersprinklesracing/sprinkles/issues/5475) | r1: lost; r2: timeout window                  | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5476](https://github.com/supersprinklesracing/sprinkles/issues/5476) | r1: lost; r2: timeout window                  | closed · [PR #5518](https://github.com/supersprinklesracing/sprinkles/pull/5518) (merged) | yes                       |
| [supersprinklesracing/sprinkles#5477](https://github.com/supersprinklesracing/sprinkles/issues/5477) | r1: lost; r2: timeout window                  | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5478](https://github.com/supersprinklesracing/sprinkles/issues/5478) | r1: lost                                      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5479](https://github.com/supersprinklesracing/sprinkles/issues/5479) | r1: lost; r2: timeout window                  | open · [PR #5521](https://github.com/supersprinklesracing/sprinkles/pull/5521) (open)     | yes                       |
| [supersprinklesracing/sprinkles#5480](https://github.com/supersprinklesracing/sprinkles/issues/5480) | r1: lost                                      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5481](https://github.com/supersprinklesracing/sprinkles/issues/5481) | r1: lost                                      | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5482](https://github.com/supersprinklesracing/sprinkles/issues/5482) | r1: provider quota                            | closed                                                                                    | yes                       |
| [supersprinklesracing/sprinkles#5485](https://github.com/supersprinklesracing/sprinkles/issues/5485) | r1: provider quota; r2: provider quota        | closed                                                                                    | yes                       |
| [supersprinklesracing/sprinkles#5487](https://github.com/supersprinklesracing/sprinkles/issues/5487) | r1: provider quota                            | closed                                                                                    | —                         |
| [supersprinklesracing/sprinkles#5489](https://github.com/supersprinklesracing/sprinkles/issues/5489) | r1: provider quota                            | closed                                                                                    | yes                       |
| [supersprinklesracing/sprinkles#5498](https://github.com/supersprinklesracing/sprinkles/issues/5498) | r1: provider quota                            | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5501](https://github.com/supersprinklesracing/sprinkles/issues/5501) | r1: provider quota                            | closed                                                                                    | yes                       |
| [supersprinklesracing/sprinkles#5505](https://github.com/supersprinklesracing/sprinkles/issues/5505) | r1: provider quota                            | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5509](https://github.com/supersprinklesracing/sprinkles/issues/5509) | r1: provider quota                            | closed                                                                                    | yes                       |
| [supersprinklesracing/sprinkles#5510](https://github.com/supersprinklesracing/sprinkles/issues/5510) | r1: provider quota                            | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5513](https://github.com/supersprinklesracing/sprinkles/issues/5513) | r1: lost; r2: provider quota                  | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5520](https://github.com/supersprinklesracing/sprinkles/issues/5520) | r1: lost; r2: provider quota                  | open                                                                                      | yes                       |
| [supersprinklesracing/sprinkles#5521](https://github.com/supersprinklesracing/sprinkles/issues/5521) | r1: provider quota                            | open                                                                                      | yes                       |
| [work:01M26ZJHFQ8MST9NKVVZJYZCX1](https://lcars.jlapenna.net/work/01M26ZJHFQ8MST9NKVVZJYZCX1)        | r3: provider quota                            | native item                                                                               | —                         |
