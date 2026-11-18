# Claw runner: one agent turn per LCARS run attempt, on the ACP harness the
# agent's manifest names: OpenClaw (the default), Claude Code or Codex.
# Spec: docs/superpowers/specs/2026-10-15-unified-work-dataflow-design.md
# ("### `claw`"). Published by Homelab (docs/image-publish-routing.md) and
# pinned by digest in each zone executor's runtime table.
#
# The image carries only the program and generic clients. Agent definitions
# (pinned config, exec approvals, workspace files), agent tools and
# credentials are mounted by the zone deployment, never baked in.
FROM node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0

ARG CACHE_BUST=unset
LABEL org.opencontainers.image.title="claw-runner" \
      org.opencontainers.image.source="https://github.com/jlapenna/agent-lcars"

# openssh-client and python3 serve zone-mounted agent tools (for example
# Homelab's homelab-investigate, which runs typed probes over fixed SSH).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssh-client python3 \
 && rm -rf /var/lib/apt/lists/*

# The verified OpenClaw distribution and ACP harness adapters: exact versions
# and every dependency checked against package-lock.json integrity hashes.
# Root-owned and never writable by the runtime UID, so nothing staged at
# runtime can replace them. The adapter paths are the ones claw-job.mjs
# starts (HARNESSES); a missing one fails the build, not the first run.
WORKDIR /opt/openclaw
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit \
 && npm cache clean --force \
 && node_modules/.bin/openclaw --version \
 && test -f node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js \
 && test -f node_modules/@agentclientprotocol/codex-acp/dist/index.js

COPY claw-job.mjs openclaw-acp.mjs /opt/claw/

# Self-update stays off: the image digest is the only way to change OpenClaw.
ENV OPENCLAW_NO_AUTO_UPDATE=1 \
    OPENCLAW_BIN=/opt/openclaw/node_modules/.bin/openclaw \
    CLAW_SECRETS_DIR=/run/claw-secrets \
    CLAW_WORK_DIR=/work \
    HOME=/work/home

# The zone executor runs claw pods as uid/gid 1001 (the queue Job contract);
# OpenSSH and Python's getpwuid need a passwd entry for that uid.
RUN groupadd --gid 1001 claw \
 && useradd --uid 1001 --gid 1001 --home-dir /work/home --no-create-home \
      --shell /usr/sbin/nologin claw

USER 1001:1001
WORKDIR /work
ENTRYPOINT ["node", "/opt/claw/claw-job.mjs"]
