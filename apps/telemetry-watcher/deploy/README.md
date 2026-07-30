# Deploying the telemetry watcher

The `agent-lcars-telemetry-watcher` container (this app's Docker image,
published by [`.github/workflows/publish-images.yml`](../../../.github/workflows/publish-images.yml)
— see the app README's [Deployment](../README.md#deployment) section) runs
as a per-host daemon on `pike`, a `jlapenna/homelab`-fleet Docker host.
This directory is the deployment config's canonical home — moved from
`jlapenna/homelab` in homelab#218 Phase 6, on the reasoning that the
deployment config should live with the image that builds it and the
semantics (allowlists, entrypoint, uid) it depends on.

## Files

- `docker-compose.yml` — the compose service definition. Almost every
  non-default setting here (why uid 1000, why `pid: host` +
  `security_opt: apparmor=unconfined`, why the project-dir/cwd allowlists
  are pinned explicitly instead of left to the image default) is the
  product of a real incident and is explained in its own in-file comments
  — read those before changing anything.
- `.env.example` — copy to `.env` on pike (never commit `.env`).
- `deploy.sh` — pulls the image, syncs the compose file, brings the stack
  up, and verifies the container is actually stable/healthy afterward (not
  just "Up" per `docker ps`).

## Secrets

Two files must exist on pike, at
`/home/homelab/agent-lcars-telemetry-watcher/`, before `deploy.sh` will
bring the service up:

- **`.env`** — `AGENT_TELEMETRY_PROJECT_ID`. Never managed by automation;
  copy `.env.example` and fill it in by hand.
- **`writer-key.json`** — the `telemetry-writer` service-account key
  (JSON), bind-mounted read-only into the container and read as uid 1000
  (see the compose file's comment for why: the container's process reads
  it directly at a fixed uid, unlike `.env`, which the host's `docker`
  CLI reads under whatever identity invokes it).

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
  3. `ansible/sync_agent_lcars_writer_key.yml` (hosts: `pike`) pushes the
     staged file to `/home/homelab/agent-lcars-telemetry-watcher/writer-key.json`
     over SSH+`become` and applies the container's required `1000:1000`
     ownership — this is deliberately the one narrow piece of
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
  if it's missing, then enforces `1000:1000` ownership and `0600` mode on
  it every run regardless of how it arrived (vault-synced or hand-placed)
  — this repo's deploy never needs to know which.

## Deploying

On pike, as the identity that owns `/home/homelab/agent-lcars-telemetry-watcher`
(normally the `homelab` service account, with `sudo` available for the
ownership fixups above):

```bash
./deploy.sh
```

## Monitoring

`jlapenna/homelab` keeps the Prometheus alert rule that watches this
container — `AgentLcarsTelemetryWatcherCrashLooping` in that repo's
`observability/prometheus/rules.yml`. It's cAdvisor-metric based (container
restart count / presence), i.e. it belongs to homelab's own
cadvisor/Prometheus monitoring stack, not this repo. Only the _deployment_
config moved here in homelab#218 Phase 6 — the _monitoring_ of the deployed
container stays in homelab.
