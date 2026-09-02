# Small, socketless image for the fleet control plane.
#
# Control-plane jobs only need the Actions runner, git/checkout, Node for the
# local JavaScript broker action, and gh/jq for the few shell-based routers. They
# do not need Docker, Buildx, Python, pnpm, the telemetry sidecar, or the
# developer toolchain baked into homelab-runner:jit-node24.
# Defaults to the upstream project's registry so a plain `docker build`
# resolves from any network; a fleet publish overrides this with
# `--build-arg RUNNER_BASE=...` to build from the pre-pulled private-registry
# mirror instead (issue #1729). See runner-image/Dockerfile and
# docs/image-publish-routing.md for the rationale and the homelab mirror
# example -- this ARG is kept in lockstep with that one's digest.
ARG RUNNER_BASE=ghcr.io/actions/actions-runner@sha256:0cfdcc701ce933c6d243c6b0b2da767366dc9f2e99961d4c3754b0b78084cdda

FROM ${RUNNER_BASE}

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The upstream runner image bundles a Docker engine even though this
# socketless control-plane image deliberately has no Docker workload. Remove
# the daemon and its containerd payload rather than carrying a fixed critical
# gRPC vulnerability in an unused component.
RUN rm -f \
    /usr/bin/containerd \
    /usr/bin/containerd-shim-runc-v2 \
    /usr/bin/ctr \
    /usr/bin/docker \
    /usr/bin/docker-init \
    /usr/bin/docker-proxy \
    /usr/bin/dockerd \
    /usr/local/lib/docker/cli-plugins/docker-buildx

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg git; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs gh jq; \
    node --version; \
    gh --version; \
    jq --version; \
    # The runner base carries three npm copies. Replace their vulnerable
    # node-tar implementations while retaining npm for control-plane agent
    # jobs, which install their CLI into an unprivileged user prefix.
    mkdir -p /tmp/control-plane-tar; \
    npm install --prefix /tmp/control-plane-tar --no-save --ignore-scripts \
      --install-strategy=nested tar@7.5.22; \
    for tar_target in \
      /usr/lib/node_modules/npm/node_modules/tar \
      /home/runner/externals/node24/lib/node_modules/npm/node_modules/tar \
      /home/runner/externals/node20/lib/node_modules/npm/node_modules/tar; do \
      rm -rf "${tar_target}"; \
      mkdir -p "${tar_target}"; \
      cp -a /tmp/control-plane-tar/node_modules/tar/. "${tar_target}"; \
      test "$(node -p "require(process.argv[1]).version" "${tar_target}/package.json")" = 7.5.22; \
    done; \
    rm -rf /tmp/control-plane-tar; \
    # The Actions runner base also carries a Docker runtime. Control-plane
    # jobs are deliberately socketless and never invoke Docker, so retaining
    # those binaries only adds an unneeded privilege-shaped attack surface.
    # In particular, the bundled containerd can otherwise carry vulnerabilities
    # unrelated to this image's runner, git, Node, and gh contract.
    rm -f /usr/bin/docker /usr/bin/dockerd /usr/bin/docker-proxy \
      /usr/bin/containerd /usr/bin/containerd-shim-runc-v2 /usr/bin/ctr \
      /usr/bin/runc; \
    test ! -e /usr/bin/docker; \
    test ! -e /usr/bin/dockerd; \
    test ! -e /usr/bin/containerd; \
    test ! -e /usr/bin/containerd-shim-runc-v2; \
    test ! -e /usr/bin/ctr; \
    test ! -e /usr/bin/runc; \
    rm -rf /var/lib/apt/lists/*

USER runner
ENTRYPOINT ["/home/runner/run.sh"]
