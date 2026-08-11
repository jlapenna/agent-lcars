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
  just "Up" per `docker ps`).

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

On each watcher host, as the identity that owns
`/home/homelab/agent-lcars-telemetry-watcher` (normally the `homelab` service
account, with `sudo` available for ownership fixups):

```bash
./deploy.sh
```

## Monitoring

The watcher publishes Prometheus text on host port `9464`; its Compose
healthcheck exercises that exact endpoint. `jlapenna/homelab` owns the scrape
and alert rules: cAdvisor still detects crash loops, while the watcher metrics
distinguish a healthy tick loop from a watcher that has stopped shipping
active sessions. Only the deployment config moved here in homelab#218 Phase
6—the monitoring of the deployed container stays in homelab.
