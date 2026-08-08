# Remote-agent trajectory evaluation

Workflow color is not an agent-quality score. A red run can be an expired
credential before the first model turn, while a green run can still lack a
correct durable result. The trajectory evaluator keeps those stages separate
and provides two repeatable views:

- a reviewed, frozen release corpus for like-for-like comparisons; and
- a configurable rolling window of recent production metadata for detecting
  operational drift.

The evaluator lives in `tools/trajectory-evaluation/`. Its runtime uses only
Node built-ins; the scheduled workflow is
`.github/workflows/trajectory-evaluation.yml`.

## Data model

`schema/v1.schema.json` is the portable JSON Schema. `schema.mjs` is the
runtime validator used by the CLI and tests. A corpus entry scores six stages
independently:

1. `setup` records worker/provider readiness and whether a model turn was
   actually observed.
2. `protocol` records takeover, progress, durable-result, and terminal-behavior
   observations without converting unknown evidence into a pass or failure.
3. `trajectory` classifies productive work, a repeated loop, tool/provider
   trouble, or a run that never started.
4. `terminal` identifies startup/provider/trajectory failure, correct park,
   correct no-op, outcome-gate false negative, merged deliverable, duplicate,
   or an as-yet unreviewed success.
5. `quality` keeps acceptance, CI, review, merge, and later regression evidence
   distinct. A PR reference and green CI never imply semantic correctness.
6. `efficiency` records queue/model/first-artifact time, retries, and runner
   consumption.

Every entry also carries its repository and task class, dispatch generation,
workflow SHA, agent/provider/model/budget, task and dispatch-brief snapshots,
milestones, artifact references, and annotation provenance. `null` and
`unknown` are deliberate: the evaluator does not invent precision when an old
run lacks a preserved timestamp or transcript.

Automatically inferred observations live under `annotations.automatic`, with
their source references and confidence. Semantic usefulness and correctness
live only under `annotations.human`, with reviewer, review time, confidence,
and notes. Rolling records are deliberately unreviewed (`human: null`). A
release corpus must not be called reviewed until a person has inspected the
referenced run and durable result.

## Frozen #523 cohort

`corpus/v1/issue-523.json` freezes the exact audit population: the 20 most
recent completed, non-skipped Claude, Codex, or OpenCode worker runs at the
2026-08-04 15:31:10 UTC cutoff. The selection is chronological rather than
outcome-based, so failures are not silently dropped. The manifest contains the
exact workflow run IDs and immutable GitHub references used by the audit.

The deterministic report reproduces the published figures:

- raw workflow success: 10/20;
- pre-model failure: 8/20;
- useful result conditional on a model turn: 11/12;
- merged, green deliverables: 8;
- reviewed protocol adherence: 11/12; and
- one useful no-op rejected by the old deliverable gate.

Historical dispatch briefs were not retained when those runs occurred. The
frozen manifest therefore says `reference-only` instead of pretending a later
issue body is the exact old task snapshot. Current worker workflows preserve
the last-responsible-moment dispatch brief as a protected, 30-day Actions
artifact before model execution. New rolling corpora reference that protected
artifact without embedding or downloading its contents. This is the source
for an authorized reviewer who needs the exact dispatch-time snapshot. The
archive step is fail-soft, so an Actions artifact outage cannot block the
agent run it is observing.

Run the fixed report locally:

```sh
pnpm trajectory:validate
pnpm trajectory:report
```

To create a new release corpus, copy a rolling manifest to a new versioned
path, freeze its selection window and run IDs, then review every entry. Do not
overwrite an existing frozen corpus or reuse its `corpusId`.

## Rolling production report

Collection is read-only and limited to `GET` requests against
`https://api.github.com`. It reads repository metadata, completed worker runs,
job steps, issue metadata, and artifact references. It has no method for
editing issues, pull requests, labels, branches, dispatch ledgers, Firestore,
or any cloud resource.

```sh
GH_TOKEN="$(gh auth token)" pnpm trajectory:collect -- \
  --repository jlapenna/agent-lcars \
  --days 14 \
  --limit 100 \
  --output /tmp/trajectory-corpus.json \
  --report /tmp/trajectory-report.md
```

`--days` accepts 1-90 and `--limit` accepts 1-300. An empty window is valid and
produces a zero-sample report rather than failing the workflow. Output files
are created with mode `0600`.

The weekly workflow exposes the same repository/window/limit inputs and
uploads the rolling manifest, rolling report, frozen report, and reviewed
variant comparison as run-scoped artifacts. Its permissions are only
`actions: read`, `contents: read`, `issues: read`, and
`pull-requests: read`; it runs on `ubuntu-latest` and receives no cloud,
controller, or self-hosted-runner credential.

## Privacy boundary

Corpus generation applies `agent-lcars.trajectory-redaction/v1` before
validation or output:

- credential-named keys and common token/private-key shapes become
  `[REDACTED]`;
- private-repository issue content remains `reference-only`;
- public issue bodies are represented by a hash and parsed acceptance text,
  not copied wholesale;
- dispatch briefs and sanitized trajectory archives remain protected Actions
  artifact references; and
- unrestricted environment data, raw authentication output, and transcript
  content are never accepted into the manifest.

`assertPrivacySafe` rejects embedded private content, credential-shaped
values, non-protected trajectory references, and trajectory objects that try
to include raw content. The schema's `access` field describes the existing
source's access boundary; it does not grant new access.

## Offline comparison and replay boundary

`variants/issue-523-reliability-v1.json` is the first reviewed candidate. It
models three changes from #523: reject known setup failures before allocating
a worker, accept the structured already-resolved result, and turn the
OpenCode repeated-state trajectory into an evidence-backed park at the
no-artifact checkpoint.

```sh
pnpm trajectory:compare
```

The comparison reports baseline and candidate metrics overall, by agent, and
by task class. It explicitly checks startup availability, protocol adherence,
looping/timeouts, time to first durable artifact, and accepted outcome. Every
changed entry requires a reviewer, timestamp, confidence, and rationale.

This is a reviewed counterfactual, not a claim that the candidate achieved
those results in production. `offline-replay.mjs` imports only local file,
schema, redaction, and reporting modules. It has no GitHub client, network
transport, subprocess, cloud SDK, secret input, or dispatch-storage adapter.
Consequently the offline path cannot mutate production issues, PRs, labels,
branches, secrets, dispatch ledgers, or Firestore. Actual prompt/model changes
still require an isolated execution followed by human semantic review before
their counterfactual result may be promoted to observed evidence.

## Using the report for decisions

Use stage and task-class evidence, not one aggregate win rate:

- **Routing:** compare agents within the same task class and require a useful
  model-start denominator. Do not route away from a model because its worker
  credential failed before it ran.
- **Setup changes:** lead with startup availability and runner minutes lost
  before model work. Keep model-quality metrics unchanged until a model turn
  is observed.
- **Prompt changes:** require no regression in reviewed protocol adherence,
  repeated-state/timeout rate, time to first artifact, accepted outcome, and
  semantic review. A faster PR that is wrong is a regression.
- **Rollout:** evaluate the frozen corpus first, then a bounded production
  cohort. Record the candidate's workflow SHA and keep the prior setup/prompt
  immediately recoverable.
- **Rollback:** roll back when a high-confidence task class regresses in
  acceptance or correctness, when startup availability drops, or when loops
  and timeouts rise materially. Treat low-sample changes as inconclusive, not
  proof of improvement.
- **Easy-task bias:** preserve a chronological cohort and report every task
  class separately. Never remove parks, no-ops, startup failures, ambiguous
  tasks, or long investigations merely because they lower the aggregate. A
  candidate must not ship on aggregate gains that hide a regression in a
  harder class.

The frozen corpus is a decision aid, not a leaderboard. Human review remains
the authority for whether the requested work was actually satisfied.
