# Onboarding a repo to the Agent LCARS console + telemetry

> Part of the end-to-end repo onboarding sequence — start at
> [onboarding-repo.md](onboarding-repo.md); this doc is its §6 detail.

> Credential minting (Claude OAuth token, Codex auth lineage, LiteLLM key,
> App keys) is documented in [fleet-credentials.md](fleet-credentials.md).

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

Use the shared protocol as the complete fleet behavior contract. Every dispatch
workflow (however many of `claude.yml`, `opencode.yml`, and `codex.yml` the
repo runs) should:

- Use the `prepare-agent-dispatch` action (ref per the convention in
  [published-actions.md](published-actions.md) — the moving `main` ref with a
  `# latest` comment) and have the agent read the
  shared protocol at `$AGENT_PROTOCOL_PATH`. The action is already downloaded
  outside the consumer's Git
  worktree, so it exposes its bundled protocol file and writes the dispatch
  brief under `$RUNNER_TEMP`:

  ```yaml
  - name: Prepare dispatch context
    id: dispatch
    uses: jlapenna/agent-lcars/.github/actions/prepare-agent-dispatch@main # latest
    with:
      agent: Claude
      issue: ${{ github.event.inputs.issue }}
      mode: ${{ github.event.inputs.mode }}
  ```

  The action exports `AGENT_PROTOCOL_PATH` and `AGENT_DISPATCH_CONTEXT` for
  subsequent steps and exposes the same values as `protocol-path` and `path`
  outputs. The example uses the backward-compatible 60-minute runtime defaults
  (durable artifact by minute 25, scope finalization by minute 45) and the
  caller's ambient `github.token`. Pass `token` and all three deadline inputs
  explicitly when the agent step uses different credentials or a different
  timeout. Do not check this repository out inside the consumer repository;
  runtime-only files must never appear in the consumer's Git status.

- Do not copy `agent-protocol` or centrally published plugin skills into the
  repository. The action installs the shared layer-1 skill surface into the
  runner's agent home and exports the source protocol path.
- Keep repository-local facts in `AGENTS.md` or the repository's development
  skill: bootstrap and verification commands, protected infrastructure, deploy
  policy, and other additive hard limits. Pass `protocol-note` only for a
  genuinely repo-specific headless behavior that cannot live in those normal
  instruction surfaces; most repositories should omit it.
- Keep the fleet-wide `agent-lcars-bot` claim identity, `jlapenna` maintainer,
  reply triggers, dispatch modes, provider handoffs, parking vocabulary, and
  deliverable semantics in the shared protocol. A consumer must not redefine
  them locally.

None of this requires touching this repo. It's entirely the new repo's own
dispatch-workflow work, following a file this repo publishes.

## 2. Telemetry

Provider coverage differs: Claude Code reports live session data, archives raw
JSONL, and exposes its resume tooling; Codex reports session telemetry and
archives raw JSONL but has no live-resume command; OpenCode reports summary
telemetry and archives a bounded, sanitized metadata-only CLI export, but that
archive has no timeline renderer or resume command. Telemetry steps are
deliberately fail-soft, so verify the expected provider-specific result rather
than treating a green workflow as proof that session data arrived.

OpenCode live/GCS capture uses the root-owned `/usr/local/bin/opencode` baked
into the shared runner image. The privileged telemetry process deliberately
rejects PATH and the runner-writable CLI a consumer setup action installs; the
bootstrap lane invokes the same image binary directly. The separate post-agent
trajectory artifact remains available because it does not run with the
telemetry writer credential.

The shared lane owns the standard WIF provider and telemetry-writer service
account. A new repo therefore needs no duplicated workflow steps or repository
variables for telemetry; it needs the shared runner image and membership in
this repo's Terraform-managed fleet repository list.

### 2a. The sidecar tool needs to be on the runner

Telemetry is shipped by baking `apps/telemetry-watcher`'s `bundle` Nx
target — a single self-contained `.cjs` file with every dependency
inlined, including `@google-cloud/firestore` — into the runner image at
`/usr/local/lib/agent-lcars/sidecar.cjs`. See this repo's own
`apps/runner-autoscaler/runner-image/Dockerfile` — the single source for
this image; the former duplicate in `jlapenna/homelab` was removed along
with the local-build fallback it served — for the build stage: it clones
this repo's `main` at image-build
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

### 2b. Dispatch workflow contract

Use the published Agent LCARS Claude, Codex, and OpenCode lanes. Their shared
`agent-lane.yml` authenticates, starts, and finalizes telemetry with the
canonical provider and writer identity when the caller leaves the optional
override inputs empty. Do not copy those steps into consumers, and do not make
telemetry depend on per-repository `GCP_TELEMETRY_WRITER_SA` variables.

The composite and sidecar remain fail-soft: broken WIF or an old runner image
must not turn a healthy agent deliverable red. That makes live console/storage
verification mandatory; a green Actions run alone is not telemetry proof.

### 2c. IAM grant (requires explicit maintainer approval)

Add the repository to `local.github_repositories`. The same curated list owns
both the WIF provider admission condition and the per-repository
`roles/iam.workloadIdentityUser` grants on `telemetry-writer`; do not add a
one-off writer resource that can drift from fleet membership. This repo's
own `AGENTS.md`/development-skill rules deny Terraform and IAM changes by
default. The named maintainer may explicitly approve a specific issue,
operation, and target; without that approval, flag the step and wait. With
approval, use a dedicated worktree, add regression coverage, review the
complete plan before applying, and verify a clean post-apply plan. Never work
around Terraform ownership with a hand-rolled `gcloud` grant.

Codex also needs a repository-specific service account and rotating credential
secret. Repository-local Actions concurrency cannot protect a credential shared
across repositories, so never grant a new repository access to another repo's
Codex service account or copy its `auth.json`. Provision a distinct secret
container through Terraform; a maintainer must populate it with an independently
minted credential through the approved secret-value workflow.

## 3. Console config

Tell this console the new repo exists via `AGENT_LCARS_WATCHED_REPOS`
(read by `apps/console/src/lib/github-client.ts`'s `getWatchedRepos()`,
set in this repo's `apphosting.yaml`): a JSON array of
`{owner, name, alias?, agents?}` objects.

```json
[
  { "owner": "supersprinklesracing", "name": "sprinkles" },
  {
    "owner": "supersprinklesracing",
    "name": "new-repo",
    "alias": "New Repo"
  }
]
```

- Leaving `AGENT_LCARS_WATCHED_REPOS` unset reproduces today's
  single-repo behavior exactly (`DEFAULT_WATCHED_REPOS`) — it must be set
  explicitly to add a second repo, not just left to "pick up" the new one.
- `alias` is purely cosmetic: when set, the UI's repo badges/titles
  (`repoDisplayName()`) show it instead of the `owner/name` form
  `repoKey()` produces. It never affects GitHub API calls, URLs, or the
  identity keys used to join items/runs/sessions to a repo — those always
  use the real `owner`/`name`.
- Omit `agents` for the standard Claude, Codex, and OpenCode integrations.
  Set `agents` to an empty object for a repository that has no agent
  dispatch, or provide a complete per-pipeline object with `workflowFile`,
  `label`, and `replyTrigger` when an integration differs. Optional
  `replyTriggerAliases` records equivalent accepted commands. This keeps the
  console's routing behavior declarative and lets future integrations add
  their own control label and reply syntax without hard-coded repo branches.
- `getGithubClient()` (see `github-client.ts`) mints a short-lived GitHub App
  installation token per request, scoped to the target repo, rather than
  using one long-lived ambient credential (#1284 retired the classic PAT
  this used to be). That still requires the GitHub App itself to be
  _installed_ on the new repo's owner/org, with read access plus Issues
  write and Contents write - Issues write creates the fully labeled task;
  Contents write creates its atomic
  `refs/tags/agent-lcars/quick-task/<uuid>` claim. Check the App's
  installation covers the new repo before adding it here, since access to
  an existing repo does not automatically extend across
  organizations/accounts.
- Quick Task always carries an explicit canonical `owner`/`name` repository
  from the UI through the Server Action. A single configured repository hides
  the picker but is still included in the mutation; there is no primary-repo
  fallback.
- `primaryWatchedRepo()` is reserved for truly global operations without a
  task context (currently only `unstick-prs`) and returns
  `getWatchedRepos()[0]`.

## Verifying it actually worked

Don't take any of the above on faith — confirm each layer:

1. Dispatch a real, low-stakes issue in the new repo with the `agent:claude`
   (or `agent:opencode`/`agent:codex`) label and watch the run through to a real
   deliverable (PR opened, or a parked `status:needs-human` comment) — not just
   a green job.
2. While it's running, check this console's dashboard for the in-flight
   session (live turns/tokens updating) — proves the sidecar + WIF auth +
   watched-repos config are all correctly wired end to end, not just each
   individually plausible.
3. After it finishes, check the Sessions page for the archived transcript
   — proves the finalize step's authoritative write landed.

There's no shortcut that skips a real end-to-end dispatch.
