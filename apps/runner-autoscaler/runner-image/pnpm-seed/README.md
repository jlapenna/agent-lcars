# Curated runner pnpm-store seed

This is a deliberately small, standalone dependency manifest for the generic
ephemeral runner image. It is not a consumer lockfile and must never import,
checkout, or otherwise derive from another repository.

The Dockerfile fetches this exact lockfile into the `runner` user's normal
pnpm content-addressable store in a dedicated image layer. Jobs keep their
own writable container layer: matching packages are read from the immutable
seed, while misses are fetched into that private layer in the normal way.

Keep this list to broadly useful JavaScript tooling families: Nx, TypeScript,
SWC/esbuild, React/Next/sharp, ESLint/Prettier, Vitest/Testing Library,
Firebase/Google clients, and Playwright's package code (not browsers). Do
not add application-only packages, `node_modules`, postinstall output,
emulator downloads, browser payloads, credentials, or a whole consumer
lockfile.

`package.json` must match Agent LCARS's root `packageManager` declaration.
`pnpm10/package.json` is the separately versioned compatibility seed for the
representative Sprinkles workload, whose pnpm 10 store layout is `v10` and
therefore cannot reuse Agent LCARS's `v11` content. Both manifests carry the
same curated package set and are fetched into their own immutable final-image
layer; neither comes from Sprinkles source or its build context. Refresh no
more than monthly, or when measured hit coverage falls below 70%; keep
lockfile updates independent from consumer dependency updates.

Before publishing a refreshed runner image, record the combined compressed
seed-layer size for both `linux/amd64` and `linux/arm64`. The pilot budget is
at most 1.5 GiB of additional compressed image data per architecture. The
Dockerfile deliberately leaves both seed stages target-platform native, so
native packages such as SWC, esbuild, and sharp are fetched for the image
architecture being built.
