# Quick Task identity and retry contract

A Quick Task is identified by a canonical `TaskRef`:

```ts
{
  repository: {
    owner: string;
    name: string;
  }
  issueNumber: number;
}
```

Issue numbers are only unique inside a repository. Links, UI notices, joins,
and future telemetry must retain both parts; aliases are display-only and
never participate in identity.

## Submission contract

The browser creates one UUID v4 for a user intent and sends a complete request:
request ID, canonical repository, pipeline, and the previewed issue body. The
server derives the issue title from that body's first line. Every mutation
boundary requires the repository. The Server Action resolves it against the
configured watched repositories before GitHub is called.

The intake dialog keeps a free-form description as its only required field. An
optional guided section can add Observed, Expected, Steps to reproduce, Done
when, and evidence links. Before submission, the dialog previews the derived
title and exact human-readable body. That body also contains an editable source
block with the selected canonical repository, capture time, sanitized console
route, and any Task, pull request, workflow-run, or session identity supplied by
the detail page.

Automatic route capture is allowlist-based. It serializes only known console
paths and query parameters whose values match the route's typed contract. It
never copies the origin, URL credentials, fragment, free-form search query, or
an unknown query parameter. New parameters remain private until the sanitizer
explicitly learns their safe value shape. The hidden marker described below is
appended by the server after the human-readable preview.

## Screenshot evidence contract

The future screenshot picker uses the frozen multipart and gateway contract in
[Quick Task evidence](quick-task-evidence.md). An optional image receives a
separate UUID v4 evidence ID, while the existing request ID remains the
idempotency key for the Quick Task itself. The browser sends the raw file and
intent only; it never constructs a gateway URL or Markdown image link. The
server derives both from trusted deployment configuration before it enters the
existing claim and issue-create protocol.

The issue is created in one GitHub write with both `intake:quick-task` and the
selected repository integration's `agent:*` label. There is no intermediate
unroutable issue and no follow-up label mutation.

The normalized request is hashed and persisted in the issue body as a hidden
versioned marker:

```text
<!-- agent-lcars:quick-task-request:v1 id=<uuid> digest=<sha256> -->
```

Before creation, and again after an ambiguous transport failure, the server
looks for that marker. A retry with the same ID and content returns the original
`TaskRef`; the same ID with different content fails with a conflict. Concurrent
submissions in one process share one promise.

Cross-process exclusion is a GitHub-native claim, not a deployment topology
assumption or a second control plane. Before the issue write, the server creates
an annotated tag containing the request ID, digest, and a server-generated
claimant UUID, then atomically creates
`refs/tags/agent-lcars/quick-task/<uuid>` in the selected repository. Only the
winner may create the issue. If the ref write succeeds but its response is lost,
the claimant UUID lets that same invocation prove it owns the durable ref and
continue safely. A different App Hosting instance rechecks the issue marker and
otherwise fails closed; it never performs another create. Successful claims
remain as the durable idempotency ledger.

The LCARS issue editor hides the machine marker from the body field. When an
admin deliberately changes a Quick Task title or description, the server first
verifies the existing marker against the current content and original pipeline,
then rewrites that issue marker with a digest of the edited content. The claim
tag remains the immutable record of the original create attempt. A later retry
of the original browser request therefore conflicts instead of silently
overwriting or duplicating the now-edited task; broker normalization continues
to validate and dispatch the edited task normally.

A definitive GitHub 4xx other than `408 Request Timeout` proves no issue was
created, so its claim is released. A 408 is ambiguous just like a transport
timeout: the upstream write may have committed before the response was lost.
After an ambiguous timeout the claim remains; a later retry either finds the
issue marker or continues to fail closed. If the remote create truly never
committed, an operator must wait for the original create attempt to settle,
confirm no matching issue exists, and delete that single claim tag before
retrying:

```sh
gh api --method DELETE \
  repos/OWNER/REPO/git/refs/tags/agent-lcars/quick-task/REQUEST_UUID
```

Claim tags must not otherwise be deleted. This deliberate
manual-reconciliation edge is what preserves the at-most-one invariant across
two APIs that cannot share a transaction.

A definitive GitHub 4xx response other than 408, including an invalid label, is
returned without a recovery create. Multiple issues bearing the same request ID
fail closed for manual reconciliation instead of choosing one silently. The
console token therefore needs Issues write and Contents write access to every
repository whose Quick Task integration is enabled; Contents write is used only
for the claim tag ledger.

## Compatibility removal checkpoint

The old positional Server Action arguments, implicit primary-repository
fallback, `{ number, url }` response, and second `addLabels` write were removed
with issue #303. No compatibility reader remains. Any later compatibility code
must name its producer, evidence window, and removal issue; the final #307
migration audit must confirm no pre-#303 caller or marker format is still in
service before closing the reliability program.

**2026-08-02 — final #307 migration audit.** `createQuickTask` (`apps/console/src/app/actions.ts`) takes a single `QuickTaskRequest` object with an explicit required `repository`, never positional arguments or an implicit primary-repo fallback; no caller constructs or reads a bare `{ number, url }` response; no second `addLabels` write exists anywhere in the create path. No pre-#303 caller or marker format remains in service. Separately, `.github/workflows/codex.yml`'s permanently-disabled `if: ${{ false }}` legacy queue hand-off step (the in-workflow "dispatch the next unclaimed codex issue" chain) was removed: the v1 dispatch broker (`.github/actions/dispatch-broker/broker.mjs`'s `completeRun`/`markDispatchRejected` promoting a `pending` generation, `main.mjs`'s `dispatchAccepted()` re-dispatching it) has owned that hand-off in production since #304/#305 shipped, and production run history confirms codex dispatches flow exclusively through it. See PR closing #307 for the full evidence trail. The `legacy`/`legacy-title` attribution in `logical-work.ts`/`cli-sessions.ts` is intentionally out of scope — it is permanent graceful degradation for pre-ledger issues, not migration-compat code.
