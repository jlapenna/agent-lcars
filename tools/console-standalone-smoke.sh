#!/bin/bash
# Verify the deployable Next.js standalone bundle, including request-time
# imports that `next build` alone does not execute.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

shopt -s nullglob
proto_files=(
  dist/apps/console/.next/standalone/node_modules/.pnpm/@google-cloud+tasks@*/node_modules/@google-cloud/tasks/build/protos/protos.json
)
if [ "${#proto_files[@]}" -ne 1 ]; then
  echo "Expected exactly one Cloud Tasks protos.json in the standalone bundle; found ${#proto_files[@]}." >&2
  exit 1
fi

smoke_dir="$(mktemp -d)"
server_pid=''
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$smoke_dir"
}
trap cleanup EXIT

smoke_port="$((43000 + RANDOM % 10000))"
smoke_url="http://127.0.0.1:${smoke_port}"

PORT="$smoke_port" \
HOSTNAME=127.0.0.1 \
AUTH_URL="$smoke_url" \
AUTH_SECRET=standalone-smoke-auth-secret \
AUTH_GITHUB_ID=standalone-smoke-client \
AUTH_GITHUB_SECRET=standalone-smoke-client-secret \
AGENT_LCARS_GITHUB_TOKEN=standalone-smoke-token \
AGENT_LCARS_WEBHOOK_SECRET=standalone-smoke-webhook-secret \
PROJECT_ID=standalone-smoke \
AGENT_LCARS_WEBHOOK_QUEUE_LOCATION=us-central1 \
AGENT_LCARS_WEBHOOK_QUEUE=standalone-smoke \
DISPATCH_FIRESTORE_DATABASE_ID=standalone-smoke \
node dist/apps/console/.next/standalone/apps/console/server.js \
  >"$smoke_dir/server.log" 2>&1 &
server_pid=$!

status=''
for _ in $(seq 1 30); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  status="$(curl --silent --output "$smoke_dir/response.json" \
    --write-out '%{http_code}' \
    --request POST \
    --header 'Content-Type: application/json' \
    --header 'X-GitHub-Event: ping' \
    --header 'X-GitHub-Delivery: 00000000-0000-4000-8000-000000000000' \
    --header 'X-Hub-Signature-256: sha256=invalid' \
    --data '{"zen":"standalone-smoke"}' \
    "$smoke_url/api/control-plane/webhook" || true)"
  if [ "$status" = 401 ]; then
    break
  fi
  sleep 1
done

if [ "$status" != 401 ]; then
  echo "Standalone webhook smoke expected HTTP 401; received ${status:-no response}." >&2
  sed -n '1,120p' "$smoke_dir/server.log" >&2
  exit 1
fi

echo 'Standalone webhook bundle loaded Cloud Tasks and rejected the invalid signature (HTTP 401).'
