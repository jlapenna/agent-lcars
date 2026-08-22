# A small, container-only proof for the same store layering the production
# runner image uses. It intentionally seeds TypeScript only: the content hit
# must come from a lower image layer, while is-number is an ordinary miss.
FROM node:24-slim AS pnpm10-store-seed

WORKDIR /seed
RUN corepack enable
COPY pnpm-seed-regression/seed-pnpm10/package.json package.json
COPY pnpm-seed-regression/seed-pnpm10/pnpm-lock.yaml pnpm-lock.yaml
RUN pnpm fetch --frozen-lockfile --ignore-scripts --store-dir /pnpm-store

FROM node:24-slim AS pnpm-store-seed

WORKDIR /seed
RUN corepack enable
COPY pnpm-seed-regression/seed/package.json package.json
COPY pnpm-seed-regression/seed/pnpm-lock.yaml pnpm-lock.yaml
RUN pnpm fetch --frozen-lockfile --ignore-scripts --store-dir /pnpm-store

FROM node:24-slim

RUN useradd --create-home --uid 1001 runner && corepack enable
COPY --from=pnpm10-store-seed --chown=runner:runner /pnpm-store/ /home/runner/.local/share/pnpm/store/
COPY --from=pnpm-store-seed --chown=runner:runner /pnpm-store/ /home/runner/.local/share/pnpm/store/
COPY --chown=runner:runner pnpm-seed-regression/hit /opt/pnpm-hit
COPY --chown=runner:runner pnpm-seed-regression/miss /opt/pnpm-miss
COPY --chown=runner:runner pnpm-seed-regression/hit-pnpm10 /opt/pnpm-hit-pnpm10
COPY --chown=runner:runner pnpm-seed-regression/miss-pnpm10 /opt/pnpm-miss-pnpm10
USER runner

# Warm the runner user's Corepack cache while resolving the exact version from
# the test manifest. The runtime assertion can then measure package-content
# reuse without a package-manager download affecting it.
WORKDIR /opt/pnpm-hit
RUN pnpm --version
WORKDIR /opt/pnpm-hit-pnpm10
RUN pnpm --version
