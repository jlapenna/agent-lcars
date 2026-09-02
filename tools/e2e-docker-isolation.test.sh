#!/usr/bin/env bash
# Dockerless regression tests for tools/e2e-docker.sh (#908 reconciliation
# with sprinkles' tools/e2e-docker.sh). E2E_DOCKER_DRY_RUN=1 makes the
# wrapper print the derived image tag, the install.stamp decision, and the
# `docker run` argv instead of doing anything, so these tests exercise it
# directly against the real repo checkout -- no fixture, no fake
# `docker`/`git`/`pnpm` binaries, no Docker daemon required.
#
# The run.lock (flock) behavior is likewise not exercised here: dry-run
# skips taking the lock entirely (see the wrapper), specifically so this
# test doesn't need a background-process timing dance to prove mutual
# exclusion. That is instead demonstrated against the real script as part of
# #908's PR evidence (two real concurrent invocations, one waiting on the
# other's lock) -- see the PR description.
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
SCRIPT="$REPO/tools/e2e-docker.sh"
PROJECT="@agent-lcars/console-e2e"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEST_DIR"' EXIT

run_dry() {
  E2E_DOCKER_DRY_RUN=1 E2E_DOCKER_CACHE_DIR="$TEST_DIR/cache" "$SCRIPT" "$@"
}

# -- unknown-arg refusal (exit 2) --------------------------------------------
set +e
run_dry "$PROJECT" --bogus >"$TEST_DIR/unknown-arg.log" 2>&1
unknown_status=$?
set -e
[ "$unknown_status" -eq 2 ]
grep -q 'unknown arg: --bogus' "$TEST_DIR/unknown-arg.log"

# -- image tag derivation matches canonical publisher's derivation ----------
# Must stay in lockstep with homelab's publish-agent-lcars-images.sh and with
# the sha256sum invocation this asserts against -- both hash tools/e2e/Dockerfile
# the same way.
expected_tag="df-$(sha256sum "$REPO/tools/e2e/Dockerfile" | cut -c1-12)"
run_dry "$PROJECT" >"$TEST_DIR/default.log" 2>&1
grep -qF "e2e-registry.invalid/agent-lcars/e2e:${expected_tag}" "$TEST_DIR/default.log"

# -- E2E_DOCKER_REGISTRY overrides just the registry host, keeping the
# derived tag -------------------------------------------------------------
E2E_DOCKER_REGISTRY=some-other-registry E2E_DOCKER_DRY_RUN=1 \
  E2E_DOCKER_CACHE_DIR="$TEST_DIR/cache" "$SCRIPT" "$PROJECT" \
  >"$TEST_DIR/registry-override.log" 2>&1
grep -qF "some-other-registry/agent-lcars/e2e:${expected_tag}" "$TEST_DIR/registry-override.log"

# -- baseline dry run: required mounts/flags, and the stamp-miss path -------
# A fresh E2E_DOCKER_CACHE_DIR has no install.stamp, so this must be a miss:
# the inner command installs first, then writes the stamp, then runs nx.
grep -qx -- 'docker' "$TEST_DIR/default.log"
grep -qx -- '--ipc=host' "$TEST_DIR/default.log"
grep -qx -- '--memory=12g' "$TEST_DIR/default.log"
grep -qx -- '--memory-swap=14g' "$TEST_DIR/default.log"
grep -qx -- '--pids-limit=8192' "$TEST_DIR/default.log"
grep -qF "$REPO:/work" "$TEST_DIR/default.log"
grep -qF "/node_modules:/work/node_modules" "$TEST_DIR/default.log"
grep -qF ":/e2e-cache" "$TEST_DIR/default.log"
grep -qx -- 'CI=1' "$TEST_DIR/default.log"
grep -q 'install.stamp miss' "$TEST_DIR/default.log"
grep -q "inner command:.*pnpm install --frozen-lockfile.*&&.*install.stamp.*&&.*nx run ${PROJECT}:e2e-implementation" "$TEST_DIR/default.log"

# -- install.stamp hit: pre-seed a matching stamp + a populated node_modules
# cache, and confirm the inner command skips `pnpm install` entirely --------
stamp="$(E2E_DOCKER_PRINT_STAMP=1 E2E_DOCKER_CACHE_DIR="$TEST_DIR/cache-hit" "$SCRIPT" "$PROJECT")"
mkdir -p "$TEST_DIR/cache-hit/node_modules/.pnpm"
printf '%s' "$stamp" >"$TEST_DIR/cache-hit/install.stamp"
E2E_DOCKER_DRY_RUN=1 E2E_DOCKER_CACHE_DIR="$TEST_DIR/cache-hit" "$SCRIPT" "$PROJECT" >"$TEST_DIR/hit.log" 2>&1
# The status line legitimately says "skipping pnpm install" -- assert on the
# INNER COMMAND specifically (what the container actually runs), not the
# whole log, so that message can't make this assertion pass for the wrong
# reason.
grep -q 'install.stamp hit' "$TEST_DIR/hit.log"
grep -qx -- './tools/nx run @agent-lcars/console-e2e:e2e-implementation' "$TEST_DIR/hit.log"
grep -q "inner command: ./tools/nx run ${PROJECT}:e2e-implementation\$" "$TEST_DIR/hit.log"

# -- install.stamp invalidates when the stamp on disk doesn't match, even
# with a populated node_modules cache (e.g. the lockfile changed since) -----
printf 'stale-stamp-does-not-match' >"$TEST_DIR/cache-hit/install.stamp"
E2E_DOCKER_DRY_RUN=1 E2E_DOCKER_CACHE_DIR="$TEST_DIR/cache-hit" "$SCRIPT" "$PROJECT" >"$TEST_DIR/stale.log" 2>&1
grep -q 'install.stamp miss' "$TEST_DIR/stale.log"
grep -q 'pnpm install --frozen-lockfile' "$TEST_DIR/stale.log"

# -- E2E_DOCKER_PRINT_STAMP is a pure function of the checkout content plus
# the image tag: same inputs, same stamp, independent of E2E_DOCKER_CACHE_DIR
first_stamp="$(E2E_DOCKER_PRINT_STAMP=1 E2E_DOCKER_CACHE_DIR="$TEST_DIR/a" "$SCRIPT" "$PROJECT")"
second_stamp="$(E2E_DOCKER_PRINT_STAMP=1 E2E_DOCKER_CACHE_DIR="$TEST_DIR/b" "$SCRIPT" "$PROJECT")"
[ "$first_stamp" = "$second_stamp" ]

# -- E2E_DOCKER_IMAGE overrides the resolved image, and the stamp MUST follow
# it even though E2E_TAG (derived only from tools/e2e/Dockerfile) is
# unchanged -- otherwise a stamp hit computed under one override would reuse
# node_modules installed under a DIFFERENT image's runtime/system libraries
# after switching to another override (Codex review, PR #924).
default_stamp="$(E2E_DOCKER_PRINT_STAMP=1 E2E_DOCKER_CACHE_DIR="$TEST_DIR/c" "$SCRIPT" "$PROJECT")"
override_stamp="$(E2E_DOCKER_PRINT_STAMP=1 E2E_DOCKER_IMAGE=some-other-registry/e2e:latest E2E_DOCKER_CACHE_DIR="$TEST_DIR/c" "$SCRIPT" "$PROJECT")"
[ "$default_stamp" != "$override_stamp" ]

echo "e2e-docker-isolation: PASS"
