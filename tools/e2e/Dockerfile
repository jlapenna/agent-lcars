# Pinned environment for deterministic Playwright browser execution.
#
# Keeping the browser build and system dependencies aligned with CI makes
# browser/runtime failures reproducible locally without treating rendered
# pixels as a versioned pass/fail contract.
#
# The base tag MUST match the @playwright/test version resolved in
# pnpm-lock.yaml, or the bundled browser build won't match. The image tag used
# by tools/e2e-docker.sh and CI is derived from this file's content hash, so
# editing this file automatically invalidates stale images everywhere.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# The Firebase emulators (auth/firestore/eventarc) used by the e2e target
# require a JRE, which the base Playwright image does not include. jq is part
# of the fleet-wide runner contract, including lightweight report parsing in
# E2E workflows.
RUN apt-get update \
  && apt-get install -y --no-install-recommends default-jre-headless jq \
  && jq --version \
  && rm -rf /var/lib/apt/lists/*

# This image has no repo checkout at build time (tools/e2e-docker.sh bind-
# mounts one at run time instead), so there's no packageManager field to pre-
# fetch a pinned pnpm version from here. `corepack enable` alone is enough:
# corepack resolves and fetches the right version on first `pnpm` invocation
# against whichever repo ends up mounted, so this never goes stale the way a
# hardcoded `corepack prepare pnpm@X --activate` here would.
RUN corepack enable

# Trigger multi-platform rebuild to support arm64 runners natively
ENV CI=1
