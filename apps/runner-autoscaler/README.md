# runner-autoscaler

Go source for the GitHub Actions runner-fleet control plane — one
orchestrator process that supervises independent GitHub scale-set listeners
(across `supersprinklesracing/sprinkles` and `jlapenna/agent-lcars`) and
schedules ephemeral runner containers across a shared Docker host pool. Also
includes `runner-image/`, the Dockerfile for the JIT worker image those
runners actually execute jobs in.

This Go module is an Nx application managed by
[`@naxodev/gonx`](https://gonx.naxo.dev/). GoNx infers the standard Go
targets and dependencies from `go.mod`, so local validation, CI, caching,
and affected-project detection all run through the workspace task graph.

## Build & test

```sh
./tools/nx build @agent-lcars/runner-autoscaler
./tools/nx test @agent-lcars/runner-autoscaler
./tools/nx typecheck @agent-lcars/runner-autoscaler
```

## Runner connectivity metrics

The control plane reconciles its locally tracked containers against GitHub's
runner list once per minute per registration. Runners receive a five-minute
startup grace period based on their container creation time; after that,
GitHub-side divergence is exposed as:

- `github_runner_autoscaler_github_unavailable_runners{scale_set,host,reason}`
  where `reason` is bounded to `offline` or `missing`.
- `github_runner_autoscaler_runner_status_probe_up{registration}`, which is
  `0` when the latest GitHub status query failed. Unavailable-runner counts
  retain their last successful values while the probe is down.

The deployment-owned alert can page on unavailable runners persisting for ten
minutes without mistaking the brief registration window during startup for a
dead broker connection.

## Deployment

The actual runtime config (`orchestrator.yml`: fleet host inventory, GitHub
App credentials, scale-set definitions) and the Ansible playbook that deploys
this are owned by [`jlapenna/homelab`](https://github.com/jlapenna/homelab)
(`github-runner-autoscaler/`), which pulls the images this repo's CI builds
and publishes rather than building from source itself — see that repo for
operational docs (secrets, GitHub App setup, fleet topology).

Migrated from `jlapenna/homelab` — see
[agent-lcars#52](https://github.com/jlapenna/agent-lcars/issues/52).
