# Onboarding a repo to the Agent LCARS console + telemetry

How to wire a new repo into this console: its dispatched agent runs show up
in the dashboard/queue, live turns and transcripts show up in Sessions, and
takeover/parking all work the way `supersprinklesracing/members` already
does. Written from the members + agent-lcars onboarding done in practice —
every piece named below is real, not aspirational.

There are three independent layers. A repo can adopt them incrementally,
but the console only becomes useful once all three are in place:

1. **Agent protocol** — the repo's dispatch workflows follow the shared
   conventions the console parses out of GitHub state.
2. **Telemetry** — the repo's runner image/workflow reports live and
   final session data to this console's Firestore.
3. **Console config** — this repo (`agent-lcars`) is told the new repo
   exists.

## 1. Agent protocol

Pull in the shared skill and follow it. Every dispatch workflow (however
many of `claude.yml` / `opencode.yml` / `codex.yml` the repo runs) should:

- Check out `.agents/skills/agent-protocol/agent-protocol.md` from this
  repo (sparse checkout is the established pattern — see any of this
  repo's own dispatch workflows, or `supersprinklesracing/members`'
  `codex.yml`'s "Checkout shared agent-protocol skill" step) and have the
  agent read it first, before its own repo-specific delta skill.
- Write that delta skill (mirror `.agents/skills/lcars/lcars-protocol.md`
  in this repo): name the fleet-claim identity, the PR reviewer/park
  assignee, the reply triggers, the repo's own verify commands, and any
  hard limits additive to `agent-protocol.md §11`.
- Add `tools/claude-agent-session.sh` at that **exact path and filename**
  — the console's takeover-command scanner
  (`apps/console/src/lib/action-items.ts`'s `TAKEOVER_COMMAND_RE`)
  hard-codes the literal substring `claude-agent-session.sh` and does not
  generalize per agent. A takeover comment referencing any other filename
  never surfaces in the console UI, even for a non-Claude pipeline.
- Use the exact fixed vocabulary agent-protocol.md calls out: the
  `human-needed` label (never renamed/localized), the assignee-plus-label
  parking pattern, the eyes-reaction acknowledgement, one continuously
  edited progress comment.

None of this requires touching this repo. It's entirely the new repo's own
dispatch-workflow work, following a file this repo publishes.

## 2. Telemetry

This is the part that actually requires per-repo setup in **both**
directions: the new repo's runner environment, and a GCP IAM grant here.

### 2a. The sidecar tool needs to be on the runner

Telemetry is shipped by baking `apps/telemetry-watcher`'s `bundle` Nx
target — a single self-contained `.cjs` file with every dependency
inlined, including `@google-cloud/firestore` — into the runner image at
`/usr/local/lib/agent-lcars/sidecar.cjs`. See this repo's own
`runner-autoscaler/runner-image/Dockerfile` (or
`jlapenna/homelab`'s copy — they're intentionally duplicated, see the
comment at the top of either) for the exact build stage: it clones this
repo's `main` at image-build time and runs
`./tools/nx bundle @agent-lcars/telemetry-watcher`. No download, no
version pin to keep in sync — the image build is the release step. A
stale, never-republished pin was exactly the failure mode this replaced
(issue #29).

- **If the new repo's runner fleet already uses
  `docker-registry.lan.jlapenna.net/homelab-runner:jit-node24`** (the
  shared JIT image both `members` and `agent-lcars` run on), this is
  already done — nothing to do here.
- **If it's a different runner image entirely**, that image's own
  Dockerfile needs an equivalent build stage, or the sidecar bundle needs
  shipping some other way. Don't reintroduce the GCS-publish-and-pin
  scheme (issue #29) — build-time bake-in from this repo's own `main` is
  the supported pattern.

### 2b. Dispatch workflow steps

Add three steps to each dispatch workflow, modeled on **this repo's own**
`claude.yml` (search it for "telemetry" to see the real thing in full —
the summary below is the shape). Use this repo, not
`supersprinklesracing/members`, as the reference: as of this writing,
members' `claude.yml` is still on the *older* pattern this replaced — a
"Start telemetry ride-along" step that downloads
`ride-along.cjs` from a GCS bucket
(`gs://agent-lcars-tools/telemetry/telemetry-v1/`) instead of using the
runner-image-baked sidecar. That's exactly the stale-pin failure mode
issue #29 named; migrating members onto the pattern below is a known,
still-pending follow-up, not something to copy.

1. **`Authenticate telemetry writer`** (`if: always()`,
   `continue-on-error: true`) — `google-github-actions/auth@v3` against:
   ```yaml
   workload_identity_provider: projects/611425338852/locations/global/workloadIdentityPools/github/providers/github
   service_account: telemetry-writer@agent-lcars.iam.gserviceaccount.com
   ```
   `continue-on-error: true` matters: a broken/rotated WIF config here
   must never turn a healthy agent run red.

2. **`Start telemetry sidecar`** — backgrounds
   `node sidecar.cjs runner sidecar --run-id "$RUN_ID" --projects-dir "$HOME/.claude/projects"`
   for the duration of the agent's own run step. No `--repo` flag needed —
   `GITHUB_REPOSITORY` is already set by GitHub Actions and the CLI falls
   back to it. `continue-on-error: true` again; every failure path inside
   the step's own script should log and `exit 0` rather than fail the job.

3. **`Finalize telemetry sidecar`** (`if: always()`,
   `continue-on-error: true`) — runs once the agent's own step exits:
   kills the sidecar (waiting, bounded, for it to actually stop — a
   trailing async Firestore write from its last tick could otherwise land
   *after* this step's own authoritative write and silently overwrite the
   `ended` doc back to a stale `live`/`idle` snapshot), does one last
   reduce pass with liveness hardcoded to `'ended'`, uploads the raw
   transcript, and upserts the final doc with `transcriptGcsUri` attached.
   Skipping this step leaves a session doc frozen at whatever the sidecar
   last wrote, with no browsable archived transcript.

### 2c. IAM grant (needs a human — Terraform lives here, not touched casually)

The `telemetry-writer` service account's WIF principal set needs the new
repo added so its Actions runs can mint a token for that SA. This repo's
own `AGENTS.md`/`lcars-protocol.md` rule — **never touch
`infra/terraform` from an agent run** — applies here: this step is a
maintainer action (`infra/terraform`), not something to script around.
Flag it and wait rather than trying to work around it with a hand-rolled
`gcloud` grant.

## 3. Console config

Tell this console the new repo exists via `AGENT_LCARS_WATCHED_REPOS`
(read by `apps/console/src/lib/github-client.ts`'s `getWatchedRepos()`,
set in this repo's `apphosting.yaml`): a JSON array of
`{owner, name, workflowFiles?}` objects.

```json
[
  { "owner": "supersprinklesracing", "name": "members" },
  { "owner": "supersprinklesracing", "name": "new-repo" }
]
```

- Leaving `AGENT_LCARS_WATCHED_REPOS` unset reproduces today's
  single-repo behavior exactly (`DEFAULT_WATCHED_REPOS` — just
  `supersprinklesracing/members`) — it must be set explicitly to add a
  second repo, not just left to "pick up" the new one.
- `workflowFiles` is an **override**, not a requirement: each of
  `claude` / `codex` / `opencode` falls back to its default filename
  (`agent-activity.ts`'s `WORKFLOW_FILES`) unless overridden here. Only
  set a key if the new repo names that workflow file differently, or set
  it explicitly to `null` for a pipeline the repo doesn't run at all (so
  the console doesn't bother fetching it).
- `AGENT_LCARS_GITHUB_TOKEN` (the token `getGithubClient()` uses) needs
  read access to the new repo too — check its scope/installation covers
  it, since a token that only reached `members` before won't automatically
  reach a repo in a different org or a personal account.
- `primaryWatchedRepo()` — the repo global ops-style actions (quick task,
  unstick-prs, Nx cache eviction) target when the UI has no per-action
  repo picker — is always `getWatchedRepos()[0]`. If the new repo should
  be the default target for those, put it first in the array.

## Verifying it actually worked

Don't take any of the above on faith — confirm each layer:

1. Dispatch a real, low-stakes issue in the new repo with the `claude` (or
   `opencode`/`codex`) label and watch the run through to a real
   deliverable (PR opened, or a parked `human-needed` comment) — not just
   a green job.
2. While it's running, check this console's dashboard for the in-flight
   session (live turns/tokens updating) — proves the sidecar + WIF auth +
   watched-repos config are all correctly wired end to end, not just each
   individually plausible.
3. After it finishes, check the Sessions page for the archived transcript
   — proves the finalize step's authoritative write landed.

This is exactly the sequence used to prove out both Claude
(`agent-lcars` issue #41 → PR #48) and the runner-fleet plumbing itself
during this repo's own onboarding — there's no shortcut that skips a real
end-to-end dispatch.
