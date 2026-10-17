# Human-needed handoff summaries

Console performs a bounded LLM pass when an authenticated run completion
reports `park` with a nonblank final message. It stores 2–3 short actions on
that exact run as `result.humanNeededActions`; the original `message` remains
unchanged. Commands sort first and must be exact excerpts from the handoff.
The summary is a reading aid, never an authorization or an executable action.

The native and GitHub Inbox detail panes show the current parked run's
summary, and both task history pages retain the summary beside that round's
full handoff. A new run cannot inherit an older summary. Older parks and
label-only GitHub decisions have no generated summary; there is no backfill.

## Server configuration

Configure these three settings together on the Console runtime:

| Setting                               | Value                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `AGENT_LCARS_HANDOFF_SUMMARY_URL`     | Full HTTPS URL of a trusted OpenAI-compatible `/chat/completions` endpoint |
| `AGENT_LCARS_HANDOFF_SUMMARY_MODEL`   | An endpoint-supported small model with JSON object response support        |
| `AGENT_LCARS_HANDOFF_SUMMARY_API_KEY` | Dedicated server credential from Secret Manager                            |

There is no implicit provider, endpoint, or reuse of worker subscription
credentials. With all three absent, Console keeps the existing full-handoff
behavior. Partial or insecure configuration fails startup. The owning
deployment/credential workflow must provision and bind the dedicated secret;
source publication alone does not enable this feature in production. Never
put secret values in application configuration or Terraform.

The request sends only the bounded final handoff message (up to 16 KiB),
requests JSON with a 1,200-token output cap, permits no tools or redirects,
and allows at most eight seconds with no retry. The timeout is shortened to
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
