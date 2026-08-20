# Canonical image publishing

Agent LCARS owns the source and the Dockerfiles for its fleet images. The
canonical `jlapenna/homelab` checkout is the only publisher: it resolves a
reviewed Agent LCARS revision, sends builds to the mTLS remote BuildKit
builder, stages immutable commit-SHA tags, scans every target platform, and
only then promotes the fleet tag. GitHub Actions and repository runners do
not publish images or receive registry-write credentials.

From the canonical homelab checkout:

```bash
./bin/publish-agent-lcars-images.sh <image> [<image> ...]
```

The wrapper invokes the shared `bin/publish-internal-image.sh` primitive for
each selected image. All selected images use one resolved Agent LCARS commit.
It preserves the existing provenance/SBOM, remote BuildKit cache, scan, and
registry-side promotion contract.

## Image map

| Select this argument      | Build context                                | Dockerfile                                              | Promotion tag          |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------- | ---------------------- |
| `runner-autoscaler`       | `apps/runner-autoscaler`                     | `apps/runner-autoscaler/Dockerfile`                     | `latest`               |
| `control-plane-runner`    | `apps/runner-autoscaler/control-plane-image` | `apps/runner-autoscaler/control-plane-image/Dockerfile` | `latest`               |
| `homelab-runner`          | `apps/runner-autoscaler/runner-image`        | `apps/runner-autoscaler/runner-image/Dockerfile`        | `jit-node24`           |
| `telemetry-watcher`       | repo root                                    | `apps/telemetry-watcher/Dockerfile`                     | `latest`               |
| `github-actions-exporter` | `apps/github-actions-exporter`               | `apps/github-actions-exporter/Dockerfile`               | `latest`               |
| `e2e`                     | `tools/e2e`                                  | `tools/e2e/Dockerfile`                                  | `df-<Dockerfile hash>` |
| `e2e-runner`              | repo root                                    | `tools/e2e-runner/Dockerfile`                           | `latest`               |

The JIT runner receives the selected source SHA as both `CACHE_BUST` and
`AGENT_LCARS_REF`, plus its required C toolchain packages. The E2E runner
receives the matching E2E sandbox reference as `SANDBOX_IMAGE`.

## Select only artifacts whose inputs changed

This command is intentionally explicit rather than triggered from GitHub.
It avoids a repository credential path and keeps each promotion a deliberate
homelab operation. Select:

- `runner-autoscaler` and `control-plane-runner` for control-plane source or
  Dockerfile changes.
- `homelab-runner` and `telemetry-watcher` together for any
  telemetry-watcher bundle input: the watcher app, `libs/telemetry`,
  `libs/logging`, `libs/env-vars`, `libs/util`, `libs/util-server`,
  `package.json`, `pnpm-lock.yaml`, or `patches`.
- `homelab-runner` alone for its runner-image-only inputs. These go beyond
  `apps/runner-autoscaler/runner-image/**`: the image also bakes in
  `packages/fleet-tools/**` (installed globally via `npm install -g` from
  the same fresh-`main` checkout the telemetry stage builds from, #1328)
  and `agents/opencode/**` (the managed provider configuration and its
  referenced standing instructions)
  and an action-archive cache derived from the repo's own `.github` tree
  (`populate-action-archive-cache.sh`, #1330) — a change to either
  requires re-publishing `homelab-runner`.
- `github-actions-exporter` for its Dockerfile, `exporter.py`, or
  `requirements.lock`.
- `e2e` and `e2e-runner` together when `tools/e2e/Dockerfile` changes.
- `e2e-runner` alone for `tools/e2e-runner/**` changes.

The E2E sandbox tag is content-addressed. Do not select `e2e` for unrelated
changes: its `df-<hash>` tag must continue to identify the Dockerfile that
created it. `--all` is available only for an intentional complete rebuild.

Before publishing an artifact, run the normal repository validation for its
source revision. The publisher does not replace application tests; it makes
the resulting trusted image deterministic, scanned, and promoted only after
those checks succeed.
