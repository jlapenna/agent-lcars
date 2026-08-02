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
request ID, canonical repository, pipeline, optional title, and description.
Every mutation boundary requires that repository. The Server Action resolves it
against the configured watched repositories before GitHub is called.

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
an annotated tag containing the request ID and digest, then atomically creates
`refs/tags/agent-lcars/quick-task/<uuid>` in the selected repository. Only the
winner may create the issue. A losing App Hosting instance rechecks the issue
marker and otherwise fails closed; it never performs another create. Successful
claims remain as the durable idempotency ledger.

A definitive GitHub 4xx proves no issue was created, so its claim is released.
After an ambiguous timeout the claim remains: a later retry either finds the
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

A definitive GitHub 4xx response, including an invalid label, is returned
without a recovery create. Multiple issues bearing the same request ID fail
closed for manual reconciliation instead of choosing one silently. The console
token therefore needs Issues write and Contents write access to every repository
whose Quick Task integration is enabled; Contents write is used only for the
claim tag ledger.

## Compatibility removal checkpoint

The old positional Server Action arguments, implicit primary-repository
fallback, `{ number, url }` response, and second `addLabels` write were removed
with issue #303. No compatibility reader remains. Any later compatibility code
must name its producer, evidence window, and removal issue; the final #307
migration audit must confirm no pre-#303 caller or marker format is still in
service before closing the reliability program.
