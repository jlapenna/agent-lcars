# LCARS queue executor for direct-runner work items (runs on homelab).
#
# Standard Go module build. Every GitHub Actions runner lane has migrated
# onto Actions Runner Controller (homelab#1623); this binary's only job now
# is the queue executor (queue_*.go, started from runOrchestrator) that
# launches direct-runner containers on the fleet's Docker hosts for LCARS
# work items. The custom scale-set runner management this image used to also
# run was retired in homelab#1623 Phase 3.
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

# Runtime needs a real `ssh` client: connhelper (hosts.go's ssh:// targets)
# shells out to the `ssh` binary to proxy each remote host's Docker socket —
# no Docker TCP port is ever opened. That rules out distroless/static (no
# shell, no ssh). debian-slim + openssh-client is the minimal image with one.
FROM debian:trixie-slim
# wget: the compose healthcheck (docker-compose.yml) shells out to it to hit
# /healthz -- omitted here originally, so every container reported (unhealthy)
# permanently regardless of real status (confirmed live: all control planes
# stuck unhealthy despite functioning correctly) -- a false signal that makes
# `docker ps`/monitoring unable to distinguish a real outage from noise.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
# The container runs as uid 1001 (docker-compose.yml `user:`, to read the
# vault-deployed key). openssh-client calls getpwuid() on the LOCAL uid for
# $HOME resolution and fails outright ("No user exists for uid 1001") without
# a matching /etc/passwd entry — unrelated to the remote login (-l) user.
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin runner-autoscaler
COPY --from=build /out/runner-autoscaler /usr/local/bin/runner-autoscaler
USER 1001:1001
ENTRYPOINT ["/usr/local/bin/runner-autoscaler"]
