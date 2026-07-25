# Onboarding a repo to the Agent LCARS console + telemetry

How to wire a new repo into this console: its dispatched agent runs show up
in the dashboard/queue, live turns and transcripts show up in Sessions, and
takeover/parking work the same way they do for any already-onboarded repo.

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
  repo and have the agent read it first, before its own repo-specific
  delta skill:

  ```yaml
  - name: Checkout shared agent-protocol skill
    uses: actions/checkout@v7
    with:
      repository: jlapenna/agent-lcars
      path: .agent-protocol
      sparse-checkout: |
        .agents/skills/agent-protocol
      sparse-checkout-cone-mode: false
  ```

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

**Claude Code dispatches only, for now** — there's no OpenCode or Codex
transcript adapter yet. Wiring the steps below into a non-Claude dispatch
workflow will not fail loudly: every telemetry step is deliberately
fail-soft, so the workflow stays green while silently producing no live or
final session data. Skip this section for a non-Claude pipeline until that
adapter exists.

This is also the part that requires per-repo setup in **both** directions:
the new repo's runner environment, and a GCP IAM grant here.

### 2a. The sidecar tool needs to be on the runner

Telemetry is shipped by baking `apps/telemetry-watcher`'s `bundle` Nx
target — a single self-contained `.cjs` file with every dependency
inlined, including `@google-cloud/firestore` — into the runner image at
`/usr/local/lib/agent-lcars/sidecar.cjs`. See this repo's own
`apps/runner-autoscaler/runner-image/Dockerfile` (or `jlapenna/homelab`'s
copy — they're intentionally duplicated, see the comment at the top of
either) for the build stage: it clones this repo's `main` at image-build
time and runs `./tools/nx bundle @agent-lcars/telemetry-watcher`. No
download, no version pin to keep in sync — the image build is the release
step.

- **If the new repo's runner fleet already uses
  `docker-registry.lan.jlapenna.net/homelab-runner:jit-node24`** (the
  shared JIT image), this is already done — nothing to do here.
- **If it's a different runner image entirely**, that image's own
  Dockerfile needs an equivalent build stage, or the sidecar bundle needs
  shipping some other way. Don't reintroduce a publish-and-pin scheme —
  build-time bake-in from this repo's own `main` is the supported pattern.

### 2b. Dispatch workflow steps

Add these three steps to the dispatch workflow. The process-management
logic (existence/credential guards, backgrounding, PID tracking,
kill-and-wait) is consolidated into
`/usr/local/lib/agent-lcars/sidecar-lifecycle.sh`, baked into the runner
image alongside `sidecar.cjs` — each workflow step is a thin,
copy-pasteable wrapper around calling it, not a place to re-duplicate that
logic (see that script's own header comment if the underlying behavior
needs to change; a fix there reaches every consumer on the next image
pull).

```yaml
- name: Authenticate telemetry writer
  id: telemetry-auth
  if: always()
  continue-on-error: true
  uses: google-github-actions/auth@v3
  with:
    workload_identity_provider: projects/611425338852/locations/global/workloadIdentityPools/github/providers/github
    service_account: telemetry-writer@agent-lcars.iam.gserviceaccount.com
    token_format: access_token

# ... your own agent-specific auth step, if any, must run AFTER this one
# if it also sets GOOGLE_APPLICATION_CREDENTIALS job-wide, so its
# credentials (not this step's) are what later steps inherit ambiently.

- name: Start telemetry sidecar
  continue-on-error: true
  env:
    WRITER_CREDENTIALS_FILE: ${{ steps.telemetry-auth.outputs.credentials_file_path }}
    RUN_ID: ${{ github.run_id }}
    NUM: ${{ github.event.issue.number || github.event.inputs.issue }}
  run: |
    SCRIPT=/usr/local/lib/agent-lcars/sidecar-lifecycle.sh
    if [ -x "$SCRIPT" ]; then
      "$SCRIPT" start
    else
      echo "Sidecar tooling not found at $SCRIPT (runner image predates this bake-in); skipping telemetry sidecar."
    fi

# ... your own "Run <agent>" step goes here ...

- name: Finalize telemetry sidecar
  if: always()
  continue-on-error: true
  env:
    WRITER_CREDENTIALS_FILE: ${{ steps.telemetry-auth.outputs.credentials_file_path }}
    RUN_ID: ${{ github.run_id }}
    NUM: ${{ github.event.issue.number || github.event.inputs.issue }}
  run: |
    SCRIPT=/usr/local/lib/agent-lcars/sidecar-lifecycle.sh
    if [ -x "$SCRIPT" ]; then
      "$SCRIPT" finalize
    else
      echo "Sidecar tooling not found at $SCRIPT; skipping telemetry finalize."
    fi
```

`continue-on-error: true` on every step matters — a broken/rotated WIF
config, or a runner image that predates the bake-in, must never turn a
healthy agent run red. The finalize step is not optional: skip it and a
session doc freezes at whatever `live`/`idle` snapshot the sidecar last
wrote, with no browsable archived transcript.

### 2c. IAM grant (needs a human — Terraform lives here, not touched casually)

The `telemetry-writer` service account's WIF principal set needs the new
repo added so its Actions runs can mint a token for that SA. This repo's
own `AGENTS.md`/`lcars-protocol.md` rule — **never touch
`infra/terraform` from an agent run** — applies here: this step is a
maintainer action, not something to script around. Flag it and wait
rather than trying to work around it with a hand-rolled `gcloud` grant.

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
  single-repo behavior exactly (`DEFAULT_WATCHED_REPOS`) — it must be set
  explicitly to add a second repo, not just left to "pick up" the new one.
- `workflowFiles` is an **override**, not a requirement: each of
  `claude` / `codex` / `opencode` falls back to its default filename
  (`agent-activity.ts`'s `WORKFLOW_FILES`) unless overridden here. Only
  set a key if the new repo names that workflow file differently, or set
  it explicitly to `null` for a pipeline the repo doesn't run at all (so
  the console doesn't bother fetching it).
- `AGENT_LCARS_GITHUB_TOKEN` (the token `getGithubClient()` uses) needs
  read access to the new repo too — check its scope/installation covers
  it, since a token that only reached an existing repo won't automatically
  reach one in a different org or a personal account.
- `primaryWatchedRepo()` — the repo global ops-style actions (quick task,
  unstick-prs) target when the UI has no per-action repo picker — is
  always `getWatchedRepos()[0]`. If the new repo should be the default
  target for those, put it first in the array.

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

There's no shortcut that skips a real end-to-end dispatch.
