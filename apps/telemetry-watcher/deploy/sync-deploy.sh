#!/usr/bin/env bash
# Sync the telemetry-watcher deploy scripts into the deploy directory the
# `homelab` service account owns and can read, so the deploy can be run there
# verbatim on every watcher host (pike, laforge, janeway).
#
# Why this exists (issue #1304): deploy.sh only ever needs docker-compose.yml
# beside it, but the documented invocation assumed running it from the primary
# ~/p/agent-lcars checkout -- which `homelab` cannot read on laforge
# (Permission denied traversing into a jlapenna-owned checkout) and which does
# not exist at all on janeway. This script is the supported "copy the deploy
# files to a homelab-readable location" path: run it from a checkout of this
# repo on the watcher host (normally as the checkout owner, jlapenna) once per
# deploy, and it refreshes DEPLOY_DIR in place. Re-run it after any change to
# these files lands on the checkout's main -- it is idempotent and the
# canonical refresh step, so the copy can never silently go stale.
#
# Only the files deploy.sh needs are synced (deploy.sh, docker-compose.yml, and
# .env.example for reference when creating a host .env). The session-title
# install pieces (install-session-title-cli.sh, systemd/) are deliberately NOT
# synced: they build an Nx target from the checkout and run as the WATCHER_USER
# (jlapenna) account, so they stay checkout-based -- see deploy/README.md.
#
# Usage (from a checkout of this repo on the watcher host):
#   apps/telemetry-watcher/deploy/sync-deploy.sh
#
# DEPLOY_DIR defaults to the homelab account's $HOME/agent-lcars-telemetry-watcher
# and can be overridden with AGENT_TELEMETRY_DEPLOY_DIR (the same override
# deploy.sh honors).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# deploy.sh derives DEPLOY_DIR from ${HOME} because it runs as homelab. This
# script usually runs as the checkout owner (jlapenna), so resolve homelab's
# home explicitly instead of assuming $HOME is the deploy account.
homelab_passwd="$(getent passwd homelab || true)"
if [ -n "$AGENT_TELEMETRY_DEPLOY_DIR" ]; then
  DEPLOY_DIR="$AGENT_TELEMETRY_DEPLOY_DIR"
elif [ -z "$homelab_passwd" ]; then
  echo "Cannot resolve homelab account -- set AGENT_TELEMETRY_DEPLOY_DIR explicitly." >&2
  exit 1
else
  homelab_home="$(cut -d: -f6 <<<"$homelab_passwd")"
  DEPLOY_DIR="$homelab_home/agent-lcars-telemetry-watcher"
fi

mkdir -p "$DEPLOY_DIR"

# deploy.sh must stay executable for the homelab-run invocation below.
install -m 0755 "$SCRIPT_DIR/deploy.sh" "$DEPLOY_DIR/deploy.sh"
install -m 0644 "$SCRIPT_DIR/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
install -m 0644 "$SCRIPT_DIR/.env.example" "$DEPLOY_DIR/.env.example"

echo "Synced deploy files into $DEPLOY_DIR"
echo "Deploy from there as the homelab account:"
echo "  cd $DEPLOY_DIR && ./deploy.sh"
echo "(re-run this script after any change to these files lands on main)"
