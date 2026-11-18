# Human-needed handoff summaries

When an authenticated run completion reports `park` with a nonblank final
message, the completion transaction enqueues an `admit-handoff-summary` outbox
entry. Its drain admits one durable `handoff-summary` Work item for that run,
keyed by the run and the SHA-256 of its stored inline message, so a retried
delivery never mints a second summary. The model receives that same stored
message: for an overflowed handoff it is a head-and-tail preview, so its digest
differs from the full message's, and actions in the omitted middle are not
available to the summary. That Work's result holds 2–3 short actions
(`humanNeededActions`); the parked run's original result is never rewritten.
Commands sort first and must be exact excerpts from the handoff. The summary is
a reading aid, never an authorization or an executable action.

Readers project the actions onto a finished parked run with
`readHandoffActions` (`apps/console/src/lib/handoff-summary-work.ts`). Its
first lookup is the run's own legacy inline `result.humanNeededActions`: a run
that has them shows them with no summary Work. Otherwise it falls back to the
durable summary Work, and returns its actions only when that Work finished
successfully for the same run and the same message hash.

The native and GitHub Inbox detail panes show the current parked run's
summary, and both task history pages retain the summary beside that round's
full handoff. A new run cannot inherit an older summary. Label-only GitHub
decisions, and older parks that have neither legacy inline actions nor
summary Work, have no stored action summary; those historical run records are
not backfilled. They can still receive the display-time Inbox
descriptions below.

## Summary types and precedence

The current decision description is the primary reading aid in an Inbox detail
pane. A stored action summary is available in a collapsed **Earlier handoff ·
AI summary** disclosure, explicitly identified as historical:

| Reading aid                                  | Source and lifetime                                                                                                                              | Display                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Decision description                         | Current bounded issue/comment or native handoff context and decision state; durable `inbox-summary` Work, re-admitted when that input changes    | Inbox row and detail, including older parks, label-only decisions, and completed reports |
| Stored action summary (`humanNeededActions`) | The final handoff of one authenticated parked run; legacy inline actions on the run, else its `handoff-summary` Work (same run and message hash) | Current parked-run detail and that round's task history                                  |

The description explains the current decision (or summarizes a completed
report). Stored actions preserve what the agent asked at the time it parked;
a later comment can change the current decision without rewriting that run's
historical actions. A new run does not inherit them. The historical disclosure
keeps old actions from competing with the current description, including when
the description is unavailable. It does not compare or merge generated text.
Neither summary is authoritative. If they overlap or disagree, use the latest
original issue/comment/handoff and its explicit constraints, not whichever
generated wording is more convenient. Full source context and controls remain
available when either summary fails. The product requirement is
[FE-IN-8](product/console-product-spec.md#62-decision-inbox-inbox).

## Server configuration

Configure these three settings together on the Console runtime:

| Setting                               | Value                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `AGENT_LCARS_HANDOFF_SUMMARY_URL`     | Full HTTPS URL of a trusted OpenAI-compatible `/chat/completions` endpoint |
| `AGENT_LCARS_HANDOFF_SUMMARY_MODEL`   | An endpoint-supported small model with JSON object response support        |
| `AGENT_LCARS_HANDOFF_SUMMARY_API_KEY` | Dedicated server credential from Secret Manager                            |

This deployment uses the existing local-only LiteLLM `default` route at
`https://llm.jlapenna.net/chat/completions`. A dedicated virtual key restricted
to that route (without a paid fallback) is stored as `AGENT_LCARS_HANDOFF_SUMMARY_API_KEY` in Secret Manager;
Terraform owns its container, the Console runtime's access and metadata grants,
and the App Hosting service agent's version-management grant. Provision
the value before deploying the App Hosting binding. The route must return valid
summary JSON within the 30-second budget; qualify provider changes with
the application prompt before updating this binding. Local inference has zero
provider charges. LiteLLM owns the dedicated key’s native $5 weekly cap and
$4 soft threshold; historical paid calls remain in its spend ledger.

There is no implicit provider, endpoint, or reuse of worker subscription
credentials. With all three absent, Console keeps the existing full-handoff
behavior. Partial or insecure configuration fails startup. The owning
deployment/credential workflow must provision and bind the dedicated secret;
source publication alone does not enable this feature in production. Never
put secret values in application configuration or Terraform.

The request sends only the bounded final handoff message (up to 16 KiB),
requests JSON with a 1,200-token output cap, permits no tools or redirects,
disables model reasoning for this short extraction task,
and allows at most 30 seconds per attempt. Before calling the model, the
attempt rechecks that the source run is still parked with the same message
hash. Inside a maintenance tick the timeout is shortened to leave five seconds
before the tick's deadline for settlement; with five seconds or less
remaining, the attempt is not started or its claim is released. The streamed response
is capped at 64 KiB before decoding or JSON parsing, and must contain exactly
one choice. Unread response data is canceled on failure. Non-park outcomes make
no LLM call. Invalid output, invented commands, timeout and upstream failure
report the summary attempt as `summary-unavailable` and leave the parked run and
its complete original message untouched. The log records only that the
optional summary was unavailable, never its contents or upstream error body.
Page refreshes never regenerate a summary.

## Verification boundary

Required `Verify` covers the mocked HTTP boundary, authenticated completion,
durable result/public Work read schema, current-run selection and inert UI
rendering. Required `E2E` consumes deterministic stored summaries for native
and GitHub history and the native Inbox. Those fixtures do not prove model
quality or live provider access. After configuration and deployment, use a real
parked work item to verify that the saved 2–3 actions preserve prerequisites,
commands and the resume trigger, and that the full handoff remains available.

## Decision Inbox descriptions

The Inbox also generates a one- or two-sentence description for each GitHub
and native item when it is displayed, including older parks and label-only
GitHub decisions. The description leads with the decision, approval, missing
information or intervention needed. Finished reports get a reading description,
without inventing a decision. Rows and detail panes show this description;
the original issue, comment or handoff stays available below it.

This uses the same three server settings and bounded JSON transport above.
Long source fields retain both their beginning and end within individual caps: title, original request,
latest comment or handoff, current queue reasons, CI/review state and diagnosis.
No tools or actions are offered to the model. The result is plain text, capped
at 600 characters, and is advisory rather than authorization.

Displaying an item admits one durable `inbox-summary` Work item per source
(`admitInboxSummary` in `apps/console/src/lib/inbox-summary-work.ts`). Its
revision key hashes the bounded context and the decision's observation times,
so an unchanged source is a duplicate request and changed comments, handoffs or
decision state admit a new revision. Only the latest finished revision whose
context matches is shown. When work is pending, the request's `after` callback
drains the outbox and runs summary attempts once the response is sent
(`getInboxDecisionSummary` in `apps/console/src/lib/inbox-decision-summary.ts`);
the maintenance tick recovers any that callback did not finish.

Summary Work uses the same durable claims, token fencing and completion
transactions as coding work. Console itself claims it (`console-model-call`),
at most four attempts per background pass and one per maintenance tick. The
queue's live-claim ceilings are 3 for `inbox-summary` and 1 for
`handoff-summary` (`QUEUE_PIPELINE_MAX_LIVE_CLAIMS`).

Descriptions render behind Suspense, so the queue and reply controls do not
wait. A pending description shows "Generating summary…" beside the fallback
text. When configuration is absent or generation fails, native rows retain
their original question or report; GitHub rows direct the reader to the
original context. The result is a reading aid, not a change to the underlying
work. The stored action summaries above behave independently.
