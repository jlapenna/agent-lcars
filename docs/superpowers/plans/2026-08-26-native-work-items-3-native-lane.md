# Native Work Items — Plan 3: the native lane path, protocol, and end-to-end proof

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native work item created through Plan 2's API or console page is dispatched to GitHub Actions, worked by an agent with no issue anywhere, completed back to the control plane by run ID, and shows `done` with its PR — proven by one real end-to-end run.

**Architecture:** The worker workflows (`claude.yml`, `codex.yml`, `opencode.yml`) accept either anchor: `issue` (unchanged) or a `work` JSON input. Every lane step that reads the issue gets a native branch or a skip; the dispatch brief (`prepare.sh`) builds a `work` anchor from the input instead of calling GitHub; `verify-deliverable` finds the PR by claim marker alone; the finalizer completes by `runId` with no `issue`. `agent-protocol` gains a short native-mode section. The last task is the real-path proof.

**Tech Stack:** GitHub Actions (`workflow_dispatch`, reusable workflows, composite actions), bash + `jq`, TypeScript (dispatch drain), Vitest, the repo's workflow contract tests.

**Spec:** `docs/superpowers/specs/2026-08-23-native-work-items-design.md` — "Backend 1", "Runs", "Dispatched-agent protocol in native mode", "Testing". Requires Plans 1 and 2 merged.

## Global Constraints

- Label-driven work is byte-identical in behavior: every change is gated on `inputs.work != ''` or `inputs.issue == ''`; no step that runs today for an issue anchor changes for it.
- `workflow_dispatch` inputs stay ≤ 10 per workflow (today 8; this plan adds exactly one, `work`). The `work` input is the JSON `{ "id": "<ulid>", "spec": { title, description, pipeline, target: { repo } } }`; `spec.description` ≤ 16,384 chars keeps the total input payload under GitHub's 65,535-character limit.
- `run-name` and the dispatch marker keep the exact `[dispatch:g<generation>:<intentId>]` form for both anchors (Plan 1 pinned that the grammar accepts `work:<ulid>/r<n>`).
- The agent job's OIDC token is never accepted by the control plane; completion is posted only by the finalizer job (Plan 1's rule), now by `runId` with `issue` omitted for native anchors.
- The deliverable gate for a native item is the PR carrying this run's exact `<!-- attempt-claim:<ATTEMPT_ID> -->` marker; no comment or review lookups (there is no issue).
- No `gh issue`/reaction/label calls on a native run: claim, eyes-reaction, progress comment, parking label, outcome comment are all skipped; the agent's status channel is `lcars session title/status`.
- Every workflow change is covered by the existing workflow contract tests (`.github/actions/published-actions.contract.test.mjs` and the `*.test.sh` beside each action) plus the new cases below; no real git in unit tests.
- Every commit: worktree, tests run, conventional message, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push early; CI `Verify` is the gate.

## File Structure

| File                                                                                                                        | Responsibility                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `.github/workflows/claude.yml`, `codex.yml`, `opencode.yml` (modify)                                                        | `issue` optional, `work` input, job gates, `run-name`                       |
| `.github/workflows/agent-lane.yml`, `agent-lane-claude.yml` (and the codex/opencode lanes if they wrap separately) (modify) | `work` input threaded through; native branches/skips on issue-reading steps |
| `.github/workflows/agent-fallback-finalize.yml` (modify)                                                                    | `issue` optional; payload omits `issue`; `INTENT_ID` already present        |
| `.github/actions/prepare-agent-dispatch/{action.yml,prepare.sh,prepare.test.sh}` (modify)                                   | `work` input → native anchor in the brief, no GitHub reads                  |
| `.github/actions/dispatch-bootstrap/action.yml` (modify)                                                                    | claim step conditional on `issue`                                           |
| `.github/actions/verify-deliverable/{action.yml,verify-deliverable.sh}` + test (modify)                                     | `issue` optional; PR-marker-only mode                                       |
| `.github/actions/telemetry-start/action.yml` (modify)                                                                       | `issue` optional                                                            |
| `.github/actions/report-failure/*` (modify)                                                                                 | skip GitHub posting without an issue                                        |
| `apps/console/src/lib/orchestrator-dispatch.ts` + test (modify)                                                             | `work` input shape `{ id, spec }`                                           |
| `agents/shared/skills/agent-protocol/reference/agent-protocol.md` (modify)                                                  | "Native mode" section                                                       |
| `.claude/skills/lcars/lcars-protocol-reference.md` (modify)                                                                 | one paragraph on native dispatch                                            |
| `docs/native-work-smoke-runbook.md` (create)                                                                                | the end-to-end proof, recorded                                              |

Line numbers reference `main` after Plan 2 merges; re-locate by quoted code if drifted.

---

### Task 1: Dispatch drain emits the `work` input in its final shape

**Files:**

- Modify: `apps/console/src/lib/orchestrator-dispatch.ts` (the native `inputs` branch from Plan 1)
- Test: `apps/console/src/lib/orchestrator-dispatch.test.ts`

**Interfaces:**

- Produces: for a native run, `inputs = { work: JSON.stringify({ id: task.workId, spec }), mode: 'implement', broker_intent_id, broker_generation, broker_dispatch_token }` where `spec` is `task.work.spec` validated by `workSpecSchema` from `@agent-lcars/work`. No `issue`, `reply`, `runbook`, `context` keys.

- [ ] **Step 1: Update the test**

In `orchestrator-dispatch.test.ts`, change the native dispatch test's expectation to:

```ts
expect(JSON.parse(body.inputs.work)).toEqual({
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  spec: {
    title: 'x',
    description: 'd',
    pipeline: 'claude',
    target: { repo: 'octo/example' },
  },
});
expect(Object.keys(body.inputs).sort()).toEqual([
  'broker_dispatch_token',
  'broker_generation',
  'broker_intent_id',
  'mode',
  'work',
]);
```

and give the seeded task a full spec (`{ title: 'x', description: 'd', pipeline: 'claude', target: { repo: 'octo/example' } }`) with an `origin`.

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- orchestrator-dispatch` → FAIL (`id` is an object; extra keys).

- [ ] **Step 3: Implement**

Replace the native branch's `work:` line with:

```ts
          work: JSON.stringify({
            id: run.task.workId,
            spec: workSpecSchema.parse(task?.work?.['spec']),
          }),
```

(import `workSpecSchema` from `@agent-lcars/work`; `run.task` is narrowed to the work anchor in this branch — use `isWorkAnchor(run.task)` to branch instead of `target.issue === undefined` if the narrowing needs it). A spec that fails validation is permanent: settle the entry `done` and record `failed` exactly as the `UnresolvableAnchor` path does.

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- orchestrator-dispatch && ./tools/nx typecheck @agent-lcars/console` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib
git commit -m "feat(console): dispatch native runs with the work input in its workflow shape

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Worker workflows accept either anchor

**Files:**

- Modify: `.github/workflows/claude.yml:18-34, 81-84, 122-131`, `.github/workflows/codex.yml` (same regions; `run-name` at :24, gates at :72, …), `.github/workflows/opencode.yml` (`run-name` :22, gates :83, :146, :155)
- Modify: `.github/workflows/agent-lane.yml` (`workflow_call` inputs), `.github/workflows/agent-lane-claude.yml` (pass-through) and the codex/opencode wrappers
- Modify: `.github/workflows/agent-fallback-finalize.yml:40-42` (`issue` optional), `:270-292` (payload)
- Test: `.github/actions/published-actions.contract.test.mjs` (extend), plus a new `tools/workflow-anchor-gates.test.sh`

**Interfaces:**

- Produces: `workflow_dispatch` input `work` (string, `required: false`, `default: ''`) on all three workers; `issue` becomes `required: false`; job `if:` gates accept either anchor; `run-name` renders `#<issue>` or `work:<ulid>`; the lane and finalizer receive `work`.

- [ ] **Step 1: Write the failing contract test**

```bash
# tools/workflow-anchor-gates.test.sh
#!/usr/bin/env bash
# Every worker workflow must accept either anchor: `issue` optional, a
# `work` input, and job gates that admit `work` alone. Pure text
# assertions on the YAML -- no git, no GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
for wf in claude codex opencode; do
  f=".github/workflows/$wf.yml"
  grep -Pzo "issue:\n\s+description:[^\n]*\n\s+required: false" "$f" >/dev/null || { echo "$f: issue must be required: false"; fail=1; }
  grep -q "^      work:$" "$f" || { echo "$f: missing work input"; fail=1; }
  n=$(grep -c "inputs.issue != '' || inputs.work != ''" "$f" || true)
  [ "$n" -ge 2 ] || { echo "$f: expected both job gates to accept either anchor (found $n)"; fail=1; }
  grep -q "inputs.work" ".github/workflows/agent-fallback-finalize.yml" || { echo "finalizer must receive work"; fail=1; }
  count=$(awk '/workflow_dispatch:/{f=1} f&&/^      [a-z_]+:$/{n++} /^jobs:/{exit} END{print n}' "$f")
  [ "$count" -le 10 ] || { echo "$f: $count inputs exceeds GitHub's limit of 10"; fail=1; }
done
exit $fail
```

Register it wherever the repo runs `*.test.sh` in CI (grep `ci.yml` for `nx-remote-cache-read-failure.test.sh` and add this one beside it).

- [ ] **Step 2: Run to verify it fails** — `bash tools/workflow-anchor-gates.test.sh` → exits 1 (missing `work`, `issue` required).

- [ ] **Step 3: Edit the three worker workflows**

For each of `claude.yml`, `codex.yml`, `opencode.yml`:

1. `run-name`:
   ```yaml
   run-name: '${{ inputs.issue != '''' && format(''#{0}'', inputs.issue) || format(''work:{0}'', fromJSON(inputs.work || ''{"id":""}'').id) }}: Claude issue agent [dispatch:g${{ inputs.broker_generation }}:${{ inputs.broker_intent_id }}]'
   ```
   (keep each workflow's own agent name; the marker tail is unchanged).
2. Inputs: `issue` → `required: false`, `default: ''`; add after `context`:
   ```yaml
   work:
     description: 'Native work item JSON {id, spec} (mutually exclusive with issue)'
     required: false
     default: ''
   ```
3. Both job gates: `if: github.event_name == 'workflow_dispatch' && (inputs.issue != '' || inputs.work != '')` (the finalize job keeps its `always() &&` prefix).
4. Lane call: add `work: ${{ inputs.work }}`; finalizer call: add `work: ${{ inputs.work }}`.

`agent-lane.yml` `workflow_call` inputs: add `work:` (`type: string`, `required: false`, `default: ''`) after `issue`; make `issue` `required: false` if it is required today. `agent-lane-claude.yml` (and the codex/opencode wrappers): pass `work: ${{ inputs.work }}` through.

`agent-fallback-finalize.yml`: `issue` `required: false`; add `work` input (string, optional); in the payload `jq`, make `issue` conditional:

```bash
          jq -cn '
            (if env.ISSUE != "" then {issue: (env.ISSUE | tonumber)} else {} end)
            + {
              generation: (env.GENERATION | tonumber),
              intentId: env.INTENT_ID,
              token: env.DISPATCH_TOKEN,
              workflow: env.WORKER_WORKFLOW
            }
            + (if env.OUTCOME_KIND != "" then {outcome: env.OUTCOME_KIND} else {} end)
            + (if env.OUTCOME_REFERENCE != "" then {
                outcomeReference: { kind: "pull-request", number: (env.OUTCOME_REFERENCE | tonumber) }
              } else {} end)
          ' > "$payload_file"
```

and in "Derive trusted completion evidence" (`:89-110`), wrap the `case "$ISSUE:$GENERATION"` validation so an empty `ISSUE` with a non-empty `WORK` is accepted (`if [ -z "$ISSUE" ] && [ -n "$WORK" ]; then :; else <existing case>; fi`), and skip the `gh api repos/$REPO/issues/$ISSUE…` evidence reads (`:200-230`) when `ISSUE` is empty — the PR evidence read by marker (`repos/$REPO/pulls?state=all`, as `verify-deliverable.sh` does) stays.

- [ ] **Step 4: Run** — `bash tools/workflow-anchor-gates.test.sh && node --test .github/actions/published-actions.contract.test.mjs` (or however that file is run in CI — check `ci.yml`) → PASS. Also `pnpm format:check` (prettier covers YAML).

- [ ] **Step 5: Commit and push**

```bash
git add .github tools/workflow-anchor-gates.test.sh
git commit -m "ci(agents): worker workflows accept a native work anchor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin HEAD
```

---

### Task 3: The lane's issue-reading steps get native branches

**Files:**

- Modify: `.github/workflows/agent-lane.yml` — the steps at (post-Plan-1 line numbers) ~587 (claim), ~649/~1043 (prepare-agent-dispatch), ~692 (dispatch-bootstrap), ~801/~810 (telemetry-start), ~1088 (`NUM`), ~1423/~1467 (`ISSUE` env for failure report / finalize), ~1504 (`CURRENT`)
- Modify: `.github/actions/dispatch-bootstrap/action.yml:177-182` (claim step `if`)
- Modify: `.github/actions/telemetry-start/action.yml` (`issue` optional)
- Modify: `.github/actions/report-failure/*` (skip GitHub calls when no issue)
- Test: the actions' `*.test.sh` files (extend `dispatch-bootstrap`/`report-failure` tests if they exist; otherwise the workflow contract test)

**Interfaces:**

- Consumes: `inputs.work` on the lane (Task 2).
- Produces: a native run reaches the agent step with `ATTEMPT_ID`, telemetry, and the dispatch brief, and never calls a `gh issue`/reaction/label endpoint.

- [ ] **Step 1: Write the failing assertions**

Extend `tools/workflow-anchor-gates.test.sh` with:

```bash
lane=.github/workflows/agent-lane.yml
grep -q "work: \${{ inputs.work }}" "$lane" || { echo "lane: prepare-agent-dispatch must receive work"; fail=1; }
grep -Pzo "Claim the issue as the agent fleet\n(\s+#[^\n]*\n)*\s+if: [^\n]*inputs\.issue != ''" "$lane" >/dev/null || { echo "lane: claim step must be gated on issue"; fail=1; }
grep -q "INTENT_ID: \${{ inputs.broker-intent-id }}" "$lane" || { echo "lane: sidecar must receive INTENT_ID"; fail=1; }
```

- [ ] **Step 2: Run to verify it fails** — `bash tools/workflow-anchor-gates.test.sh` → exits 1.

- [ ] **Step 3: Edit the lane**

- **Claim the issue** (~587): add `if: inputs.issue != ''`.
- **Prepare dispatch context** (both uses, ~649 and ~1043): add `work: ${{ inputs.work }}` to `with:`.
- **Dispatch bootstrap** (~692): unchanged inputs; inside `dispatch-bootstrap/action.yml` the "Claim the issue as the agent fleet" step (`:177`) gets `if: inputs.issue != ''`. `ATTEMPT_ID` publishing (`:134-135`) is anchor-agnostic — leave it.
- **telemetry-start** (~801/~810): `issue` stays passed (empty string); in `telemetry-start/action.yml` make `issue` `required: false` and only export `NUM` when non-empty (`sidecar-lifecycle.sh` already skips `--issue-number` when `NUM` is empty).
- **Resolve agent budget** (~1088, `NUM: ${{ inputs.issue }}`): `NUM` may be empty; the step reads the issue only to find a closing issue for a PR anchor — add `if: inputs.issue != ''` if the step is issue-only, otherwise leave it (read the step; note the choice in the report).
- **Failure report / finalize env** (~1423/~1467): `ISSUE` may be empty; `report-failure` must skip its `gh issue comment`/label calls when `ISSUE` is empty and instead print a `::warning::` with the reason (the item reads `parked` from the orchestrator settle). Add `WORK_ID: ${{ fromJSON(inputs.work || '{"id":""}').id }}` next to `ISSUE` so the warning names the item.
- **`CURRENT` (~1504)**: this is the session-title overlay context; when `inputs.issue` is empty pass the work id instead: `CURRENT: ${{ inputs.issue != '' && inputs.issue || fromJSON(inputs.work || '{"id":""}').id }}`.
- **verify-deliverable** step: pass `issue: ${{ inputs.issue }}` unchanged (Task 4 makes it optional).

- [ ] **Step 4: Run** — `bash tools/workflow-anchor-gates.test.sh` and every `.github/actions/*/*.test.sh` you touched → PASS. `pnpm format:check`.

- [ ] **Step 5: Commit and push**

```bash
git add .github tools
git commit -m "ci(agent-lane): native anchor branches for claim, telemetry, failure report

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 4: The dispatch brief and the deliverable gate for native anchors

**Files:**

- Modify: `.github/actions/prepare-agent-dispatch/action.yml` (`work` input), `prepare.sh:55-180`, `prepare.test.sh`
- Modify: `.github/actions/verify-deliverable/action.yml` (`issue` optional), `verify-deliverable.sh:62-115`, its test

**Interfaces:**

- Produces: with `WORK` set, `prepare.sh` writes the brief with `anchor: { type: "work", id, title, body: spec.description, target_repo, html_url: "<console>/work/<id>" }`, `mode: "implement"`, `reply: ""`, `latest_agent_result: null`, `requested_results: ["pull-request"]`, `truncated: []`, and the same `runtime` object — without any `gh api` call. `verify-deliverable.sh` with `NUM` empty checks the PR-marker lookup only.

- [ ] **Step 1: Write the failing tests**

`prepare.test.sh` already builds fixtures and runs `prepare.sh` with a fake `gh`; add a case:

```bash
test_native_work_anchor() {
  export WORK='{"id":"01J5Z3K9QX8F0N2B4V6C8D1E3G","spec":{"title":"Add healthz","description":"Expose GET /healthz.","pipeline":"claude","target":{"repo":"octo/example"}}}'
  export ISSUE=''
  export CONSOLE_URL='https://lcars.test'
  run_prepare
  assert_json_eq '.anchor.type' '"work"'
  assert_json_eq '.anchor.id' '"01J5Z3K9QX8F0N2B4V6C8D1E3G"'
  assert_json_eq '.anchor.title' '"Add healthz"'
  assert_json_eq '.anchor.html_url' '"https://lcars.test/work/01J5Z3K9QX8F0N2B4V6C8D1E3G"'
  assert_json_eq '.requested_results' '["pull-request"]'
  assert_no_gh_calls
}
```

(match the file's actual helper names — read its first 60 lines; `assert_no_gh_calls` may need adding: the fake `gh` records calls to a log file.)

`verify-deliverable.test.sh` (or the action's test): a case with `NUM=''` and a fake `gh` whose `repos/$REPO/pulls` returns a bot PR carrying the marker → exit 0; and `NUM=''` with no PR → exit 1 with `NO_DELIVERABLE=1` and no call to any `/issues/` endpoint.

- [ ] **Step 2: Run to verify they fail** — `bash .github/actions/prepare-agent-dispatch/prepare.test.sh` and the verify-deliverable test → FAIL.

- [ ] **Step 3: Implement**

`prepare-agent-dispatch/action.yml`: add input `work` (`required: false`, `default: ''`), export it as `WORK` to `prepare.sh` alongside `ISSUE`; make `issue` `required: false`.

`prepare.sh`: before `anchor_json="$(gh api …)"` (`:62`), branch:

```bash
if [ -n "${WORK:-}" ]; then
  # Native work item: the anchor is the dispatch input itself. No GitHub
  # reads -- there is no issue, thread, or label to consult.
  work_json="$(jq -c . <<<"$WORK")"
  anchor_json="$(jq -cn --argjson w "$work_json" --arg console "${CONSOLE_URL:-https://lcars.jlapenna.net}" '{
    type: "work",
    id: $w.id,
    title: $w.spec.title,
    body: $w.spec.description,
    target_repo: $w.spec.target.repo,
    html_url: ($console + "/work/" + $w.id),
    labels: [], assignees: [], state: "open", state_reason: null
  }')"
  comments_json='[]'
  reply=''
else
  anchor_json="$(gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE")"
  … existing reads …
fi
```

and in the big `jq` (`:96-180`) keep the existing shape but let `anchor.type` come through as `"work"` when present (`type: ($anchor.type // (if $anchor.pull_request then "pull-request" else "issue" end))`), `requested_results` default to `["pull-request"]` for `work`, and skip the comment-derived fields when `comments_json` is `[]` (they already tolerate empty arrays — verify in the test).

`verify-deliverable/action.yml`: `issue` `required: false`. `verify-deliverable.sh`: replace `: "${NUM:?NUM is required}"` with `NUM="${NUM:-}"`; wrap the comment lookup block (`:97-113`) and the review lookup (`:114-124`) in `if [ -n "$NUM" ]; then … fi`; in the final error message use `${NUM:+#$NUM}${NUM:-this work item}`.

- [ ] **Step 4: Run** — both action tests + `tools/workflow-anchor-gates.test.sh` → PASS.

- [ ] **Step 5: Commit and push**

```bash
git add .github/actions
git commit -m "ci(actions): native work anchor in the dispatch brief; marker-only deliverable gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: Protocol native mode

**Files:**

- Modify: `agents/shared/skills/agent-protocol/reference/agent-protocol.md` (new section after §5, before §6)
- Modify: `agents/shared/skills/agent-protocol/reference/index.md` (index entry)
- Modify: `.claude/skills/lcars/lcars-protocol-reference.md` ("Dispatch" bullets: one paragraph on native dispatch)
- Test: any doc contract test that pins the protocol's section list (`grep -rn "Session status channel" --include=*.test.* --include=*.spec.* .` — extend if one exists)

- [ ] **Step 1: Write the section**

Insert after §5 ("Deliverable rule"):

```markdown
## 5a. Native work items (no issue anchor)

When the dispatch brief's `anchor.type` is `work`, there is no GitHub
issue or pull request anchoring the run. The brief carries the task:
`anchor.title`, `anchor.body` (the requester's description),
`anchor.target_repo`, and `anchor.html_url` (the console page for the
item). Everything above still applies except the issue-side actions,
which have no target:

| Section                           | Issue mode                                                 | Native mode                                                                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §1 Takeover comment               | comment on the anchor                                      | **Skip.** The console derives the takeover affordance from your session doc.                                                                                                                                                                                                   |
| §2 Eyes reaction + assignee claim | `gh api …/reactions`, `…/assignees`                        | **Skip.** The run is acknowledged when dispatch is confirmed.                                                                                                                                                                                                                  |
| §3 One edited progress comment    | `gh issue comment --edit-last`                             | `lcars session title "<what you are doing>"` and `lcars session status "<state>"` — the same channel §12 already requires.                                                                                                                                                     |
| §4 Parking                        | `status:needs-human` label + comment + assignee            | End your response with `PARK <blocker>`; the finalizer reports `ok: false` with your summary and the item reads **parked** in the console. Post nothing to GitHub.                                                                                                             |
| §5 Deliverable rule               | PR (or comment / review) carrying the attempt-claim marker | The PR carrying your exact `<!-- attempt-claim:<ATTEMPT_ID> -->` marker is the only accepted deliverable. Reference the item in the PR body as `Work: work:<id>` (never `Fixes #N`). A no-op is not available: if the request is already satisfied, `PARK` with that evidence. |
| §6–§12                            | unchanged                                                  | unchanged                                                                                                                                                                                                                                                                      |

Do not "helpfully" open an issue to have something to comment on — the
item's page is the record, and the control plane settles it from the
finalizer's completion call.
```

Add the matching line to `reference/index.md`. In `.claude/skills/lcars/lcars-protocol-reference.md`, under "Dispatch", add: native items enter through `PUT /api/work/v1/items/{id}` (Plan 2), are minted as `work:<ulid>/r<n>` runs, dispatched with the `work` workflow input, and completed by the finalizer by `runId`.

- [ ] **Step 2: Run any doc contract tests; `pnpm format:check`** → PASS.

- [ ] **Step 3: Commit and push**

```bash
git add agents .claude/skills/lcars
git commit -m "docs(agent-protocol): native mode for work items without an issue anchor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 6: Land the branch, then the real-path proof

**Files:**

- Create: `docs/native-work-smoke-runbook.md`

- [ ] **Step 1: Land** — `pnpm verify`; PR with `--reviewer jlapenna`; watch CI; resolve threads; squash-merge (admin merge permitted when the only block is the unattributed-changes approval rule). Confirm `main`'s `Verify` is green and that the App Hosting rollout for the console completed (`gh run list --workflow` for the deploy, or the console's `/api/runner-status`).

- [ ] **Step 2: Grants in production** — `apps/console/apphosting.yaml` must carry `AGENT_LCARS_WORK_GRANTS` with at least `{ "principal": "user:jlapenna", "subjects": ["github:jlapenna"], "pipelines": ["claude"] }` (Plan 2 Task 5 added the variable; set the value here if it was left empty) and `AGENT_LCARS_WORK_MAX_LIVE_RUNS: "2"` for the first run. That is a console config change, deployed by the normal App Hosting rollout — not a Terraform or Firestore change.

- [ ] **Step 3: One native item, end to end (console path — needs no service account)**

1. Sign in to the console as `jlapenna`, open `/work`, and create an item (Plan 2's `/work` page must expose a create form — if it does not, use the API with a session cookie: `curl -X PUT https://lcars.jlapenna.net/api/work/v1/items/$(node -e "console.log(require('ulid').ulid())") -H 'cookie: <console session>' -H 'content-type: application/json' -d '{"spec":{"title":"Native work smoke: add a comment to README","description":"Append one line to README.md under a new \"Native work smoke\" heading: the ISO date of this run. Open a PR; do not merge.","pipeline":"claude","target":{"repo":"jlapenna/agent-lcars"}}}'`).
2. Record the item id and `runs[0].runId` (`work:<ulid>/r1`).
3. Watch: `gh run list --workflow claude.yml --limit 3` shows a run titled `work:<ulid>: Claude issue agent [dispatch:g1:work:<ulid>/r1]`. Follow it with `gh run watch <id>`.
4. Expect: the run opens a PR whose body carries `Work: work:<ulid>` and the attempt-claim marker; `verify-deliverable` passes on the marker alone; the finalizer posts completion by `runId`; `GET /items/<ulid>` (or the `/work/<ulid>` page) shows `state: done` and `runs[0].result.ref` = the PR URL; the session appears under the item.
5. Close the PR (do not merge the smoke change); `POST /items/<ulid>/cancel` is expected to return `409` (done) — record that too.
6. If any step fails: the failure is a real finding — file it on #1502 with the run URL, do not paper over it, and fix forward in a follow-up commit on a new branch.

- [ ] **Step 4: Write the runbook**

`docs/native-work-smoke-runbook.md`: the steps above with the actual item id, run URL, PR URL, timestamps, and the console screenshots' paths (`docs/images/`), in the style of `docs/quick-task-evidence-smoke-runbook.md`. Commit on a follow-up branch; PR; merge. Tick sub-project 1 on #1502 and leave a comment naming the smoke run.

---

## Self-review

**Spec coverage:** Backend 1 native lane path (T2–T4), `work` input shape (T1), marker-only deliverable (T4), finalizer by `runId` (T2), native-mode protocol (T5), real-path proof (T6). Plan 1 already did `intentId`, marker binding, finalizer retry.

**Placeholder scan:** T3's "Resolve agent budget" step says "read the step; note the choice" — bounded to one step with both outcomes stated. T4 references helper names in `prepare.test.sh` the implementer must read; acceptable (the file exists and is named). T6 Step 3 gives the API fallback if the page has no create form.

**Type/shape consistency:** the `work` input is `{ id, spec }` in T1 (drain), T2 (`fromJSON(inputs.work).id` in `run-name`/`CURRENT`), T4 (`prepare.sh` reads `$w.id`, `$w.spec.*`); `anchor.type == "work"` is what T5's protocol section keys on.
