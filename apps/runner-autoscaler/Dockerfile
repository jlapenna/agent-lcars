# Autoscaler control plane for GitHub Actions runners (runs on homelab).
#
# Standard Go module build. Depends on the actions/scaleset *library* pinned
# in go.mod (a normal `require`) — NOT a fork/overlay of its example. The Go
# source here was seeded from that example's `dockerscaleset` template and is
# now a single multi-scale-set orchestrator with fleet-wide placement.
FROM golang:1.27 AS build
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/runner-autoscaler .

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
# State directory for server.state_path's checkpoint. Created here, owned by
# the runtime uid, specifically so the deployment's named volume inherits that
# ownership when Docker initializes it from the image on first mount -- a
# volume mounted over a path the image does not define comes up root-owned,
# and the process (uid 1001, read_only rootfs) could not write its checkpoint.
# The mount must be a volume, not a container path: the container filesystem
# is destroyed by the very restart the checkpoint exists to make safe.
RUN mkdir -p /var/lib/runner-autoscaler \
 && chown 1001:1001 /var/lib/runner-autoscaler
COPY --from=build /out/runner-autoscaler /usr/local/bin/runner-autoscaler
USER 1001:1001
ENTRYPOINT ["/usr/local/bin/runner-autoscaler"]
