# Onboarding infrastructure to the runner-autoscaler

> Part of the end-to-end repo onboarding sequence — start at
> [onboarding-repo.md](onboarding-repo.md); this doc is its §2 (capacity).

How to add a new GitHub account/repo — a **registration** — to the shared
fleet, so it gets its own on-demand, ephemeral self-hosted runners without
a new standalone control plane.

## The model, briefly

One orchestrator process (`apps/runner-autoscaler/`, published as
`docker-registry.lan.jlapenna.net/agent-lcars/runner-autoscaler:latest`,
deployed by `jlapenna/homelab`) supervises independent GitHub scale-set
listeners across every registration, scheduling all of them against one
shared Docker host pool. A **registration** is a distinct GitHub
account/repo with its own GitHub App — a GitHub App installation can't
span accounts, so each new account/repo needs its own registration block,
its own App, and its own entry under `registrations:` below. Every
registration's scale sets share the same fleet of Docker hosts as every
other registration already onboarded.

Everything below is `jlapenna/homelab`'s `github-runner-autoscaler/`
directory (`orchestrator.yml`, `docker-compose.yml`, `ansible/`) — that
repo owns deployment config; this repo (`agent-lcars`) owns the Go source
and publishes the images homelab pulls.

### `orchestrator.yml`'s full shape

One file holds everything: the primary registration's own top-level
`github:`/`scale_sets:` keys, the shared `fleet:`/`server:` config every
registration schedules against, and every other registration under
`registrations:`. Onboarding a new registration only ever touches that
last array — never the top-level keys, which belong to the primary
registration.

```yaml
version: 1

# The primary registration's own config lives at the top level (no
# `registrations:` entry for it) -- this is the one exception to "every
# registration is a registrations: entry".
github:
  url: https://github.com/<primary-owner>/<primary-repo>
  runner_group: Default

server:
  metrics_addr: :8080
  log_level: info
  log_format: text

fleet:
  # Hard cap across EVERY scale set in the whole file, primary registration
  # and every entry under registrations: combined -- config validation
  # rejects a cap lower than the sum of every scale set's own max_runners
  # ("fleet.max_runners N exceeds aggregate scale-set maximum M"). Raise
  # this whenever a new registration's scale sets push the real sum past
  # it; 10 below only covers the two scale sets this skeleton shows.
  max_runners: 10
  hosts:
    - name: <host-name>
      docker: local # or ssh://<user>@<host>.<domain> for a remote host
      # Optional per-host override; telemetry probes otherwise time out in 1s.
      metrics_timeout: 5s
      workdir_size_cap: 30g
    # ... more hosts -- see the live file for the fleet's current,
    # actively-changing host list; don't treat this as authoritative.
  placement:
    host_metrics_url_template: http://%s.<domain>:9100/metrics
    load_soft: 0.75
    load_busy: 1.0
    load_hard: 1.5
    cpu_soft: 0.85
    cpu_hard: 0.95
    # ... more placement-pressure tuning knobs -- see the live file.

scale_sets: # the PRIMARY registration's own scale sets
  - name: <primary>-autoscale-default
    labels: [default, <primary>-autoscale-default]
    runner_image: docker-registry.lan.jlapenna.net/homelab-runner:jit-node24
    min_runners: 0
    max_runners: 8
    weight: 1
  # ... more scale sets for the primary registration.

registrations: # every OTHER registration -- see §2 below
  - name: my-new-registration
    # ...
```

## 1. Provision a GitHub App (manual, one-time, human)

Distinct accounts need distinct Apps — installations don't span accounts.

1. **New App**: `https://github.com/settings/apps/new` (personal account)
   or `https://github.com/organizations/<org>/settings/apps/new` (org) —
   webhook **Active unchecked** (the client polls, no webhook needed);
   **Repository permissions → Administration: Read and write**; install
   **"Only on this account"**.
2. Client ID (`Iv23…`) — not a secret, commit it directly into
   `orchestrator.yml`.
3. **Generate a private key** (`.pem`) — vault it (see step 3 below),
   **never** commit the PEM itself.
4. **Install** on the target account, **only** the specific repo(s) this
   registration needs.
5. Installation ID — not a secret, commit it directly:
   ```bash
   gh api /repos/<owner>/<repo>/installation --jq .id
   ```

## 2. Add the registration to `orchestrator.yml`

```yaml
registrations:
  - name: my-new-registration
    disabled: false # or omit; disabled: true is inert (skipped entirely,
    # can't block startup/--check-config for any other registration) if
    # you want to commit the shape before the App exists yet
    github:
      url: https://github.com/<owner>/<repo>
      runner_group: Default
    app:
      client_id: Iv23... # from step 1.2, not a secret
      installation_id: 12345678 # from step 1.5, not a secret
      private_key_file: /secrets/my-new-registration-app-private-key.pem
    scale_sets:
      - name: homelab-autoscale-my-new-registration
        labels: [my-new-registration, homelab-autoscale-my-new-registration]
        runner_image: docker-registry.lan.jlapenna.net/homelab-runner:jit-node24
        min_runners: 0
        max_runners: 2
        weight: 1
```

### Choosing a scale set: don't just reuse whichever pool already has the right label

**Runtime duration is a placement concern.** A scale set's `max_runners` is
a hard ceiling on how many jobs with that label can run at once; pointing a
new, long-running (double-digit-minute) job at a pool sized for small, fast
jobs starves everything else waiting on that same label for as long as the
long job runs.

This actually happened (agent-lcars#408/#451): `ci.yml`'s `verify`/`e2e`
jobs (20-30 min) landed on `lcars-default`, a 2-runner pool
`orchestrator.yml`'s own comment already documented as reserved for small
glue jobs (`agent-automerge.yml`, hosted-control-plane support) specifically
so they'd never queue behind something slow. It
still happened, because nothing forced a reader adding a new `runs-on` to
check what else already shared that label. `ci.yml`'s jobs got their own
`homelab-autoscale-lcars-ci` pool instead once diagnosed.

Before pointing a new (or newly self-hosted) job at an existing label,
ask: **how long does this job run, and what else already uses this
label?** If the answer is "several minutes or more" and the existing pool
backs anything latency-sensitive, give the new job its own scale set —
same `runner_image`, just a different `name`/`labels`/`max_runners`,
mirroring `homelab-autoscale-lcars-ci` alongside
`homelab-autoscale-lcars-default` in the live `orchestrator.yml`.

### Building images: use the canonical publisher

Do not create a repository-specific publish runner, GitHub App, or workflow.
The canonical `jlapenna/homelab` checkout is the fleet's sole image-publish
authority. It holds the mTLS BuildKit client material and the internal
registry writer credential, while every repository runner remains free of
both.

Add a narrow wrapper in canonical homelab that calls
`bin/publish-internal-image.sh`. The wrapper should declare only the source
repository, build context, Dockerfile, platforms, required build arguments,
and final promotion tag. The shared publisher stages a commit-SHA tag,
attests provenance/SBOM, scans every platform, and promotes only after scans
pass. See `docs/registry.md` there for the runbook.

### There is no Docker socket to mount

`orchestrator.yml` has no `mount_docker_socket` option — that capability
was removed entirely. No spawned runner can ever be handed the placement
host's `docker.sock`, and `file_mounts` unconditionally rejects it as a
source too (see `dockerSocketPaths` in `orchestrator_config.go`), so there
is no way around this via config.

It existed once, gated per scale set, with `homelab-autoscale-e2e-docker`
(docker-enabled) kept strictly separate from agent-dispatch pools like
`homelab-autoscale-claude-agent` — never let arbitrary agent-authored code
anywhere near the socket, since it is root-equivalent on the placement
host. It was removed once every scale set that used to need it (the E2E
pools) was rebuilt so the runner itself is the pinned sandbox image, with
no inner container to create and therefore no reason to hold the socket.

If a genuine future need for `docker run` semantics on a runner shows up,
that is a design decision requiring its own scale-set-level trust
boundary, not a flag to flip — see the `MountDockerSocket`/
`docker_socket_gid`/`fleet.docker_socket_allowlist` history in this repo's
git log (`apps/runner-autoscaler`) for the shape it used to take. Building
images (`docker build`) never needs this at all — use the canonical
publisher above.

`runner_image` is normally the existing shared JIT image
(`docker-registry.lan.jlapenna.net/homelab-runner:jit-node24`) — reuse it
unless this registration genuinely needs different baked-in tooling.

## 3. Vault the private key and wire its deployment

There's no generic, registration-name-driven mechanism for this — each
registration needs its own hand-added vault entry, deploy task, and
compose bind-mount, mirroring the existing entries (search
`ansible/deploy_secrets.yml` and `github-runner-autoscaler/docker-compose.yml`
for `lcars` to see the full pattern for the `agent-lcars` registration).
Three places need a new, registration-specific entry:

1. **`ansible/secrets.yml`** (`ansible-vault edit`): add a new key, e.g.
   `github_autoscaler_<short-name>_app_private_key: <the .pem contents>`
   — the short name doesn't have to match the registration's full name in
   `orchestrator.yml` (the real `agent-lcars` registration's key is
   `github_autoscaler_lcars_app_private_key`, not
   `..._agent-lcars_app_private_key`).
2. **`ansible/deploy_secrets.yml`**: add a task that writes that vault
   value to a new path (`../github-runner-autoscaler/<short-name>-app-private-key.pem`,
   mode `0600`), guarded by `when: github_autoscaler_<short-name>_app_private_key is defined`
   — **plus** a placeholder-file task (`state: touch`, guarded by the
   negated `is not defined`) so the bind-mount source below is always a
   real file, never missing. If Docker has to auto-create the bind-mount
   source itself, it creates a directory there instead of a file, which
   then blocks ever placing the real PEM at that path. Also add a
   `..._APP_PRIVATE_KEY_PATH=...` line to the `.env` content block further
   down in the same file.
3. **`github-runner-autoscaler/docker-compose.yml`**: add a volume line —
   `${<SHORT_NAME>_APP_PRIVATE_KEY_PATH}:/secrets/<short-name>-app-private-key.pem:ro`
   — using the same env var name from step 2, and point `orchestrator.yml`'s
   `private_key_file` (step 2 above) at that same `/secrets/...` path.

Until the vault entry exists, the real-deploy task in step 2 is a no-op
(`when: ... is defined`, with the placeholder task filling the gap) rather
than a hard failure — the `orchestrator.yml` shape and this wiring can all
be committed before the App/key exist, and `disabled: true` keeps the
registration inert in the meantime.

## 4. Validate before deploying

From the repo root, `cd` into `github-runner-autoscaler/` first — that's
where this `docker-compose.yml` and its `runner-autoscaler` service are
defined, not `ansible/`, which has its own separate compose file:

```bash
cd github-runner-autoscaler
docker compose run --rm --no-deps runner-autoscaler --check-config
```

Catches YAML/schema errors, duplicate labels across registrations, and the
`workdir_size_cap` invariant above — all without touching any live listener
or Docker mutation.

## 5. Deploy — **this must run on the `homelab` host itself**

**`docker compose run --rm deploy-runner-autoscaler`** (or
`ansible-playbook deploy_runner_autoscaler.yml` directly) **is only
meaningful when run ON the `homelab` host, as the `homelab` service-account
user, from that host's own checkout.** It is _not_ meant to be triggered
remotely from an operator workstation, even though the playbook's
`hosts: homelab` target technically resolves over SSH from anywhere with
the right key. A workstation's own local checkout of `jlapenna/homelab`
has no deploy relevance at all — an SSH-key or file-ownership error there
is a sign of deploying from the wrong place, not a problem to fix in
place.

**Never authenticate to `homelab` (or any fleet host) as the personal
`jlapenna` identity for any of this.** Always the dedicated `homelab`
service account:

```bash
ssh homelab@homelab.lan.jlapenna.net
cd /home/homelab/p/homelab/ansible
git pull --ff-only
docker compose run --rm deploy-runner-autoscaler
```

This runs both plays in `deploy_runner_autoscaler.yml` — and the first
play's blast radius is bigger than just the autoscaler: before it ever
touches the control plane, it first runs `docker compose up -d --build
--remove-orphans` against homelab's entire core-services stack and
reloads Caddy, **then** redeploys the autoscaler control plane (pulling
the published image; a failed pull is a hard failure — there is no
local-build fallback, because rebuilding on a failed pull masks the outage
and diverges hosts onto their own unreviewed builds). The second play refreshes the JIT worker image on every
fleet host. A bad config is caught by `--check-config` (§4, and also run
automatically as part of `deploy.sh`) before any live listener is
drained, so a mistake in the autoscaler's own config fails loudly rather
than taking down existing registrations — but this is not a
narrowly-scoped "just restart the autoscaler" command.

## 6. If this registration needs a custom runner image

Most registrations reuse the existing shared JIT image (§2). If yours
genuinely needs different baked-in tooling, build it from a
**self-contained build context** — this repo's own `AGENTS.md` reserves
cloning another repo's live branch mid-build for the one sanctioned
telemetry-watcher stage in `apps/runner-autoscaler/runner-image/Dockerfile`;
that's not a pattern to repeat for a new image.

Add the custom image to canonical homelab rather than creating a
registration-specific publisher. Its wrapper calls the generic publisher,
so it gets the same remote BuildKit driver, registry-backed cache,
provenance/SBOM, staged commit-SHA tag, per-platform Trivy scan, and
registry-side promotion as every other fleet image. The registry password is
read only by the canonical controller, never a GitHub Actions runner.

No `docker/setup-qemu-action` is needed: arm64 emulation lives on the remote
builder. See canonical homelab's `docs/registry.md` for the publisher
contract, credential rotation, and policy verification.

## Verifying it actually worked

Same principle as the console/telemetry onboarding doc: confirm live, not
assumed.

1. After deploying, check the control plane's own health and metrics from
   the homelab host:
   ```bash
   docker inspect runner-autoscaler --format '{{.State.Health.Status}}'
   docker exec runner-autoscaler wget -qO- http://localhost:8080/metrics \
     | grep github_runner_autoscaler_listener_up
   ```
   Every scale set across every registration should show
   `listener_up{scale_set="..."} 1`. A registration whose listener never
   comes up (App credentials wrong, installation ID mismatch, disabled
   left `true`) shows up here immediately.
2. Dispatch a real, cheap job at the new registration's scale set(s) —
   `workflow_dispatch` on something lightweight that targets the right
   `runs-on` label — and confirm it actually gets picked up and completes,
   not just that the container is "up."
3. If other registrations share this control plane (they do, by design),
   re-verify **they** still work too after your deploy — a shared control
   plane means every registration's runners restart together on any
   redeploy. A quick real dispatch against an existing registration (not
   just the new one) is the honest way to confirm nothing regressed.
