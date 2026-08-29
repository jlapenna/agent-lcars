# Onboarding a repo to the Agent LCARS console + telemetry

> Part of the end-to-end repo onboarding sequence — start at
> [onboarding-repo.md](onboarding-repo.md); this doc is its §5 detail.

> Credential minting (Claude OAuth token, Codex auth lineage, LiteLLM key,
> App keys) is documented in [fleet-credentials.md](fleet-credentials.md).

How to wire a new repo into this console: its dispatched agent runs show up
in the dashboard/queue, live turns and transcripts show up in Sessions, and
takeover/parking work the same way they do for any already-onboarded repo.

There are three independent layers. A repo can adopt them incrementally,
but the console only becomes useful once all three are in place:

1. **Agent protocol** — QueueExecutor follows the shared conventions for
   work admitted from the repository's GitHub state.
2. **Telemetry** — QueueExecutor reports live and final session data to this
   console's Firestore.
3. **Console config** — this repo (`agent-lcars`) is told the new repo
   exists.

## 1. Agent protocol

Use the shared protocol as the complete fleet behavior contract. QueueExecutor
uses the centrally baked native dispatch bootstrap and exposes its
protocol and context only inside the isolated worker, never in a target
repository workflow.

- Do not copy `agent-protocol` or centrally published plugin skills into the
  repository. The native runtime installs the shared layer-1 skill surface into the
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

None of this requires target-repository provider workflow files. The Console
admission and QueueExecutor own execution centrally.

## 2. Telemetry

Provider coverage differs: Claude Code reports live session data, archives raw
JSONL, and exposes its resume tooling; Codex reports session telemetry and
archives raw JSONL but has no live-resume command; OpenCode reports summary
telemetry and archives a bounded, sanitized metadata-only CLI export, but that
archive has no timeline renderer or resume command. Telemetry steps are
deliberately fail-soft, so verify the expected provider-specific result rather
than treating a successful agent process as proof that session data arrived.

OpenCode live/GCS capture uses the root-owned `/usr/local/bin/opencode` baked
into the shared runner image from an exact GitHub release artifact whose
reviewed SHA-256 is verified before extraction. The privileged telemetry
process deliberately rejects PATH and invokes the image binary directly.

QueueExecutor owns the standard telemetry identity and writer service account.
A new repo therefore needs no provider workflow, repository secret, or
repository variable for telemetry; it needs Console admission and shared
QueueExecutor capacity.

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

### 2b. QueueExecutor telemetry contract

QueueExecutor authenticates, starts, and finalizes telemetry with the canonical
provider and writer identity. It is the only provider execution path; target
repositories do not call a provider lane or configure telemetry workflow
inputs. Do not copy telemetry steps into consumers or create per-repository
writer variables.

The sidecar remains fail-soft: broken telemetry authentication or an old runner
image must not turn a healthy agent deliverable red. That makes live
console/storage verification mandatory; GitHub Actions is not dispatch
evidence.

### 2c. IAM grant (requires explicit maintainer approval)

Admit the repository through the Console's reviewed repository configuration;
do not create a one-off telemetry identity, WIF grant, secret, or variable.
If a central IAM boundary genuinely needs changing, this repo's
`AGENTS.md`/development-skill rules require explicit maintainer approval for
that exact Terraform operation. Never work around Terraform ownership with a
hand-rolled `gcloud` grant.

Codex work uses the Console's centrally owned rotating `auth.json` lineage.
The QueueExecutor binds every restore and persistence request to a live Codex
run and derives the target repository from that run before minting its separate
checkout token. Onboarding a repository therefore needs LCARS authorization,
not another Codex login, GCS object, or direct credential grant.

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
  Set `agents` to an empty object for a repository that has no agent dispatch,
  or provide label and reply-trigger overrides when an integration differs.
  QueueExecutor does not invoke a target-repository workflow file. Optional
  `replyTriggerAliases` records equivalent accepted commands.
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
   deliverable (PR opened, or a parked `status:needs-human` comment) — not a
   GitHub Actions job.
2. While it's running, check this console's dashboard for the in-flight
   session (live turns/tokens updating) — proves the sidecar + WIF auth +
   watched-repos config are all correctly wired end to end, not just each
   individually plausible.
3. After it finishes, check the Sessions page for the archived transcript
   — proves the finalize step's authoritative write landed.

There's no shortcut that skips a real end-to-end dispatch.
