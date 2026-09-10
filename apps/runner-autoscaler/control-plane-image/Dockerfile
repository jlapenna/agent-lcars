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
ARG RUNNER_BASE=ghcr.io/actions/actions-runner@sha256:e5496277be5d09bc968b3d64911b74e219ac4a3f2edce956a3ecf9271bea1ef4

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
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh jq; \
    # The Actions runner already carries the Node 24 runtime used to execute
    # JavaScript actions. Expose that supported copy instead of installing a
    # second 239 MB NodeSource package whose runtime dependency keeps Python
    # in an otherwise Python-free control image.
    ln -s /home/runner/externals/node24/bin/node /usr/local/bin/node; \
    ln -s /home/runner/externals/node24/bin/npm /usr/local/bin/npm; \
    ln -s /home/runner/externals/node24/bin/npx /usr/local/bin/npx; \
    ln -s /home/runner/externals/node24/bin/corepack /usr/local/bin/corepack; \
    node --version; \
    npm --version; \
    gh --version; \
    jq --version; \
    # Replace the runner's bundled npm copies' vulnerable node-tar
    # implementations while retaining npm for control-plane agent jobs, which
    # install their CLI into an unprivileged user prefix.
    mkdir -p /tmp/control-plane-tar; \
    npm install --prefix /tmp/control-plane-tar --no-save --ignore-scripts \
      --install-strategy=nested tar@7.5.22; \
    for tar_target in \
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
    # Upstream installs software-properties-common to add its Git PPA, which
    # pulls in Python even though neither the runner nor these control jobs use
    # it. Remove only the installed Python packages and their build-time owner;
    # do not autoremove the runner's broader OS dependency set.
    python_packages="$( \
      { dpkg-query -l 'python3*' 2>/dev/null || true; } \
        | awk '$1 == "ii" { print $2 }' \
    )"; \
    apt-get purge -y software-properties-common ${python_packages}; \
    dpkg -C; \
    rm -rf /var/lib/apt/lists/*

COPY verify-runtime.sh /usr/local/bin/control-plane-verify-runtime
RUN chmod 0755 /usr/local/bin/control-plane-verify-runtime \
    && /usr/local/bin/control-plane-verify-runtime

USER runner
ENTRYPOINT ["/home/runner/run.sh"]
