# Pinned environment for deterministic Playwright screenshot rendering.
#
# Screenshot baselines are sensitive to the OS font rasterizer (freetype/
# fontconfig) and the exact browser build. Rendering inside this image makes
# local runs match CI byte-for-byte, so a screenshot diff means a real visual
# change rather than environment noise.
#
# The base tag MUST match the @playwright/test version resolved in
# pnpm-lock.yaml, or the bundled browser build won't match. The image tag used
# by tools/e2e-docker.sh and CI is derived from this file's content hash, so
# editing this file automatically invalidates stale images everywhere.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

# The Firebase emulators (auth/firestore/eventarc) used by the e2e target
# require a JRE, which the base Playwright image does not include.
#
# git/git-lfs/gh are only needed when this image runs as a GitHub Actions
# *job container* (e2e.yml's `e2e` job, #NNNN): `actions/checkout` and the
# label-resolution step's `gh pr view` then execute INSIDE this image
# instead of on the runner host, so they need their own git/git-lfs/gh
# rather than borrowing the host's. tools/e2e-docker.sh's local/agent path
# never touches these — it only runs `pnpm exec nx run <project>:e2e`
# against an already-checked-out worktree — but one image serves both.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    default-jre-headless \
    git \
    git-lfs \
    curl \
    gpg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Provide pnpm at the version pinned by the repo's packageManager field.
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate

ENV CI=1
