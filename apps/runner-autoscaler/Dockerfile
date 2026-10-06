# LCARS queue executor for direct-runner work items (runs on homelab).
#
# Standard Go module build. Every GitHub Actions runner lane has migrated
# onto Actions Runner Controller (homelab#1623); this binary's only job now
# is the queue executor (queue_*.go, started from runOrchestrator) that
# launches direct-runner Kubernetes Jobs for LCARS work items.
# Compile on the native builder platform and cross-compile the static binary
# for each requested target. Letting this stage inherit TARGETPLATFORM made
# the arm64 image run the entire Go compiler under QEMU on the amd64 BuildKit
# host, which added roughly 17 minutes to the 2026-08-21 publication.
FROM --platform=$BUILDPLATFORM golang:1.27 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /build
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY *.go ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
      go build -trimpath -o /out/runner-autoscaler .

# debian-slim rather than distroless: the homelab compose entrypoint runs a
# /bin/sh single-controller guard, and its healthcheck shells out to wget.
FROM debian:trixie-slim
# wget: the compose healthcheck (docker-compose.yml) shells out to it to hit
# /healthz -- omitted here originally, so every container reported (unhealthy)
# permanently regardless of real status (confirmed live: all control planes
# stuck unhealthy despite functioning correctly) -- a false signal that makes
# `docker ps`/monitoring unable to distinguish a real outage from noise.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
# The container runs as uid 1001 (docker-compose.yml `user:`, to read the
# vault-deployed key); give that uid a passwd entry and home directory.
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin runner-autoscaler
COPY --from=build /out/runner-autoscaler /usr/local/bin/runner-autoscaler
USER 1001:1001
ENTRYPOINT ["/usr/local/bin/runner-autoscaler"]
