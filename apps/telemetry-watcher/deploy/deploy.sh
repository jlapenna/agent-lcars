#!/usr/bin/env bash
# Deploy (or redeploy) agent-lcars-telemetry-watcher on a personal-login host.
#
# Converted from jlapenna/homelab's
# ansible/deploy_agent_lcars_telemetry_watcher.yml when the deployment
# config moved into this repo (homelab#218 Phase 6). See docker-compose.yml
# in this same directory for the full design rationale (why the watched uid, why
# pid: host + apparmor=unconfined, why the allowlists are pinned
# explicitly) and deploy/README.md for how secrets reach watcher hosts.
#
# Preserves the operational lessons the original playbook encoded
# (jlapenna/homelab#204, docs/incidents.md 2026-07-29 in that repo):
#   - the writer key must exist and be owned by the watched uid/gid -- the
#     CONTAINER reads it as that identity, not as the user running this script.
#   - when an optional .env exists, it must be readable by the identity that
#     actually runs `docker compose` -- this script asserts against its OWN
#     invoking identity, since it no longer runs through Ansible's
#     become/delegate_to indirection (the original incident was a
#     controller-vs-remote-CLI identity mismatch that indirection created).
#   - a successful `docker compose up` only means the API calls succeeded,
#     not that the process inside is working: verify the container is
#     still running and hasn't restarted (or is reporting healthy, when a
#     HEALTHCHECK is defined) before declaring success.
#
# Usage: run directly on a watcher host as the deployment identity (normally
# the `homelab` service account, with sudo available for ownership fixups):
#   ./deploy.sh
set -euo pipefail

DEPLOY_DIR="${AGENT_TELEMETRY_DEPLOY_DIR:-${HOME}/agent-lcars-telemetry-watcher}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRITER_KEY="$DEPLOY_DIR/writer-key.json"
ENV_FILE="$DEPLOY_DIR/.env"
CONTAINER_NAME=agent-lcars-telemetry-watcher
# Upper bound on the wait for a Docker HEALTHCHECK to report healthy. This is
# a ceiling, not a delay: the loop below breaks the moment the container is
# healthy, so a generous value costs nothing on a good deploy and only delays
# the report of a genuinely broken one.
#
# 90s was too tight and produced a false failure on a real deploy: the
# container reported healthy moments after the script had already given up,
# with 0 restarts, and stayed healthy. The compose HEALTHCHECK alone
# (start_period 15s, interval 15s, retries 4) needs ~75s just to declare
# itself unhealthy, so 90 left ~15s of slack -- and time-to-FIRST-SUCCESS on
# a cold start is not bounded by that config at all. It depends on how long
# the process takes to serve /metrics, which means loading firebase-admin's
# gRPC stack and finishing a first tick that scans every watched transcript
# root. Under that load a 5s probe can lapse several times before the event
# loop is free to answer one.
#
# A false failure is worse than a slow one. It trains whoever runs this to
# ignore the gate -- the exact signal the gate exists to provide -- and it
# fails any automation that trusts the exit code. 240s is ~3x the
# healthcheck's own unhealthy threshold, and was chosen over the 180s that
# happened to pass on two hosts because "the value that worked the one time
# we measured" is not headroom.
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-240}"
# Fixed settling window for the no-HEALTHCHECK fallback below. Deliberately a
# SEPARATE knob from the ceiling above, because this one is a `sleep` that is
# paid in full on every deploy rather than an upper bound that exits early.
# Folding both onto one variable is what made the ceiling unraisable: any
# value big enough to stop the false failure would have added that many
# seconds to every no-healthcheck deploy.
STABILITY_WINDOW_SECONDS="${STABILITY_WINDOW_SECONDS:-90}"
WATCHER_USER="${AGENT_TELEMETRY_WATCHER_USER:-jlapenna}"
watcher_passwd="$(getent passwd "$WATCHER_USER" || true)"

if [ -z "$watcher_passwd" ]; then
  echo "Cannot resolve watcher account $WATCHER_USER" >&2
  exit 1
fi

WATCHER_UID="$(cut -d: -f3 <<<"$watcher_passwd")"
WATCHER_GID="$(cut -d: -f4 <<<"$watcher_passwd")"
WATCHER_HOME="$(cut -d: -f6 <<<"$watcher_passwd")"
WATCHER_HOST="${AGENT_TELEMETRY_HOST:-$(hostname -s)}"
WATCHER_CHECKOUT_ROOTS="${AGENT_TELEMETRY_CHECKOUT_ROOTS:-$WATCHER_HOME/p/sprinkles,$WATCHER_HOME/p/agent-lcars,$WATCHER_HOME/p/homelab}"

if [[ -z "$WATCHER_HOME" || "$WATCHER_HOME" != /* ]]; then
  echo "Cannot derive an absolute home directory for watcher account $WATCHER_USER" >&2
  exit 1
fi
if [ -z "$WATCHER_HOST" ] || [ -z "$WATCHER_CHECKOUT_ROOTS" ]; then
  echo "Watcher host and checkout roots must be non-empty" >&2
  exit 1
fi

# The compose stack mounts WATCHER_HOME/p at its real absolute path. Keep
# every configurable checkout root inside that mounted tree so git metadata
# lookups cannot silently lose access to an accepted root. Normalize first so
# paths containing `..` cannot escape the mount after this check.
watcher_checkout_mount="$(realpath -m -- "$WATCHER_HOME/p")"
IFS=',' read -r -a requested_checkout_roots <<<"$WATCHER_CHECKOUT_ROOTS"
normalized_checkout_roots=()
for checkout_root in "${requested_checkout_roots[@]}"; do
  if [[ -z "$checkout_root" || "$checkout_root" != /* ]]; then
    echo "Watcher checkout roots must be non-empty absolute paths" >&2
    exit 1
  fi
  normalized_checkout_root="$(realpath -m -- "$checkout_root")"
  if [[ "$normalized_checkout_root" != "$watcher_checkout_mount" &&
    "$normalized_checkout_root" != "$watcher_checkout_mount/"* ]]; then
    echo "$checkout_root resolves outside $watcher_checkout_mount, the checkout tree mounted into the watcher" >&2
    exit 1
  fi
  normalized_checkout_roots+=("$normalized_checkout_root")
done
WATCHER_CHECKOUT_ROOTS="$(IFS=,; printf '%s' "${normalized_checkout_roots[*]}")"
export DEPLOY_DIR WATCHER_UID WATCHER_GID WATCHER_HOME WATCHER_HOST WATCHER_CHECKOUT_ROOTS

mkdir -p "$DEPLOY_DIR"

# Docker bind mounts create missing source paths as root. Seed every watched
# directory as the account that owns the transcripts before Compose sees it.
ensure_watcher_dir() {
  local path="$1"
  local mode="$2"
  if [ ! -d "$path" ]; then
    # Run the creation itself as the watcher account. `install -o/-g` only
    # applies ownership to the final component and otherwise leaves newly
    # created parents root-owned, which prevents the CLI from writing its
    # own adjacent config/state files later.
    sudo -u "$WATCHER_USER" install -d -m "$mode" "$path"
  fi
  if ! sudo -u "$WATCHER_USER" test -r "$path" ||
    ! sudo -u "$WATCHER_USER" test -x "$path"; then
    echo "$path is not readable and traversable by $WATCHER_USER" >&2
    exit 1
  fi
}

ensure_watcher_dir "$WATCHER_HOME/.claude/projects" 0700
ensure_watcher_dir "$WATCHER_HOME/.codex/sessions" 0700
ensure_watcher_dir "$WATCHER_HOME/p" 0755
ensure_watcher_dir "$WATCHER_HOME/share" 0755
ensure_watcher_dir "$WATCHER_HOME/.gemini/antigravity-cli" 0700
# Session-title overlay state (issue #1212): `session-metadata/` holds
# declared titles written by the agent-side `lcars session title` CLI, and
# `native-titles/` holds the host-side importer's Codex title snapshots (see
# the systemd/ unit in this directory). Neither writer runs before this
# script on a fresh host, so without this the first `docker compose up`
# below would create the top-level `agent-lcars` directory root-owned via
# the bind mount -- same failure mode the comment on ensure_watcher_dir
# above describes for the other watched roots, just for a directory nothing
# else has touched yet.
ensure_watcher_dir "$WATCHER_HOME/.local/state/agent-lcars/session-metadata" 0700
ensure_watcher_dir "$WATCHER_HOME/.local/state/agent-lcars/native-titles" 0700

# --- writer-key.json: must exist; the CONTAINER reads it as jlapenna -------
if [ ! -f "$WRITER_KEY" ]; then
  cat >&2 <<EOF
$WRITER_KEY must exist.

Preferred: add agent_lcars_writer_key_json to jlapenna/homelab's encrypted
ansible/secrets.yml (via ./bin/manage-secrets.sh there), then run
deploy_secrets.yml followed by sync_agent_lcars_writer_key.yml -- see
deploy/README.md's "Secrets" section for the full pipeline.

Fallback (hand-placed, never committed -- same convention as homelab's
github-runner RUNNER_TOKEN .env):
  gcloud secrets versions access latest --project=agent-lcars \\
    --secret=AGENT_TELEMETRY_WRITER_KEY_JSON > "$WRITER_KEY"
  chmod 600 "$WRITER_KEY"
EOF
  exit 1
fi
sudo chown "$WATCHER_UID:$WATCHER_GID" "$WRITER_KEY"
sudo chmod 0600 "$WRITER_KEY"

# --- .env: optional host-specific overrides ---------------------------------
compose_env_args=()
if [ -f "$ENV_FILE" ] && [ ! -r "$ENV_FILE" ]; then
  echo "$ENV_FILE exists but is not readable by $(id -un) -- fix its ownership/mode before deploying." >&2
  exit 1
fi
if [ -f "$ENV_FILE" ]; then
  compose_env_args=(--env-file "$ENV_FILE")
fi

# --- sync the compose file and bring the stack up ---------------------------
cp "$SCRIPT_DIR/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
cd "$DEPLOY_DIR"

docker compose "${compose_env_args[@]}" pull
docker compose "${compose_env_args[@]}" up -d --remove-orphans

# Baseline restart count / health status AFTER `up`, not before: a changed
# image pin or config recreates the container (docker compose's own
# behavior), which resets RestartCount to 0 on the NEW container -- baselining
# against the OLD container would compare across that reset and either false-
# positive-fail a healthy fresh container, or (for a container's first-ever
# HEALTHCHECK) wrongly take the no-health branch below. Baselining here,
# right after `up`, always reflects whichever container is actually running
# now; the checks below only care about restarts/health *during this script's
# own wait window*, not the container's full lifetime.
baseline="$(docker inspect --format '{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_NAME")"
baseline_restarts="${baseline%%|*}"
baseline_health="${baseline#*|}"

# --- post-deploy health gate -------------------------------------------------
# "docker compose up" exiting 0 only means the API calls succeeded, not that
# the service inside is working (a container can report "Up" for 25 hours
# while crash-looping 26 times inside it -- verify, don't trust `docker ps`).
if [ -n "$baseline_health" ]; then
  echo "Waiting for $CONTAINER_NAME to report healthy..."
  deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  status=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_NAME")"
    [ "$status" = healthy ] && break
    sleep 5
  done
  if [ "$status" != healthy ]; then
    echo "$CONTAINER_NAME did not report healthy within ${HEALTH_TIMEOUT_SECONDS}s (last status: ${status:-unknown})" >&2
    exit 1
  fi
else
  # No Docker HEALTHCHECK today -- fall back to a stability window: assert
  # the container is still running and its restart count hasn't moved.
  echo "No HEALTHCHECK defined; waiting ${STABILITY_WINDOW_SECONDS}s to confirm stability..."
  sleep "$STABILITY_WINDOW_SECONDS"
  current="$(docker inspect --format '{{.RestartCount}}|{{.State.Running}}' "$CONTAINER_NAME")"
  current_restarts="${current%%|*}"
  current_running="${current#*|}"
  if [ "$current_restarts" != "$baseline_restarts" ] || [ "$current_running" != true ]; then
    echo "$CONTAINER_NAME is not stable after deploy (restarts: $baseline_restarts -> $current_restarts, running=$current_running)" >&2
    exit 1
  fi
fi

# The compose file tracks `latest` rather than pinning a digest (see its own
# comment for why). That trades away a record of what was *intended* to run,
# so record what ACTUALLY ran -- which is the more useful artifact anyway: a
# pin tells you what someone meant to deploy, this tells you what the daemon
# is executing right now.
#
# Read from the running container, not from the compose file or a registry
# lookup: those describe intent and current-latest respectively, and neither
# survives `latest` moving underneath a container that started earlier.
deployed_digest="$(docker inspect --format '{{index .RepoDigests 0}}' \
  "$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")" 2>/dev/null || true)"
if [ -n "$deployed_digest" ]; then
  echo "$CONTAINER_NAME is running $deployed_digest"
else
  echo "$CONTAINER_NAME digest could not be resolved (image may be local-only)" >&2
fi

echo "$CONTAINER_NAME deployed and stable."
