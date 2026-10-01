# A small, container-only proof for the same store layering the production
# runner image uses. It intentionally seeds TypeScript only: the content hit
# must come from a lower image layer, while is-number is an ordinary miss.
FROM node:24-slim AS pnpm-store-seed

WORKDIR /seed
RUN corepack enable
COPY pnpm-seed-regression/seed/package.json package.json
COPY pnpm-seed-regression/seed/pnpm-lock.yaml pnpm-lock.yaml
RUN pnpm fetch --frozen-lockfile --ignore-scripts --store-dir /pnpm-store

FROM node:24-slim

RUN useradd --create-home --uid 1001 runner && corepack enable
COPY --from=pnpm-store-seed --chown=runner:runner /pnpm-store/ /home/runner/.local/share/pnpm/store/
COPY --chown=runner:runner pnpm-seed-regression/hit /opt/pnpm-hit
COPY --chown=runner:runner pnpm-seed-regression/miss /opt/pnpm-miss
USER runner

# Mirror the production Dockerfile's pin: without it, a project installed
# from a separate filesystem (as pnpm-store-seed.test.sh's work-mount case
# simulates) makes pnpm pick a fresh default store on that other
# filesystem instead of this seeded one.
RUN install -d -m 0755 /home/runner/.config/pnpm && \
    printf 'storeDir: /home/runner/.local/share/pnpm/store\ncacheDir: /home/runner/.cache/pnpm\n' \
      > /home/runner/.config/pnpm/config.yaml

# Warm the runner user's Corepack cache while resolving the exact version from
# the test manifest. The runtime assertion can then measure package-content
# reuse without a package-manager download affecting it.
WORKDIR /opt/pnpm-hit
RUN pnpm --version
