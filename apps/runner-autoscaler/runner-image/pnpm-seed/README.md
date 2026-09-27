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
Every fleet JavaScript consumer (Sprinkles, WWW, GiroSF, Agent LCARS) uses
pnpm 11, so this one `v11` store serves them all; the former pnpm 10
compatibility seed was retired once Sprinkles moved to pnpm 11. The seed is
fetched into its own immutable final-image layer and never comes from a
consumer's source or build context. Refresh no more than monthly, or when
measured hit coverage falls below 70%; keep lockfile updates independent from
consumer dependency updates.

Before publishing a refreshed runner image, record the compressed
seed-layer size for both `linux/amd64` and `linux/arm64`. The pilot budget is
at most 1.5 GiB of additional compressed image data per architecture. The
Dockerfile deliberately leaves the seed stage target-platform native, so
native packages such as SWC, esbuild, and sharp are fetched for the image
architecture being built.
