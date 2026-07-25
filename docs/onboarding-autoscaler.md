# Onboarding infrastructure to the runner-autoscaler

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
        mount_docker_socket: false # see the split below before setting true
```

### One scale set is rarely enough — split by trust level

**Never let arbitrary agent-authored code hold the Docker socket.** A
scale set that AI-agent-dispatched jobs run on (a `claude`/`opencode`/
`codex` label pipeline) should have `mount_docker_socket: false`. If the
same registration also needs trusted, workflow-defined-only CI (build/test
image publishing, e2e-docker-style jobs) that genuinely needs
`docker build`/`docker run`, give it a **separate** scale set with
`mount_docker_socket: true` — never flip the agent-dispatch pool's flag to
get it. For example: `homelab-autoscale-e2e-docker` (docker-enabled) is
kept separate from `homelab-autoscale-claude-agent` (agent-dispatch,
no socket) under one registration; `homelab-autoscale-lcars-docker`
(docker-enabled) is likewise separate from
`homelab-autoscale-claude-agent-lcars` (agent-dispatch) under another.
Mirror that shape rather than reusing one pool for both purposes.

If any scale set in the whole file sets `mount_docker_socket: true`,
**every** host in `fleet.hosts` needs **both** `docker_socket_gid` **and**
`workdir_size_cap` set (`resolveScaleSets()` checks both, independently,
for every host — missing either one refuses to start with "socket-enabled
scale set ... requires docker_socket_gid/workdir_size_cap for host ...")
— check the existing `fleet:` block; this is very likely already
satisfied fleet-wide, but verify rather than assume.

`runner_image` is normally the existing shared JIT image
(`docker-registry.lan.jlapenna.net/homelab-runner:jit-node24`) — reuse it
unless this registration genuinely needs different baked-in tooling.

## 3. Vault the private key

Mirrors every other homelab secret, in `ansible/secrets.yml`:

```
github_autoscaler_<registration>_app_private_key: <the .pem contents>
```

`ansible/deploy_secrets.yml` materializes it to the `private_key_file`
path from step 2 (mode `0600`). Until the vault entry exists, that deploy
task is a no-op (`when: ... is defined`) rather than a hard failure — the
`orchestrator.yml` shape can be committed before the App/key exist without
breaking anything else in the meantime.

## 4. Validate before deploying

```bash
docker compose run --rm --no-deps runner-autoscaler --check-config
```

Catches YAML/schema errors, duplicate labels across registrations, and the
`docker_socket_gid`/`workdir_size_cap` invariants above — all without
touching any live listener or Docker mutation.

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

This runs both plays in `deploy_runner_autoscaler.yml`: redeploying the
control plane (pulling the published image, falling back to a fresh
clone-and-build only if the pull fails) and refreshing the JIT worker
image on every fleet host. A bad config is caught by `--check-config` (§4,
and also run automatically as part of `deploy.sh`) before any live
listener is drained, so a mistake here fails loudly rather than taking
down existing registrations.

## 6. If this registration needs a custom runner image

Most registrations reuse the existing shared JIT image (§2). If yours
genuinely needs different baked-in tooling, build it from a
**self-contained build context** — this repo's own `AGENTS.md` reserves
cloning another repo's live branch mid-build for the one sanctioned
telemetry-watcher stage in `apps/runner-autoscaler/runner-image/Dockerfile`;
that's not a pattern to repeat for a new image.

Publish it from a **docker-socket-enabled, non-agent-dispatch** scale set
(§2's split above) — never the AI-agent pool — pushing to
`docker-registry.lan.jlapenna.net` (anonymous push works from this network
position — no `docker/login-action` needed). See this repo's own
`.github/workflows/publish-runner-autoscaler.yml` for a working reference:
multi-arch build+push (`docker/setup-qemu-action` +
`docker/setup-buildx-action` + `docker/build-push-action`, since the fleet
spans both amd64 and arm64 hosts) with a registry-backed layer cache
(`cache-from`/`cache-to: type=registry`).

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
