# Human-needed handoff summaries

Console performs a bounded LLM pass when an authenticated run completion
reports `park` with a nonblank final message. It stores 2–3 short actions on
that exact run as `result.humanNeededActions`; the original `message` remains
unchanged. Commands sort first and must be exact excerpts from the handoff.
The summary is a reading aid, never an authorization or an executable action.

The native and GitHub Inbox detail panes show the current parked run's
summary, and both task history pages retain the summary beside that round's
full handoff. A new run cannot inherit an older summary. Older parks and
label-only GitHub decisions have no stored action summary; those historical
run records are not backfilled. They can still receive the display-time Inbox
descriptions below.

## Summary types and precedence

The current decision description is the primary reading aid in an Inbox detail
pane. A stored action summary is available in a collapsed **Earlier handoff ·
AI summary** disclosure, explicitly identified as historical:

| Reading aid                                         | Source and lifetime                                                                                                                      | Display                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Decision description                                | Current bounded issue/comment or native handoff context and decision state; cached at display time and refreshed when that input changes | Inbox row and detail, including older parks, label-only decisions, and completed reports |
| Stored action summary (`result.humanNeededActions`) | The final handoff of one authenticated parked run; generated once at completion and retained with that run                               | Current parked-run detail and that round's task history                                  |

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
and allows at most 30 seconds with no retry. The timeout is shortened to
leave five seconds before the effective run deadline for settlement; with five
seconds or less remaining, Console skips the optional call. The streamed response
is capped at 64 KiB before decoding or JSON parsing, and must contain exactly
one choice. Unread response data is canceled on failure. Non-park outcomes make
no LLM call. Invalid output, invented commands, timeout and upstream failure all
preserve normal completion and the complete original message. The log records
only that the optional summary was unavailable, never its contents or upstream
error body. Failed summaries are not regenerated on page refresh.

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

Descriptions stream independently behind Suspense so the queue and reply
controls do not wait for the model. Up to four requests run concurrently per
Console process; queue time shares the 30-second request budget. Next's
server cache keys descriptions by the bounded source content and its revision,
so changed comments, handoffs or decision state select a new summary. Successful
results revalidate after a day; unavailable results retry after a minute.
This is a cached reading aid, not a persisted change to the underlying work.
When configuration is absent or generation fails, native rows retain their
original question or report; GitHub rows direct the reader to the original context.
Opening a selected item skips summary work for the hidden rows. The completion-time stored action summaries
above continue to behave independently.
