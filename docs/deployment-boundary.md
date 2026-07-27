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

`DEFAULT_CHECKOUT_ROOT` (`/home/jlapenna/p/members`) scopes the host
watcher's privacy allowlists. Overridable per source via
`AGENT_TELEMETRY_*` env vars (see `config.ts`); the constant is the fallback
all three encodings derive from.

Note runner mode deliberately ignores it — see `runner.ts`'s
`RUNNER_ALLOWLIST` / `RUNNER_CODEX_CWD_ALLOWLIST`.

### 3. Workflows

Not extractable by relocation; use repo variables instead. Instance values
currently inline in `.github/workflows/`:

- runner pool label — `claude-agent-lcars` (claude/codex/opencode)
- WIF provider — `projects/611425338852/.../providers/github`
- service accounts — `telemetry-writer@`, `codex-agent@agent-lcars`
- registry host — `docker-registry.lan.jlapenna.net`
  (`publish-runner-autoscaler.yml`)
- maintainer login in dispatch guards (`github.actor == 'jlapenna'`)
- `AGENT_BOT_LOGINS`, `NX_CACHE_URL` — already repo variables

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
2. `apps/telemetry-watcher/src/lib/default-checkout.ts`.
3. `infra/terraform/variables.tf` — project id, owner, repo.
4. `.github/workflows/*` — the values in §3.
5. `apps/console/apphosting.yaml` — backend id and the env block.
