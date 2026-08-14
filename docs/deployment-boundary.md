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

| Value                    | Env var                                | This deployment                  |
| ------------------------ | -------------------------------------- | -------------------------------- |
| maintainer login         | `AGENT_LCARS_ADMIN_GITHUB_LOGIN`       | `jlapenna`                       |
| agent fleet login        | `AGENT_LCARS_FLEET_GITHUB_LOGIN`       | `jclaw-bot`                      |
| artifact share base URL  | `AGENT_LCARS_ARTIFACT_SHARE_BASE_URL`  | `https://share.lan.jlapenna.net` |
| control-plane repository | `AGENT_LCARS_CONTROL_PLANE_REPOSITORY` | `jlapenna/agent-lcars`           |
| watched repos            | `AGENT_LCARS_WATCHED_REPOS`            | see `github-client.ts`           |

Each falls back to this deployment's value, so nothing breaks when a var is
unset. `apphosting.yaml` sets them explicitly anyway, so what production
runs with is visible in config rather than only in source.

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

### 3. Workflows — repo variables

Not extractable by relocation (`.github/workflows/` is a fixed path), so
these live as **repo variables** instead. Every one fails _closed_ if unset:
an unset variable interpolates to an empty string, which makes a `runs-on`
unschedulable, an auth step fail, and the `github.actor == vars.MAINTAINER_LOGIN`
dispatch guard evaluate false. Nothing silently falls back to a default.

| Variable                          | This deployment                                                                  | Used by                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `AGENT_RUNNER_LABEL`              | `claude-agent-lcars`                                                             | claude / codex / opencode                                                                                           |
| `DEFAULT_RUNNER_LABEL`            | `lcars-default`                                                                  | agent-automerge, label-contract-audit, deploy-console gate — small, fast glue jobs only (#451)                      |
| `CI_RUNNER_LABEL`                 | `lcars-ci`                                                                       | ci (verify, e2e), local App Hosting build/deploy — long work kept off the latency-sensitive glue pool (#451, #1030) |
| `GCP_PROJECT_ID`                  | `agent-lcars`                                                                    | codex (secret access)                                                                                               |
| `GCP_WIF_PROVIDER`                | `projects/611425338852/…/providers/github`                                       | claude / codex / opencode                                                                                           |
| `GCP_DEPLOYER_WIF_PROVIDER`       | `projects/611425338852/…/workloadIdentityPools/github-deployer/providers/github` | deploy-console only; provider accepts `deploy-console.yml` from `main`                                              |
| `GCP_WEBHOOK_CONFIG_WIF_PROVIDER` | Terraform output `github_app_webhook_configurator_workload_identity_provider`    | configure-github-app-webhook only; provider accepts that workflow from `main`                                       |
| `GCP_TELEMETRY_WRITER_SA`         | `telemetry-writer@agent-lcars…`                                                  | claude / codex                                                                                                      |
| `GCP_CODEX_AGENT_SA`              | `codex-agent@agent-lcars…`                                                       | codex                                                                                                               |
| `GCP_DISPATCH_PREFLIGHT_SA`       | `dispatch-preflight@agent-lcars…`                                                | worker preflight reads only                                                                                         |
| `GCP_WEBHOOK_CONFIG_SA`           | Terraform output `github_app_webhook_configurator_service_account`               | configure-github-app-webhook; reads only the webhook HMAC secret                                                    |
| `DISPATCH_FIRESTORE_DATABASE_ID`  | `dispatch-controller`                                                            | hosted controller and worker preflight                                                                              |
| `MAINTAINER_LOGIN`                | `jlapenna`                                                                       | dispatch guards, failure assignment                                                                                 |
| `AGENT_FLEET_LOGIN`               | `jclaw-bot`                                                                      | claim steps and queue hand-off                                                                                      |
| `APPHOSTING_BACKEND_ID`           | `agent-lcars`                                                                    | deploy-console                                                                                                      |
| `AGENT_BOT_LOGINS`                | `["claude[bot]","agent-lcars[bot]"]`                                             | agent-automerge — REST-shaped, see `docs/bot-identity-formats.md`                                                   |
| `NX_CACHE_URL`                    | homelab Nx cache                                                                 | all agent lanes (pre-existing)                                                                                      |

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
Agent LCARS repository variable.

One further exception:

- **Prose still names the logins** — step names ("Claim the issue as
  jclaw-bot"), `::warning::` text, and the agent prompt bodies. These are
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
(`.agents/skills/agent-protocol/agent-protocol.md` §8). That needs
`actions: write`, which the token the Claude action vends does not have. The
obvious source is the workflow's own `GITHUB_TOKEN` — and that is exactly
what this must never be: it carries the job's full
contents/issues/pull-requests grant and is the same credential the dispatch
broker reads and writes the ledger comment with, so handing it to agent code
would let that code rewrite the control plane's own state
([#645](https://github.com/jlapenna/agent-lcars/issues/645)).

So this is a **classic PAT at `public_repo` scope, issued from the
`jclaw-bot` machine account** — not the maintainer's. `public_repo` is the
narrowest classic scope that can rerun a workflow here, and this repository
is public, so it suffices.

**The machine account is what makes the containment real rather than
nominal.** `public_repo` grants write across the _token owner's_ accessible
public repositories. Issued from `jclaw-bot` that is effectively this
repository alone, and the fleet's private repos (`jlapenna/homelab`,
`supersprinklesracing/sprinkles`) are unreachable — verified: they answer
`404`, not `403`, so the token cannot even observe that they exist. The same
scope issued from a maintainer account would have spanned every public
repository that account can write.

**What it still does not buy.** Classic scopes cannot express "actions:
write and nothing else": `public_repo` also carries `issues: write` on the
repositories it does reach, so this token _can_ edit the ledger comment on
this one. The boundary is "a separate, attributable, independently revocable
identity, confined to this public repository" — not "cannot reach the
control plane".

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
agent that comments on issues needs `issues: write`, and the ledger _is_ an
issue comment — which is the argument for moving control-plane state
somewhere a repository-scoped token cannot reach at all
([#645](https://github.com/jlapenna/agent-lcars/issues/645) Phase 5).

Fails **loudly, not closed**: each worker warns if the secret is unset, and
the agent simply cannot rerun. That is deliberate — an empty
`$ACTIONS_RERUN_TOKEN` produces an opaque `gh` error inside an agent turn,
which reads as "the agent is stuck" rather than "a secret is missing".

`apps/dispatch-broker/src/workflow-contract.spec.ts` asserts no worker's
agent step receives the job token under any name or spelling, including via
inherited workflow/job-level `env:`.

### 4. Terraform

`infra/terraform/` is entirely instance config by definition: project id,
service accounts, WIF pool, secret containers, budget. It owns secret
_containers_ but never secret _values_ (see `AGENTS.md`).

### 5. Protocol docs

`.agents/skills/lcars/lcars-protocol.md` names `jlapenna` and `jclaw-bot`
directly. That's deliberate — it's instructions written for agents working
_this_ repo, not a reusable library.

## If you fork this

1. `apps/console/src/lib/deployment.ts` — or just set the env vars.
2. `AGENT_TELEMETRY_CHECKOUT_ROOTS` — host mode requires explicit absolute
   roots; there is no developer-home fallback.
3. `infra/terraform/variables.tf` — project id, owner, repo.
4. The repo variables in §3 (`gh variable set …`) — no workflow edits needed.
5. `apps/console/apphosting.yaml` — backend id and the env block.
