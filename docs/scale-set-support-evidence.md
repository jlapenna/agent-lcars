# Scale-set Support evidence

GitHub Support ticket #4758522 requested batch-level evidence on September 24,
2026 for issue #1716. Nonzero assigned demand and acknowledged batches alone do
not prove those batches contained a particular stranded job, or what placement
followed. The cause and an original-attempt recovery procedure remain unproven.

At info level, the autoscaler records each decoded batch **before processing**,
including synthetic initial statistics (`initial=true`, `message_id=-1`). Records
carry `scale_set`, `session_id`, and `message_id`; idle reconciliation carries
`idle_poll=true` instead of inventing a batch ID. Job arrays are JSON strings in
`job_available`, `job_assigned`, `job_started`, and `job_completed`, preserving
field names with the production logfmt handler. Statistics use named fields.
Acquisition, capacity decisions/results, JIT registration creation, and successful
container placement retain the callback's correlation fields. Container placement
is not proof that a runner connected or accepted a job: correlate the runner name
with subsequent job-start events and runner diagnostics.

`Scale-set batch acknowledged` is emitted only after `DeleteMessage` succeeds.
Processing failure and acknowledgment failure are separate events. Session open,
close, and polling failures make reconnect gaps visible. Existing host-placement
logs remain useful detail alongside the correlated capacity result. No session
object, message-queue token, acquisition URL, authorization header, or JIT payload
is serialized by the new diagnostic records.

## Capture the next recurrence

1. Record the exact UTC queue/start/stall interval, workflow run and job links,
   scale set, runner names, and active session ID. Preserve the original attempt.
2. Export the **whole scale-set window**, starting at least five minutes before
   queueing and ending after recovery/completion, including surrounding jobs.
   Do not filter only to the stranded job or to errors. Retain session transitions
   and the autoscaler revision/image identity alongside the export.
3. In Loki, select `{container="runner-autoscaler"}` and the relevant time range.
   Vector stores the autoscaler logfmt line inside the outer JSON `message` field.
   Parse that field as logfmt, then decode the four job-array JSON strings. Keep
   the original records too. Include runner-container diagnostics for the named
   runners when distinguishing container start from GitHub connection/job start.
4. Check export pagination/limits and ingestion errors so a truncated result is
   not mistaken for a complete interval. Preserve the evidence before retention
   expires, inspect it for credentials, then provide it to Support only through
   an authorized communication step.

Read-only verification on September 26, 2026 found the existing session records
in Loki (for example, `homelab-autoscale-e2e-light` at
`2026-09-25T19:45:46.105Z`). The live Loki `/loki` data directory is a host bind
mount, independent of the autoscaler container. Homelab's configuration specifies
seven-day retention for these Docker logs. This proves the existing ingestion
and external-storage path, **not** ingestion of these newly added records.
After normal deployment, confirm the deployed revision and retrieve a new batch,
its correlated decision/result, and acknowledgment before grading diagnostics as
live. Closing #1716 additionally requires the causal recurrence evidence and
Support's analysis/recovery guidance; merging this instrumentation is insufficient.
