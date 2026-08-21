#!/usr/bin/env bash
set -euo pipefail

dockerfile="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/Dockerfile"

grep -Fqx 'FROM --platform=$BUILDPLATFORM golang:1.27 AS build' "$dockerfile"
grep -Fqx 'ARG TARGETOS' "$dockerfile"
grep -Fqx 'ARG TARGETARCH' "$dockerfile"
grep -Fq 'CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH"' "$dockerfile"

if grep -Eq '^FROM[[:space:]]+golang:' "$dockerfile"; then
  echo 'control-plane compiler stage follows the target platform' >&2
  exit 1
fi

echo 'control-plane image cross-compiles on the native builder platform'
