# App Hosting stale-revision audit

`tools/apphosting-stale-revision-audit.mjs` evaluates a recorded App Hosting
backend response and a recorded Cloud Run revision list. It is deliberately an
offline, report-only tool: it reads a JSON file and emits a report. It has no
Google Cloud client, credentials, network calls, traffic mutation, revision
deletion, or deployment path.

## Run against a recorded response

The fixture envelope is versioned as `apphosting-stale-revision/v1`:

```bash
node tools/apphosting-stale-revision-audit.mjs \
  --fixture tools/apphosting-stale-revision-audit/fixtures/alert.json \
  --format markdown
```

Use `--format json` for machine-readable output. `--output <file>` writes a
local report with mode `0600`; omit it to print to stdout. The input must be a
recorded response already obtained through an approved read-only observation
path. The command never fetches the APIs itself.

The audit sorts revisions by their recorded creation timestamp. It alerts only
when the backend Ready condition is `False` and the newest Cloud Run revision's
Ready condition is `True`. The report lists only revisions whose Ready
condition is `False`, whose total recorded traffic is explicitly zero, and
whose App Hosting build-and-rollout linkage is present and belongs to the
audited backend. Missing or malformed fields are never guessed into an alert.

## Safe remediation

The alert is evidence for an operator, not an authorization to change the
control plane. First inspect the linked build and rollout in the App Hosting
console or an approved read-only API path, confirm the serving revision and
traffic state, and follow the platform's documented rollback/revision-cleanup
procedure with maintainer approval. Any eventual cleanup or traffic change is a
separate, explicitly reviewed operation. Do not delete a revision, change
traffic, or deploy from this audit command.
