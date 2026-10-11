# What is the app, and what is our deployment of it

This repo holds both the Agent LCARS application and the configuration that
runs _our particular instance_ of it. Telling them apart used to be a
grep-and-hope exercise. This document is the inventory, and names the one
place each kind of instance-specific value lives.

The honest headline: **most of it cannot be moved into a single
`deploy/` directory**, for reasons that are external constraints rather than
choices. So the boundary is enforced by _module_, not by directory, and this
file is the map.

## Why there is no single deployment directory

| Config                         | Where it must live                 | Why it can't move                                                                                                                                                                  |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/console/apphosting.yaml` | the App Hosting backend's root dir | `firebase.json` sets `apphosting[0].rootDir: apps/console`, and App Hosting reads `apphosting.yaml` from that root. Moving it means the backend stops finding its own config.      |
| `.github/workflows/*.yml`      | `.github/workflows/`               | GitHub only reads workflows from that exact path. There is no configuration that relocates it.                                                                                     |
| `firebase.json`                | repo root (by convention)          | Movable with `--config`, but every caller (`apps/console/project.json`'s deploy target, `deploy-console.yml`, the e2e emulator command) would need the flag. Cost without benefit. |
| `infra/terraform/`             | anywhere                           | Already separate — this one _is_ co-located, and always was.                                                                                                                       |

## Where instance identity actually lives

### 1. `apps/console/src/lib/deployment.ts`

The **only** module in console source that names this instance. Everything
else asks it:

| Value                     | Env var                                             | This deployment                                                                                                                                               |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| console admin logins      | `AGENT_LCARS_ADMIN_GITHUB_LOGINS`                   | `jlapenna,lizsprinkles`                                                                                                                                       |
| maintainer login          | `AGENT_LCARS_ADMIN_GITHUB_LOGIN`                    | `jlapenna` -- **required**, no fallback                                                                                                                       |
| agent fleet login         | `AGENT_LCARS_FLEET_GITHUB_LOGIN`                    | `agent-lcars-bot`                                                                                                                                             |
| artifact share base URL   | `AGENT_LCARS_ARTIFACT_SHARE_BASE_URL`               | `https://share.lan.jlapenna.net` -- **required**, no fallback                                                                                                 |
| control-plane repository  | `AGENT_LCARS_CONTROL_PLANE_REPOSITORY`              | `jlapenna/agent-lcars`                                                                                                                                        |
| watched repos             | `AGENT_LCARS_WATCHED_REPOS`                         | required; matches control-plane set                                                                                                                           |
| this console's own URL    | `AGENT_LCARS_CONSOLE_URL`                           | `https://lcars.jlapenna.net` -- **required**, no fallback                                                                                                     |
| console description       | `AGENT_LCARS_CONSOLE_DESCRIPTION`                   | `jlapenna/agent-lcars — multi-agent issue activity`; unset falls back to a generic, deployment-neutral string (build-time metadata can't read a required var) |
| console repository URL    | derived from `AGENT_LCARS_CONTROL_PLANE_REPOSITORY` | `https://github.com/jlapenna/agent-lcars` -- no separate var                                                                                                  |
| Codex central auth object | `AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT`             | `jlapenna/agent-lcars/auth.json` -- **required**, no fallback (#1751)                                                                                         |

Repository identity is explicit: the watched and control-plane sets are both
required and must match exactly. `apphosting.yaml` records that shared set so
what production runs with is visible in config rather than only in source.

Five of the values above are `required()`: maintainer login, artifact share
base URL, this console's own URL, control-plane repository, and the Codex
central auth object (#1751).
There is no fallback to this fleet's own values in source any more -- a
fork that leaves one unset fails the process boot with a clear
`process.env.<NAME> not defined` message
(`validateDeploymentIdentity()`, called from `instrumentation.ts`'s
`register()`), rather than silently inheriting `jlapenna`'s identity. The
console description is the one exception, and deliberately so: it's read
from `layout.tsx`'s static `export const metadata`, which Next.js evaluates
during `next build` itself, before any runtime env is available -- a
`required()` read there fails the production build, not a request. It falls
back to a generic, deployment-neutral string instead.

`tools/saved-session`'s CLI tools (`capture.mjs`, `mint.mjs`, `verify.mjs`)
default their `--origin` flag to `AGENT_LCARS_CONSOLE_URL` when it's set in
the calling shell's environment -- the same variable this table names, so
pointing the tools at a deployment means exporting that one variable, not
editing source. Unset and no `--origin` flag is a clear startup error, not a
silent fall-through to this fleet's console.

Server-only. `@agent-lcars/util-server` must never reach a client bundle, which is
why `shareArtifactUrl` lives here rather than in `format.ts` — that module
is imported by client components.

### 2. `apps/telemetry-watcher/src/lib/default-checkout.ts`

`checkoutRoots()` is the list of checkouts the host watcher is scoped to. All three
sources' default privacy allowlists derive from it — Claude project-dir
slugs (`allowlist.ts`), the Codex cwd allowlist (`config.ts`), and
Antigravity workspace prefixes — so their different encodings cannot drift
apart.

| Value          | Env var                          | This deployment                                      |
| -------------- | -------------------------------- | ---------------------------------------------------- |
| checkout roots | `AGENT_TELEMETRY_CHECKOUT_ROOTS` | derived from the watched account home in `deploy.sh` |

Runner mode deliberately ignores it — see `runner.ts`'s `RUNNER_ALLOWLIST` /
`RUNNER_CODEX_CWD_ALLOWLIST`, where a wildcard is correct because the
container is single-purpose.

**This is why it matters that it's config and not a buried constant.** A
personal-home path stayed pointed at the pre-rename checkout long after the
repository moved. The exact-prefix allowlist then silently recorded nothing
from the live checkout. Host mode now requires explicit roots and the deploy
script derives the account home from its UID; runner mode deliberately avoids
evaluating this host-only privacy scope.

### 3. `apps/console/src/lib/work-grants.ts`

Who may operate the Work API, and how many runs it will let be live at once.
`authenticateWorkRequest` (`work-auth.ts`) maps a verified Google
service-account ID token, GitHub Actions OIDC identity, or Auth.js session to
a principal by looking it up here — an unlisted subject gets no access at all,
regardless of how it authenticated. A GitHub Actions caller's signed
repository maps generically to `github-actions:<owner/repo>`; it is neither a
Sprinkles-specific branch nor a provider-routing selector.

| Value                    | Env var                     | This deployment                                                                                                                           |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| grants                   | `AGENT_LCARS_WORK_GRANTS`   | operators, allowed `github-actions:<owner/repo>` automation, and `svc:telemetry-writer` executor/scheduler: `claude`, `codex`, `opencode` |
| Google ID token audience | `AGENT_LCARS_WORK_AUDIENCE` | `agent-lcars-work`                                                                                                                        |

Authorized native Work creation, redispatch, replies, and due schedule slots
enter the durable queue even when the fleet is full. QueueExecutor reserves
host capacity before claiming a run; queued capacity waits do not expire or
consume execution retries. The former `AGENT_LCARS_WORK_MAX_LIVE_RUNS` intake
cap is retired. Execution capacity remains controlled by the autoscaler.

Unlike `deployment.ts`, these have no fallback identity or scope baked into
source — an unset `AGENT_LCARS_WORK_GRANTS` means an empty grant list (nobody
can operate the API), and every configured grant must explicitly declare its
non-empty `scopes` list. Every admitted run uses
QueueExecutor, regardless of its provider or whether it came from GitHub, the
console, a Work API GitHub-anchor dispatch, native Work, a schedule tick, or
redispatch. Callers and work specifications never choose a route.

The autoscaler's own identity needs its own grant row in
`AGENT_LCARS_WORK_GRANTS`, distinct from an operator's. It receives
`work.executor` to claim queued runs and the separately checked `work.cron`
scope to call `POST /schedules/tick`; neither scope implies `work.operator`:

```json
{
  "principal": "svc:telemetry-writer",
  "subjects": ["telemetry-writer@agent-lcars.iam.gserviceaccount.com"],
  "pipelines": ["claude", "codex", "opencode"],
  "scopes": ["work.executor", "work.cron"]
}
```

`runs-router.ts`'s `claim` route requires `work.executor`, never
`work.operator`; `schedules/tick` requires `work.cron`, never
`work.operator` or `work.executor` alone. A principal granted only either
scope is refused from every other `/items`/`/schedules` operation
(`work-router.test.ts`/`schedule-router.test.ts`'s "…-only principal"
tests). `pipelines` gates which pipelines the executor may claim, the same
field an operator's grant uses to gate `create`/`redispatch`. `POST
/runs/claim` derives selection from that grant alone.

The current operator grants list all three supported pipelines (`claude`,
`codex`, `opencode`), including the maintainer, repository-bounded
`workflow:work-create`, `workflow:member-automation`, and Sprinkles' App
Hosting service principal. Each declares `work.operator` explicitly. The
published `work-create.yml` workflow is contract-tested against that list, so
its provider canaries cannot fail at API admission. The telemetry-writer
identity remains a provider-neutral executor and scheduler, distinct from an
operator. Its executor grant and the direct runner's claim support cover every
admitted provider; its cron scope only permits the server-owned schedule tick.

#### Queue executor routing

QueueExecutor is the only execution route; there is no App Hosting flag or
per-request executor selection, and every entry point reaches the same
durable queue. The
autoscaler's matching console URL and credentials claim and run that
queue, and the same process ticks native schedules every five minutes through
the Work API. Every healthy autoscaler replica may tick; deterministic
schedule item ids and the Work API's durable orchestrator coalesce a shared
due slot to one item/run. Its image and mounts are documented in
`apps/runner-autoscaler/README.md`. This repository owns server routing,
executor/scheduler grants, and the Kubernetes Job backend (the queue
executor's only backend); Homelab owns autoscaler deployment, Kubernetes
namespace/RBAC, provider Secrets, node readiness taints, and sizing. Executor
configuration changes how workers launch, never server admission or provider
credential authorization.

### 4. Workflows — repo variables

Not extractable by relocation (`.github/workflows/` is a fixed path), so
these live as **repo variables** instead. Identity and deployment variables
fail _closed_ if unset: an empty value makes a `runs-on` unschedulable, an
auth step fail, or the `github.actor == vars.MAINTAINER_LOGIN` dispatch guard
evaluate false. Telemetry is the deliberate exception: the shared lane owns
its non-secret fleet WIF/provider identity and uses that canonical default
when a caller omits or empties the legacy override variables.

| Variable                          | This deployment                                                                  | Used by                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_RUNNER_LABEL`            | `lcars-default`                                                                  | agent-automerge, label-contract-audit — small, fast glue jobs only (#451)                                           |
| `CI_RUNNER_LABEL`                 | `lcars-ci`                                                                       | ci (verify, e2e), local App Hosting build/deploy — long work kept off the latency-sensitive glue pool (#451, #1030) |
| `E2E_ENABLED`                     | `true`                                                                           | CI E2E operational kill switch; only the exact value `true` enables the job                                         |
| `GCP_PROJECT_ID`                  | `agent-lcars`                                                                    | Console credential brokering                                                                                        |
| `GCP_WIF_PROVIDER`                | `projects/611425338852/…/providers/github`                                       | Console-adjacent GitHub workflows only                                                                              |
| `GCP_DEPLOYER_WIF_PROVIDER`       | `projects/611425338852/…/workloadIdentityPools/github-deployer/providers/github` | deploy-console only; provider accepts `deploy-console.yml` from `main`                                              |
| `GCP_DEPLOYER_SA`                 | `github-deployer@agent-lcars…`                                                   | deploy-console only; the App Hosting deploy impersonates it through `GCP_DEPLOYER_WIF_PROVIDER`                     |
| `GCP_WEBHOOK_CONFIG_WIF_PROVIDER` | Terraform output `github_app_webhook_configurator_workload_identity_provider`    | configure-github-app-webhook only; provider accepts that workflow from `main`                                       |
| `GCP_TELEMETRY_WRITER_SA`         | optional override; shared default is `telemetry-writer@agent-lcars…`             | QueueExecutor telemetry                                                                                             |
| `GCP_CODEX_AGENT_SA`              | `codex-agent@agent-lcars…`                                                       | QueueExecutor Codex auth broker and console-session verification                                                    |
| `GCP_WEBHOOK_CONFIG_SA`           | Terraform output `github_app_webhook_configurator_service_account`               | configure-github-app-webhook; reads only the webhook HMAC secret                                                    |
| `MAINTAINER_LOGIN`                | `jlapenna`                                                                       | dispatch guards, failure assignment                                                                                 |
| `AGENT_FLEET_LOGIN`               | `agent-lcars-bot`                                                                | claim steps and queue hand-off                                                                                      |
| `AGENT_LCARS_CLIENT_ID`           | `Iv23liO6X8pLJLcTFzyv` (the Agent LCARS GitHub App)                              | Console labels/comments, configure-github-app-webhook, and label-contract-audit                                     |
| `APPHOSTING_BACKEND_ID`           | `agent-lcars`                                                                    | deploy-console                                                                                                      |
| `AGENT_BOT_LOGINS`                | `["claude[bot]","agent-lcars[bot]"]`                                             | agent-automerge — REST-shaped, see `docs/bot-identity-formats.md`                                                   |
| `NX_CACHE_URL`                    | homelab Nx cache                                                                 | CI jobs                                                                                                             |

`deploy-console.yml` runs its GitHub-only Verify admission check on
`ubuntu-latest`. Only admitted main/manual deployments enter the shared
deployment lock. Inside that lock, an automatic source must still equal the
current main tip before checkout, credential setup, build or rollout. This
also applies to automatic `recovered-ci` dispatches.
Superseded sources skip every subsequent step; failed or unreadable main
lookups fail closed. Explicit manual source requests retain their existing
semantics and use the same lock.

The admitted deployment queue retains up to 100 waiting jobs with GitHub's
`queue: max`, so a delayed older eligible source cannot replace a waiting
newer source. Jobs acquire the lock in order of queue arrival; the in-lock
source check still prevents stale rollout. If the queue is full, GitHub
cancels additional jobs. Active deployments are never canceled by this
queue policy. The pinned actionlint predates this supported queue property;
a diagnostic exception is restricted to this workflow and this key, and
required source-fence contracts validate its values and cancellation rules.

An older green source can therefore be skipped while a newer main tip waits
for CI or has failed CI. The workflow does not deploy that unverified tip or
fall back to the older source. A successful superseded workflow performed no
rollout: delivery evidence must include the actual rollout and serving
verification, rather than only its aggregate workflow conclusion.

`DISPATCH_FIRESTORE_DATABASE_ID` is deliberately absent from this table: it
is not a repo variable. It is an App Hosting environment value
(`apps/console/apphosting.yaml`) read by the hosted orchestrator runtime
(`apps/console/src/lib/orchestrator-runtime.ts`). The worker-side dispatch
preflight that once read it — authenticating as a dedicated
`dispatch-preflight` service account is retired: QueueExecutor workers do not
authenticate directly to Firestore.

After applying Terraform, map the dedicated webhook configurator outputs to
the repository variables the workflow consumes:

```sh
gh variable set GCP_WEBHOOK_CONFIG_WIF_PROVIDER --body "$(terraform -chdir=infra/terraform output -raw github_app_webhook_configurator_workload_identity_provider)"
gh variable set GCP_WEBHOOK_CONFIG_SA --body "$(terraform -chdir=infra/terraform output -raw github_app_webhook_configurator_service_account)"
```

The webhook configuration workflow deliberately does not read the `latest`
secret version. App Hosting resolves Secret Manager values into a serving
revision during deployment, so a newer secret version can exist before that
revision is live. Deploy and verify App Hosting first, then configure GitHub
with the exact positive-integer version used by that deployment:

```sh
gh workflow run configure-github-app-webhook.yml --ref main -f webhook_secret_version=1
```

For a rotation, replace `1` with the new version only after the deployment
carrying that version has completed and the production route is healthy.

Image publication intentionally has no repository variable or workflow.
Canonical `jlapenna/homelab` owns the internal registry endpoint, remote
BuildKit endpoint, and publisher credential; see
`docs/image-publish-routing.md` for the source-to-image map. A fork changes
those trust decisions in its own canonical infrastructure, not through an
Agent LCARS repository variable. This repository sends Homelab no rollout
signal: Homelab and Agent LCARS are separate systems, so no workflow here uses
the Agent LCARS App to dispatch Homelab. Homelab delivers `main` on its own
daily backstop, when it applies new configuration, or through the maintainer
handoff below.

#### Homelab-owned source delivery

After required CI succeeds for a reviewed commit on Agent LCARS `main`, record
that full lowercase 40-character commit SHA and its successful CI run. Obtain
approval for the specific reconciliation command and target before dispatching
from a maintainer environment with Homelab access:

```sh
# Replace this value with the full main commit SHA validated by required CI.
validated_sha='<40-character-lowercase-main-commit-sha>'
gh workflow run source-reconcile.yml -R jlapenna/homelab \
  -f source=agent-lcars -f sha="$validated_sha"
```

Both `source` and `sha` are required by Homelab's
[source reconciliation workflow](https://github.com/jlapenna/homelab/blob/main/.github/workflows/source-reconcile.yml).
The SHA identifies the CI-validated request; it does not install a new version
pin. The reconciler delivers latest reviewed `main`. Read the current remote
workflow inputs before preparing this handoff; comparing its input declarations
does not require dispatching it. Record the resulting reconciliation run and
verify adoption by each affected consumer rather than treating workflow
submission or Console deployment success as delivery evidence.

#### CLI consumers and adoption gates

The `lcars` CLI is built from telemetry-watcher source, but its consumers have
independent delivery paths:

| Consumer                      | Delivery owner and existing contract                                                                                                                                                                                                                                                                                                                        | Adoption evidence                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Workstation CLI               | The maintainer explicitly reruns the supported [installer](../apps/telemetry-watcher/deploy/install-session-title-cli.sh), which copies the bundle and launcher to stable locations outside the checkout. It does not update automatically after a merge.                                                                                                   | Invoke the actually installed launcher and record its resolved path and copied bundle hash.                                              |
| Runner CLI and watcher daemon | Homelab owns publication and reconciliation under the [image-publish routing contract](image-publish-routing.md). The [runner Dockerfile](../apps/runner-autoscaler/runner-image/Dockerfile) bakes the CLI bundle and launcher; the [watcher Dockerfile](../apps/telemetry-watcher/Dockerfile) ships the daemon bundle, not a workstation CLI installation. | Record the running image digest and source revision; test the CLI baked into that runner digest separately from watcher daemon adoption. |

For a CLI source change, hand the maintainer the reviewed main SHA and CI
receipt, affected workstation installation targets and image consumers, the
supported installer/image-publish links above, and the verification command
below. Obtain approval for the specific host installation and any Homelab
rollout before executing them. Follow the existing image selection contract;
Console rollout does not update copied workstation bundles or prove image
adoption.

After installation or rollout, invoke the installed workstation launcher or
the runner image's baked `/usr/local/bin/lcars`, using an existing failed Work
item that the caller is authorized to read:

```sh
lcars work status <failed-work-id> --watch
```

It must print `failed` and exit **1 promptly**, without waiting for another
poll when the first response is already terminal. Record the launcher path,
bundle hash or immutable image digest, output, elapsed time and exit status.
A bounded loopback fixture with a fixture-only token and an explicitly
local API origin can verify the same behavior without production reads or
Work mutation. Exercise the installed/baked artifact, not a freshly built
source bundle. A stale bundle that rejects `work status` or `--watch` is an
**unmet delivery gate**, even if CI, Console deployment or the source issue
is already complete. Retain that gate and its installation/rollout resume
trigger in the delivery handoff.

One further exception:

- **Prose still names the logins** — step names ("Claim the issue as
  agent-lcars-bot"), `::warning::` text, and the agent prompt bodies. These are
  human-readable strings, not config; interpolating them would make the
  already-long prompts harder to read for no functional gain. A fork should
  update the prompt text by hand.

`deploy-console.yml` previously read the provider and deployer SA from
repository _secrets_, duplicating what the agent workflows hardcoded.
Neither value is confidential, and both are fully determined by
`infra/terraform/main.tf`: it declares exactly one workload identity pool
(`github`) and one provider (`github`) in project `agent-lcars`
(number `611425338852`), so the provider path has no other possible value,
and the deployer SA is `google_service_account.github_deployer`'s
`account_id`. Both now read the same variables as everything else.

The old `GCP_WORKLOAD_IDENTITY_PROVIDER` / `GCP_DEPLOYER_SERVICE_ACCOUNT`
secrets are now unreferenced. They were left in place rather than deleted —
secret values cannot be read back, so deleting them is irreversible and
buys nothing. Remove them by hand once a deploy has run green on the
variables.

#### Repo secret: `AGENT_CI_RERUN_TOKEN`

One credential deserves its own note, because what it must **not** be is the
point of it.

Agents are allowed to rerun their own failed CI
(`.agents/skills/agent-protocol/reference/agent-protocol.md` §8). That needs
`actions: write`, which the token the Claude action vends does not have. The
obvious source is the workflow's own `GITHUB_TOKEN` — and that is exactly
what this must never be: it carries the job's full
contents/issues/pull-requests grant, the workflow's own control-plane
credential, so handing it to agent code would let that code act as the
controller
([#645](https://github.com/jlapenna/agent-lcars/issues/645)).

So this is a **classic PAT at `public_repo` scope, issued from the
`agent-lcars-bot` machine account** — not the maintainer's. `public_repo` is the
narrowest classic scope that can rerun a workflow here, and this repository
is public, so it suffices.

**The machine account is what makes the containment real rather than
nominal.** `public_repo` grants write across the _token owner's_ accessible
public repositories. Issued from `agent-lcars-bot` that is effectively this
repository alone, and the fleet's private repos (`jlapenna/homelab`,
`supersprinklesracing/sprinkles`) are unreachable — verified: they answer
`404`, not `403`, so the token cannot even observe that they exist. The same
scope issued from a maintainer account would have spanned every public
repository that account can write.

**What it still does not buy.** Classic scopes cannot express "actions:
write and nothing else": `public_repo` also carries `issues: write` on the
repositories it does reach, so this token _can_ edit issue comments on
this one (in the broker era that meant the dispatch ledger itself). The
boundary is "a separate, attributable, independently revocable
identity, confined to this public repository" — not "cannot write
anything here".

Two alternatives were considered and rejected. A **fine-grained** PAT would
express exactly `Actions: write` and nothing more, but does not work here. A
minted **App installation token** is genuinely narrow, but expires after an
hour while an opencode agent step may run for two — the agent would lose the
capability partway through the runs most likely to need it.

**A consuming private repo cannot copy this verbatim.** `public_repo` grants
nothing on a private repository, so `jlapenna/homelab` or
`supersprinklesracing/sprinkles` would each need full `repo` scope. Issue
those as separate per-repository tokens rather than widening this one: a
single shared `repo`-scoped PAT would let an agent running here — in a
public repo — reach private infrastructure it otherwise has no path to.

That residue is not a gap to be closed by better credential hygiene. An
agent that comments on issues needs `issues: write`, and in the broker era
the dispatch ledger _was_ an issue comment — the argument that drove moving
control-plane state somewhere a repository-scoped token cannot reach at
all, realized today by the hosted orchestrator's Firestore-backed task
state ([#645](https://github.com/jlapenna/agent-lcars/issues/645) Phase 5).

Fails **loudly, not closed**: each worker warns if the secret is unset, and
the agent simply cannot rerun. That is deliberate — an empty
`$ACTIONS_RERUN_TOKEN` produces an opaque `gh` error inside an agent turn,
which reads as "the agent is stuck" rather than "a secret is missing".

No worker's agent step receives the job token under any name or spelling,
including via inherited workflow/job-level `env:` — a `workflow-contract.spec.ts`
in the now-deleted `apps/dispatch-broker` once asserted this mechanically;
it was retired along with the canary/smoke-test scaffolding in #885 and has
had no automated replacement since, so this invariant is presently
maintained by workflow review rather than a test.

### 5. Terraform

`infra/terraform/` is entirely instance config by definition: project id,
service accounts, WIF pool, secret containers, budget. It owns secret
_containers_ but never secret _values_ (see `AGENTS.md`).

### 6. Protocol docs

The shared `agent-protocol` names `jlapenna` and `agent-lcars-bot` directly
because they are fleet-wide constants across every onboarded repository.
Agent LCARS-specific deployment and infrastructure policy stays in
`agent-lcars-dev`; the `lcars` skill describes control-plane internals only.

## If you fork this

1. `apps/console/src/lib/deployment.ts` — or just set the env vars.
2. `AGENT_TELEMETRY_CHECKOUT_ROOTS` — host mode requires explicit absolute
   roots; there is no developer-home fallback.
3. `infra/terraform/variables.tf` — project id, owner, repo.
4. The repo variables in §3 (`gh variable set …`) — no workflow edits needed.
5. `apps/console/apphosting.yaml` — backend id and the env block.
