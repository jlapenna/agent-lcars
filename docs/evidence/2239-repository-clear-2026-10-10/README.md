# Repository-clear failure evidence — 2026-10-10

Historical evidence for [#2239](https://github.com/jlapenna/agent-lcars/issues/2239),
not current runtime policy or proof of a corrected navigation cause.

The original packed HTML reports were downloaded and decoded independently.
Each JSON preserves one original result, including its full step timeline,
errors, attachment identities and hashes. Failed screenshots and error contexts
are retained here; the successful retry traces remain in their source artifacts.
The source report and complete downloaded job log hashes identify the extraction.
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
