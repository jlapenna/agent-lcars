# Pinned environment for deterministic Playwright screenshot rendering.
#
# Screenshot baselines are sensitive to the OS font rasterizer (freetype/
# fontconfig) and the exact browser build. Rendering inside this image makes
# local runs match CI byte-for-byte, so a screenshot diff means a real visual
# change rather than environment noise.
#
# The tag MUST match the @playwright/test version resolved in pnpm-lock.yaml
# (currently 1.60.0). If Playwright is upgraded, bump this tag and the IMAGE tag
# in tools/e2e-docker.sh together, or the bundled browser build won't match.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

# The Firebase emulators (auth/firestore/eventarc) used by the e2e target
# require a JRE, which the base Playwright image does not include.
RUN apt-get update \
  && apt-get install -y --no-install-recommends default-jre-headless \
  && rm -rf /var/lib/apt/lists/*

# Provide pnpm at the version pinned by the repo's packageManager field.
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate

# nx's Go plugin (@naxodev/gonx) shells out to `go` while building the project
# graph, so the toolchain must be present even for the (JS) e2e target. Match
# the version in apps/agent/go.mod.
ENV GO_VERSION=1.26.3
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
  | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"
# Cache Go build/module artifacts in the mounted workspace cache (the container
# runs as the host user, who cannot write to the default /root or /go).
ENV GOPATH=/work/.cache/e2e-docker/go
ENV GOCACHE=/work/.cache/e2e-docker/go-build

ENV CI=1
