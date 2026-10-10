# Repository-clear failure evidence — 2026-10-10

Historical evidence for [#2239](https://github.com/jlapenna/agent-lcars/issues/2239),
not current runtime policy or proof of a corrected navigation cause.

The original packed HTML reports were downloaded and decoded independently.
Each JSON preserves one original result, including its full step timeline,
errors, attachment identities and hashes. Failed screenshots and error contexts
are retained here; the successful retry traces remain in their source artifacts.
The source report and raw individual job log hashes identify the extraction.
Each `source` records the exact log download command and byte representation.
The log hashes use `gh api --allow-escape-sequences` on the individual job
endpoint, with no transformations; they are not `gh run view --log` output
(which combines and prefixes logs from all jobs in the workflow).
No successful retry trace is used to infer the failed attempt's lower-level cause.

| Exact head                                 | Failed first attempt                                                                                                                                                      | Successful retry                                                                  | Source                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `16ee77dc15f2256491568e2b89dded358402d44b` | [report](16ee-first-attempt-report.json), [screenshot](16ee-first-attempt.png), [context](16ee-first-attempt-context.txt); 90051 ms, scoped Inbox clear click unfinished  | [report](16ee-successful-retry-report.json); 2873 ms, all three destinations pass | [job 113879140019](https://github.com/jlapenna/agent-lcars/actions/runs/37947986161/job/113879140019), [artifact 11625135471](https://github.com/jlapenna/agent-lcars/actions/runs/37947986161/artifacts/11625135471) |
| `c15977dd82c8bd436b91f3614769a82fc9fd0b8e` | [report](c159-first-attempt-report.json), [screenshot](c159-first-attempt.png), [context](c159-first-attempt-context.txt); 90060 ms, scoped Agents clear click unfinished | [report](c159-successful-retry-report.json); 3101 ms, all three destinations pass | [job 113901645097](https://github.com/jlapenna/agent-lcars/actions/runs/37954548943/job/113901645097), [artifact 11628351847](https://github.com/jlapenna/agent-lcars/actions/runs/37954548943/artifacts/11628351847) |

Neither first attempt has a trace: the suite used `on-first-retry`. Both reports
end inside the same exact-role Clear repository click, after the scoped selector
and loading-state assertions. A visible link in a screenshot does not establish
pointer actionability, dispatch, a response or navigation completion.

## Diagnostic boundary

`work-pagination.spec.ts` now retains a trace for any failed attempt in this file,
following the existing Inbox action pattern. Each actual clear operation attaches
an attempt-indexed, bounded phase log for its destination, on success or failure:
click start/completion, native main-frame GET request/response/finish/failure,
main-frame commit, DOMContentLoaded/load, scope removal and resolved selector.
The real click keeps Playwright's actionability and default navigation wait.
A 15-second click bound (recorded retry clicks were below 100 ms) permits evidence
attachment before the unchanged 90-second test limit. No sleep, retry increase,
forced click, navigation-wait bypass or product change is introduced.

On recurrence, inspect that failed attempt's trace and phase log together:

- No document request: inspect the click's actionability log and DOM snapshots;
  lack of a request alone does not distinguish an intercepted click from a
  browser-side stall.
- Request without response: inspect the native GET and server/request boundary.
- Response without commit: inspect response status and browser navigation.
- Commit while click remains pending: inspect Playwright's navigation-completion
  wait and document lifecycle events.
- Completed click with unresolved selector: inspect route rendering/hydration.

A passing first attempt establishes current behavior only. The issue remains
open until a failing-attempt boundary demonstrates an owning cause and its
correction passes the focused browser journey and protected required CI.

## First retained failure on the diagnostic revision

Required [CI 38091770013](https://github.com/jlapenna/agent-lcars/actions/runs/38091770013)
at `ca72d58be8536400a6c44d6dabf1dfe9b884bf70` completed successfully with
**197 passed, 1 flaky in 7.5 minutes**. The phone journey failed its first
attempt after 1815 ms, before any clear click, at the repository-value assertion
after Bridge → Inbox. Its successful retry completed all three destinations
in 5670 ms and attached three native-clear phase logs with HTTP 200 responses.
These retry timings do not establish the earlier 90-second clear-click cause.

The [first-attempt report](ca72-first-attempt-report.json),
[screenshot](ca72-first-attempt.png) and
[failed-assertion DOM snapshot](ca72-first-attempt-dom-snapshot.json) are retained
separately from the [successful retry report](ca72-successful-retry-report.json).
The actual failed first-attempt trace is in
[artifact 11685215734](https://github.com/jlapenna/agent-lcars/actions/runs/38091770013/artifacts/11685215734);
its identity and SHA256 are recorded in the first-attempt report. The retained
snapshot uses Playwright's snapshot references; the complete source trace supplies
those references and resources. It is evidence, not an executable test fixture.

The failed trace's `mexz@4402` after-snapshot contains one visible Inbox selector
(`mantine-8f1guw8n4`) and one cached Deck selector (`mantine-i5bqsjkop`), under a
Deck shell with `display: none !important`. The exact label query matches both
and fails strictness; the screenshot shows only the active Inbox. This is the
already diagnosed hidden Activity behavior in
[#503](https://github.com/jlapenna/agent-lcars/issues/503) and
[#755](https://github.com/jlapenna/agent-lcars/pull/755), rather than a new product
DOM-duplication defect. Next's [UI-state testing guidance](https://nextjs.org/docs/app/guides/preserving-ui-state#testing)
explains that cached hidden routes remain in the DOM and recommends accessible
role queries for visible controls.

The correction follows that precedent: the phone journey uses the exact
accessible Repository combobox, asserts the destination pathname and repository
query before checking scope, and keeps strict single-control/value assertions.
The clear link still performs a real native click with its existing navigation
wait and bounded diagnostics. No first/nth selection, forced click, sleep,
retry increase, whole-test timeout increase or product change is used.

This demonstrates and corrects the newly captured hidden-selector assertion
failure. It does **not** retroactively establish the lower-level cause of the
original unfinished clear clicks. #2239 remains open for that boundary evidence.
