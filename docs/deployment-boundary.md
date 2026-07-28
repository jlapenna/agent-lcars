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

| Value                   | Env var                               | This deployment                  |
| ----------------------- | ------------------------------------- | -------------------------------- |
| maintainer login        | `AGENT_LCARS_ADMIN_GITHUB_LOGIN`      | `jlapenna`                       |
| agent fleet login       | `AGENT_LCARS_FLEET_GITHUB_LOGIN`      | `jclaw-bot`                      |
| artifact share base URL | `AGENT_LCARS_ARTIFACT_SHARE_BASE_URL` | `https://share.lan.jlapenna.net` |
| watched repos           | `AGENT_LCARS_WATCHED_REPOS`           | see `github-client.ts`           |

Each falls back to this deployment's value, so nothing breaks when a var is
unset. `apphosting.yaml` sets them explicitly anyway, so what production
runs with is visible in config rather than only in source.

Server-only. `@repo/util-server` must never reach a client bundle, which is
why `shareArtifactUrl` lives here rather than in `format.ts` — that module
is imported by client components.

### 2. `apps/telemetry-watcher/src/lib/default-checkout.ts`

`checkoutRoot()` is the checkout the host watcher is scoped to. All three
sources' default privacy allowlists derive from it — Claude project-dir
slugs (`allowlist.ts`), the Codex cwd allowlist (`config.ts`), and
Antigravity workspace prefixes — so their different encodings cannot drift
apart.

| Value         | Env var                         | This deployment              |
| ------------- | ------------------------------- | ---------------------------- |
| checkout root | `AGENT_TELEMETRY_CHECKOUT_ROOT` | `/home/jlapenna/p/sprinkles` |

Runner mode deliberately ignores it — see `runner.ts`'s `RUNNER_ALLOWLIST` /
`RUNNER_CODEX_CWD_ALLOWLIST`, where a wildcard is correct because the
container is single-purpose.

**This is why it matters that it's config and not a buried constant.** The
value said `/home/jlapenna/p/members` long after the repo was renamed to
`sprinkles`. The allowlist is an exact-prefix glob, so
`-home-jlapenna-p-sprinkles` never matched `-home-jlapenna-p-members*` — a
watcher on the default silently recorded _nothing_ from the repo it exists
to watch, with no error to notice. The rename had already been handled for
repo identity (`git-repo.ts`'s `LEGACY_REPO_ALIASES`); this path-shaped
copy of the same fact was missed.

### 3. Workflows — repo variables

Not extractable by relocation (`.github/workflows/` is a fixed path), so
these live as **repo variables** instead. Every one fails _closed_ if unset:
an unset variable interpolates to an empty string, which makes a `runs-on`
unschedulable, an auth step fail, and the `github.actor == vars.MAINTAINER_LOGIN`
dispatch guard evaluate false. Nothing silently falls back to a default.

| Variable                  | This deployment                            | Used by                                                                          |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `AGENT_RUNNER_LABEL`      | `claude-agent-lcars`                       | claude / codex / opencode                                                        |
| `DEFAULT_RUNNER_LABEL`    | `lcars-default`                            | agent-automerge                                                                  |
| `BUILD_RUNNER_LABEL`      | `lcars-build-client`                       | publish-runner-autoscaler                                                        |
| `GCP_PROJECT_ID`          | `agent-lcars`                              | codex (secret access)                                                            |
| `GCP_WIF_PROVIDER`        | `projects/611425338852/…/providers/github` | claude / codex / opencode                                                        |
| `GCP_TELEMETRY_WRITER_SA` | `telemetry-writer@agent-lcars…`            | claude / codex                                                                   |
| `GCP_CODEX_AGENT_SA`      | `codex-agent@agent-lcars…`                 | codex                                                                            |
| `HOMELAB_REGISTRY`        | `docker-registry.lan.jlapenna.net`         | publish-runner-autoscaler                                                        |
| `MAINTAINER_LOGIN`        | `jlapenna`                                 | dispatch guards, failure assignment                                              |
| `AGENT_FLEET_LOGIN`       | `jclaw-bot`                                | claim steps, git identity, queue hand-off                                        |
| `APPHOSTING_BACKEND_ID`   | `agent-lcars`                              | deploy-console                                                                   |
| `AGENT_BOT_LOGINS`        | `["claude[bot]","github-actions[bot]"]`    | agent-automerge (pre-existing) — REST-shaped, see `docs/bot-identity-formats.md` |
| `NX_CACHE_URL`            | homelab Nx cache                           | all agent lanes (pre-existing)                                                   |

Two values in `publish-runner-autoscaler.yml` are deliberately **not**
variables — its `runs-on: lcars-build-client` and its BuildKit
`endpoint:`. That workflow publishes the images the entire fleet pulls and
trusts, so where it runs and where it builds are trust decisions, not
configuration: a mutable repository variable would let anyone who can edit
variables redirect fleet-image publishing to a pool or builder they
control. The `runs-on` comment records that this was already fixed once
(it used to read `fromJSON(vars.CI_RUNS_ON || ...)`). A fork edits those
two lines by hand.

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
2. `AGENT_TELEMETRY_CHECKOUT_ROOT` — or `default-checkout.ts`'s fallback.
3. `infra/terraform/variables.tf` — project id, owner, repo.
4. The repo variables in §3 (`gh variable set …`) — no workflow edits needed.
5. `apps/console/apphosting.yaml` — backend id and the env block.
