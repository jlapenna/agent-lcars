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
submissions in the serving process share one promise. Production is explicitly
capped at one App Hosting instance so separate containers cannot race past that
coordinator. The persisted marker provides replay across process restarts and
ambiguous timeouts.

A definitive GitHub 4xx response, including an invalid label, is returned
without a recovery create. Multiple issues bearing the same request ID fail
closed for manual reconciliation instead of choosing one silently.

## Compatibility removal checkpoint

The old positional Server Action arguments, implicit primary-repository
fallback, `{ number, url }` response, and second `addLabels` write were removed
with issue #303. No compatibility reader remains. Any later compatibility code
must name its producer, evidence window, and removal issue; the final #307
migration audit must confirm no pre-#303 caller or marker format is still in
service before closing the reliability program.
