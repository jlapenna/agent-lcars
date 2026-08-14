# Nx remote cache

This repo builds against a two-level Nx cache. Nothing here is required for a
correct build — every level is an optimization, and losing all of them costs
recomputation, not correctness.

## The two levels

**L1 — local, content-addressed, per primary checkout.** Nx's own task cache.
`tools/nx` points a linked worktree at the primary checkout's `.nx/cache`, so
concurrent agent worktrees reuse each other's task results instead of each
recompiling the same unchanged libraries. Cache keys are content hashes over
declared inputs, so sharing across branches is safe: different content hashes
differently and cannot collide.

**L2 — shared, over HTTP, on `spark`.** A self-hosted implementation of Nx
23.1's built-in remote-cache protocol (`GET`/`PUT /v1/cache/{hash}`, bearer
auth). It is deployed and documented in the `homelab` repo under
`nx-cache-server/`. Because entries are keyed purely by content hash, L2
dedupes across worktrees, across hosts, and between local development and CI
automatically.

L1 is a per-host disk budget, not a shared directory — the fleet caps it via
`nx_cache_cap_kb` in the homelab inventory (pike: 10G). Do **not** try to make
repos share one L1 directory with `NX_CACHE_DIRECTORY`. That variable is
repo-agnostic: an absolute value is used verbatim by every workspace on the
box, and a relative value is re-resolved against each workspace root. Neither
gives you "one cache per repo," and pointing two repos at one directory makes
them fight over each other's `maxCacheSize` eviction budget. L2 is the sharing
layer; that is what it is for.

### Managed App Hosting builds

The console's managed Firebase App Hosting builder has a narrower cache
boundary than developer machines and CI. App Hosting preserves its workspace
state across builds, so `.nx/cache` is its L1. `tools/cloud-build-prebuild.sh`
removes stale `dist` and `.tsbuildinfo` outputs but deliberately preserves that
content-addressed cache; the next `@agent-lcars/console:bundle` invocation can
then restore a complete `dist/apps/console` output for unchanged inputs.

Managed App Hosting does **not** receive the Spark URL or an L2 credential.
Spark is private-LAN infrastructure, and `apps/console/apphosting.yaml` has no
remote-cache variables or secrets. Do not add either merely to accelerate a
managed build: L2 is optional, and introducing a new production credential or
network path requires its own approved design. CI proves the production cache
contract using local L1 with remote reads disabled.

## How a checkout gets configured

`tools/setup-nx-remote-cache.sh` writes the gitignored `.nx-remote-cache.env`
in the **primary checkout**, holding the server URL and the access token. The
credential is deliberately kept out of `.env.local` so that only `tools/nx`
consumes it, and only after a fast reachability probe — Nx fails open on an
unreachable server but pays roughly 45s of request timeouts per task write,
which would punish a laptop off the VPN.

The token is resolved from two sources, in order:

1. **The encrypted age secret store** (`secrets-cat`, key
   `NX_CACHE_TOKEN_SPARK`). Covers the maintainer's home directory on any fleet
   host, with no cloud login.
2. **This repo's own GCP project** (`nx-cache-access-token` in `agent-lcars`).
   Covers runs that do not happen in that home directory — CI containers,
   self-hosted runners, and any host with workload identity but no age key.

The project is always passed explicitly and never inherited from
`gcloud config`. An ambient default belongs to whatever the developer last
worked on, so a bare `gcloud secrets access` would quietly read the wrong
project.

### A source must authenticate, not merely exist

Resolution takes the first source whose token the server actually accepts, not
the first that returns a non-empty string. This matters because Nx fails
**open** on a rejected token: every cache request 403s and the build silently
falls back to local recomputation, with no error surfaced anywhere. A stale
value in an earlier source would otherwise mask a working value in a later
one, and the only symptom would be builds that are mysteriously slow.

The probe is a `GET` for an absent hash — `404` means the bearer token was
accepted, `403` means refused. Any other status is treated as inconclusive and
the token is used, leaving the run-time decision to `tools/nx`.

Pass `--force` to rewrite an existing file; that is the rotation path.

## Worktrees

Linked worktrees do not inherit ignored files, and a worktree created by a bare
`git worktree add` never runs `tools/setup-worktree.sh`. Rather than copy the
credential into each worktree, `tools/nx` reads through to the primary
checkout's `.nx-remote-cache.env` when the worktree has none.

That keeps exactly one credential on disk and makes a rotation in the primary
reach every worktree immediately. A per-worktree copy would reintroduce the
stale-copy problem: an old file would win over the freshly rotated primary, and
you would be back to silent 403s.

`tools/setup-worktree.sh` therefore does **not** copy this file. That omission
is intentional.

## Verifying

Confirm the server is up and the local credential is accepted:

```bash
set -a; . ./.nx-remote-cache.env; set +a
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN" \
  "$NX_SELF_HOSTED_REMOTE_CACHE_SERVER/v1/cache/authprobe000000000000000000000"
```

`404` means authenticated (the hash legitimately does not exist). `403` means
the token was refused — re-run `tools/setup-nx-remote-cache.sh --force`.

The server keeps two distinct tokens: a write token and a read-only token that
receives `403` on `PUT` while retaining reads. Both return `404` on the probe
above, so the probe proves authentication but not publish rights. A checkout
holding the read-only token will pull from L2 and never populate it.

## CI and E2E

CI gives the write capability to same-repository PRs as well as protected
branch, merge-queue, and manual runs. Contributors opening those PRs already
have repository write access, and PRs are the predominant cache workload; a
read-only policy there would prevent most useful cache warming. Fork PRs are
routed off the private network and receive neither cache variable.

The E2E targets are explicitly `cache: false`, so a prior green test run can
never be replayed while Nx still restores cached deterministic dependency
artifacts. Its hermetic environment forwards only the complete L2
server/token pair to cache the separate console bundle that the suite builds
as a dependency. No broader CI credential crosses that boundary.
