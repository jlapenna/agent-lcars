# Deploying the telemetry watcher

The `agent-lcars-telemetry-watcher` container (this app's Docker image,
published from canonical `jlapenna/homelab` — see the app README's
[Deployment](../README.md#deployment) section) runs as a per-host daemon on
`pike`, `laforge`, and `janeway`, which are
`jlapenna/homelab`-fleet Docker hosts.
This directory is the deployment config's canonical home — moved from
`jlapenna/homelab` in homelab#218 Phase 6, on the reasoning that the
deployment config should live with the image that builds it and the
semantics (allowlists, entrypoint, uid) it depends on.

> [!IMPORTANT]
> The deploy is **not** run from this checkout directly. `deploy.sh` only
> needs `docker-compose.yml` beside it, but the `homelab` service account
> cannot read this jlapenna-owned checkout on laforge (`Permission denied`
> traversing into `~/p/agent-lcars`) and janeway has no persistent checkout at
> all. Instead, sync the deploy files into a homelab-readable directory once
> per deploy (issue #1304): run `sync-deploy.sh` from a checkout on the host,
> then deploy from the synced directory. See [Deploying](#deploying) below.

## Files

- `docker-compose.yml` — the compose service definition. Almost every
  non-default setting here (why the host's `jlapenna` uid, why `pid: host` +
  `security_opt: apparmor=unconfined`, why the project-dir/cwd allowlists
  are pinned explicitly instead of left to the image default) is the
  product of a real incident and is explained in its own in-file comments
  — read those before changing anything.
- `.env.example` — optional per-host Compose overrides (never commit `.env`).
- `deploy.sh` — pulls the image, syncs the compose file, brings the stack
  up, and verifies the container is actually stable/healthy afterward (not
  just "Up" per `docker ps`). Two independent knobs bound that
  verification, and they are not interchangeable: `HEALTH_TIMEOUT_SECONDS`
  (default 240) is a _ceiling_ on the wait for Docker's HEALTHCHECK, so it
  exits the moment the container is healthy and a generous value costs
  nothing on a good deploy; `STABILITY_WINDOW_SECONDS` (default 90) is a
  fixed `sleep` used only when no HEALTHCHECK is defined, so raising it
  lengthens every such deploy. The ceiling was 90s and produced a false
  failure on a real deploy — the container went healthy just after the
  script gave up, with 0 restarts — which is worse than a slow one: it
  teaches you to ignore the gate, and it fails automation that trusts the
  exit code.
- `install-session-title-cli.sh` — builds and installs the `lcars` CLI
  agents run to declare a session title, and that the timer below imports
  through; see [Session titles](#session-titles-issue-1212) below.
- `systemd/` — the `agent-lcars-session-title-import` user timer that
  imports Codex native session titles on the host; see
  [Session titles](#session-titles-issue-1212) below.

## Secrets

The watcher writer key must exist on each host at
`/home/homelab/agent-lcars-telemetry-watcher/writer-key.json` before
`deploy.sh` will bring the service up:

- **`writer-key.json`** — the `telemetry-writer` service-account key
  (JSON), bind-mounted read-only into the container and read as the host's
  `jlapenna` uid (see the compose file's comment for why: the container's
  process reads it directly under that account, unlike `.env`, which the
  host's `docker` CLI reads under whatever identity invokes it).

  **This credential's source of truth stays `jlapenna/homelab`'s encrypted
  vault**, not this repo — per this repo's own [`AGENTS.md`](../../../AGENTS.md)
  ("the host writer credential belongs in the encrypted homelab secret
  store"). Only the _deployment_ (compose file, image, health checks) moved
  here in homelab#218 Phase 6; the _secret_ did not, because agent-lcars has
  no encrypted secret store or SSH-based host access of its own — homelab
  still owns both. Concretely:
  1. `agent_lcars_writer_key_json` is a var in `jlapenna/homelab`'s
     encrypted `ansible/secrets.yml` (add via `./bin/manage-secrets.sh`
     there).
  2. `ansible/deploy_secrets.yml` decrypts it and stages it in that repo's
     tree.
  3. `ansible/sync_agent_lcars_writer_key.yml` (hosts:
     `telemetry_watcher_hosts`) pushes the
     staged file to `/home/homelab/agent-lcars-telemetry-watcher/writer-key.json`
     over SSH+`become` and applies the host's real `jlapenna` uid/gid — this
     is deliberately the one narrow piece of
     watcher-specific logic that stays in homelab, scoped to _secret
     delivery_ rather than _deployment_.

  Fallback (hand-placed, same convention as homelab's `github-runner`'s
  `RUNNER_TOKEN` `.env`, for a first deploy before the vault var above
  exists):

  ```bash
  gcloud secrets versions access latest --project=agent-lcars \
    --secret=AGENT_TELEMETRY_WRITER_KEY_JSON \
    > /home/homelab/agent-lcars-telemetry-watcher/writer-key.json
  ```

  `deploy.sh` checks for this file and fails with these same instructions
  if it's missing, then enforces the host's `jlapenna` uid/gid and `0600`
  mode on it every run regardless of how it arrived (vault-synced or
  hand-placed) — this repo's deploy never needs to know which.

The deployment derives the watcher uid, gid, home directory, and host label
from the local `jlapenna` account. Its default privacy scope is the explicit
set `~/p/sprinkles`, `~/p/agent-lcars`, and `~/p/homelab`. Override that scope
for a host by setting `AGENT_TELEMETRY_CHECKOUT_ROOTS` to a comma-separated
absolute-path list when invoking `deploy.sh`. Every override must resolve under
`~/p`, the checkout tree mounted into the container; the deploy fails closed
for roots outside it. There is intentionally no implicit "watch every
checkout" mode.

## Deploying

The deploy runs from a homelab-readable directory, synced from a checkout on
the host — never from the checkout itself.

**1. Sync the deploy files** (run from a checkout of this repo on the watcher
host, as the checkout owner — normally `jlapenna`):

```bash
apps/telemetry-watcher/deploy/sync-deploy.sh
```

This copies `deploy.sh`, `docker-compose.yml`, and `.env.example` into
`/home/homelab/agent-lcars-telemetry-watcher/` (override the target with
`AGENT_TELEMETRY_DEPLOY_DIR`, the same override `deploy.sh` honors). Re-run it
after any change to these files lands on `main` — it is idempotent and the
canonical refresh step, so the synced copy never silently goes stale.

**2. Deploy** — on each watcher host, as the identity that owns
`/home/homelab/agent-lcars-telemetry-watcher` (normally the `homelab` service
account, with `sudo` available for ownership fixups):

```bash
cd /home/homelab/agent-lcars-telemetry-watcher && ./deploy.sh
```

This invocation is runnable verbatim on all three hosts (pike, laforge,
janeway): `homelab` owns the synced directory on each, so no checkout
readability or persistence is required.

## Session titles (issue #1212)

Two tiers of session titles reach the watcher through
`~/.local/state/agent-lcars` (`AGENT_TELEMETRY_SESSION_STATE_DIR`), mounted
read-only into the container at that same absolute path — see the compose
file's comment on that mount for why it's a dedicated root and why Codex's
own state DB is deliberately not mounted:

- **`declared`** — `session-metadata/<sessionId>.json`. An agent (or a
  human) sets one by running `lcars session title "..."` from inside a
  Claude Code or Codex session. The CLI resolves the session id itself, in
  order: `LCARS_SESSION_ID` → `CLAUDE_CODE_SESSION_ID` → `CODEX_THREAD_ID`.
  The first one present _and_ passing `isSafeIdentifier` wins — a
  present-but-unsafe value is a hard failure, not a fall-through to the next
  candidate, so a malformed id can never silently retarget another
  runtime's session. This directory is written by the CLI running as the
  plain watcher-host user; `deploy.sh` only has to make sure it exists
  before Docker would otherwise create it root-owned.
- **`generated`** (imported half) — `native-titles/<sessionId>.json`. Codex
  doesn't carry a title in its rollout `.jsonl` transcripts at all — only in
  `~/.codex/state_*.sqlite`'s `threads` table, which the watcher container
  can never read directly (it's a WAL-mode DB; a read-only bind mount of it
  fails outright). The `agent-lcars-session-title-import` systemd **user**
  timer under [`systemd/`](systemd/) runs `lcars session import-native` on
  the host instead, every 2 minutes, and writes one JSON file per Codex
  session here. (Claude's half of the `generated` tier needs no importer —
  its `aiTitle` is read straight out of the transcript by the watcher, same
  as every other transcript field.)

Both files use the same envelope: `{version: 1, sessionId, updatedAt,
title}`. The directory a title lives in _is_ its tier — there is no third,
separately-recorded tier concept.

### Installing the CLI

Both the `lcars session title "..."` command an agent runs and the import
timer above depend on a `lcars` launcher existing on the watcher host —
nothing installs it automatically. From the primary `~/p/agent-lcars`
checkout (the one that persists on the host long-term; this builds an Nx
target, so it needs a real checkout, and never the checkout's own `dist/`
should be referenced directly — see the script's header for why):

```bash
apps/telemetry-watcher/deploy/install-session-title-cli.sh
```

This builds the `session-title-cli` Nx target and copies its bundle to
`~/.local/lib/agent-lcars/lcars-session-title.cjs` (override with
`AGENT_LCARS_SESSION_TITLE_CLI_LIB_DIR`), then generates a `lcars` launcher
at `~/.local/bin/lcars` (override with
`AGENT_LCARS_SESSION_TITLE_CLI_BIN_DIR`) that resolves `node` itself —
covering this fleet's fnm-managed installs, where the CLI shim isn't
reliably on PATH for every caller. Add `~/.local/bin` to the account's PATH
for interactive `lcars session title` use; the import timer below invokes
it by full path and doesn't need PATH. Re-run this script after any change
to the session-title CLI lands on that checkout's `main`.

### Installing the import timer

On the watcher host, as the **`WATCHER_USER`** account itself (`jlapenna` by
default — _not_ the separate `homelab` account `deploy.sh` runs as; this
timer needs read access to that account's own `~/.codex/state_*.sqlite` and
write access to the state root `deploy.sh` pre-creates for it), after
installing the CLI above:

```bash
mkdir -p ~/.config/systemd/user
cp apps/telemetry-watcher/deploy/systemd/agent-lcars-session-title-import.{service,timer} \
  ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-lcars-session-title-import.timer
```

The service fails soft (see its own comments) on a missing/locked Codex DB
or a not-yet-installed CLI — real failures show up in
`journalctl --user -u agent-lcars-session-title-import.service`, not in
`systemctl --user status` on the unit's own success/failure state.

## Monitoring

The watcher publishes Prometheus text on host port `9464`; its Compose
healthcheck exercises that exact endpoint. `jlapenna/homelab` owns the scrape
and alert rules: cAdvisor still detects crash loops, while the watcher metrics
distinguish a healthy tick loop from a watcher that has stopped shipping
active sessions. Only the deployment config moved here in homelab#218 Phase
6—the monitoring of the deployed container stays in homelab.
