#!/usr/bin/env bash
# Deploy (or redeploy) agent-lcars-telemetry-watcher on pike.
#
# Converted from jlapenna/homelab's
# ansible/deploy_agent_lcars_telemetry_watcher.yml when the deployment
# config moved into this repo (homelab#218 Phase 6). See docker-compose.yml
# in this same directory for the full design rationale (why uid 1000, why
# pid: host + apparmor=unconfined, why the allowlists are pinned
# explicitly) and deploy/README.md for how secrets reach pike.
#
# Preserves the operational lessons the original playbook encoded
# (jlapenna/homelab#204, docs/incidents.md 2026-07-29 in that repo):
#   - the writer key must exist and be owned 1000:1000 -- that's the uid
#     the CONTAINER reads it as, not the identity running this script.
#   - .env must exist and be readable by the identity that actually runs
#     `docker compose` -- this script asserts against its OWN invoking
#     identity, since it no longer runs through Ansible's
#     become/delegate_to indirection (the original incident was a
#     controller-vs-remote-CLI identity mismatch that indirection created).
#   - a successful `docker compose up` only means the API calls succeeded,
#     not that the process inside is working: verify the container is
#     still running and hasn't restarted (or is reporting healthy, if a
#     HEALTHCHECK is ever added) before declaring success.
#
# Usage: run directly on pike, as the identity that owns
# /home/homelab/agent-lcars-telemetry-watcher (normally the `homelab`
# service account, with sudo available for the ownership fixups below):
#   ./deploy.sh
set -euo pipefail

DEPLOY_DIR=/home/homelab/agent-lcars-telemetry-watcher
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRITER_KEY="$DEPLOY_DIR/writer-key.json"
ENV_FILE="$DEPLOY_DIR/.env"
CONTAINER_NAME=agent-lcars-telemetry-watcher
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-90}"

mkdir -p "$DEPLOY_DIR"

# --- writer-key.json: must exist; the CONTAINER reads it as uid 1000 -------
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
sudo chown 1000:1000 "$WRITER_KEY"
sudo chmod 0600 "$WRITER_KEY"

# --- .env: must exist; never managed by this script -------------------------
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE must exist -- copy .env.example and fill it in." >&2
  exit 1
fi
if [ ! -r "$ENV_FILE" ]; then
  echo "$ENV_FILE exists but is not readable by $(id -un) -- fix its ownership/mode before deploying." >&2
  exit 1
fi

# --- sync the compose file and bring the stack up ---------------------------
cp "$SCRIPT_DIR/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
cd "$DEPLOY_DIR"

docker compose pull
docker compose --env-file "$ENV_FILE" up -d --remove-orphans

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
  echo "No HEALTHCHECK defined; waiting ${HEALTH_TIMEOUT_SECONDS}s to confirm stability..."
  sleep "$HEALTH_TIMEOUT_SECONDS"
  current="$(docker inspect --format '{{.RestartCount}}|{{.State.Running}}' "$CONTAINER_NAME")"
  current_restarts="${current%%|*}"
  current_running="${current#*|}"
  if [ "$current_restarts" != "$baseline_restarts" ] || [ "$current_running" != true ]; then
    echo "$CONTAINER_NAME is not stable after deploy (restarts: $baseline_restarts -> $current_restarts, running=$current_running)" >&2
    exit 1
  fi
fi

echo "$CONTAINER_NAME deployed and stable."
