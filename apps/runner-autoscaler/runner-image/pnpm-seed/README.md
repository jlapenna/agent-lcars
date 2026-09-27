# Runner pnpm-store seed

The generic ephemeral runner image carries a pnpm content store seeded with
the union of every fleet JavaScript repository's lockfile, so a job's
`pnpm install --frozen-lockfile` reuses image content instead of downloading
it (agent-lcars#2076). Jobs keep their own writable container layer: matching
packages are read from the immutable seed layer, and misses are fetched into
that private layer in the normal way. On runner hosts with overlayfs
`metacopy` (homelab's docker role), a seeded hard link also costs only
metadata rather than a full copy of the file.

`fleet.json` lists the repositories. `fleet/<owner>__<repo>/` holds, as data,
exactly what `pnpm fetch` needs from each at its default-branch head: its
`pnpm-lock.yaml` without the `patchedDependencies` map, a `package.json`
carrying only `packageManager`, and its `supportedArchitectures`. No source,
script, patch, or build context is copied (the store holds unpatched package
content either way; pnpm applies patches when it links); the
Dockerfile's `pnpm-store-seed` stage fetches with `--ignore-scripts`, and the
final image copies only the resulting store.

`tools/sync-runner-pnpm-seed.py` writes `fleet/`, and
`.github/workflows/refresh-runner-pnpm-seed.yml` runs it weekly and opens an
auto-merged bot PR when anything changed. Do not edit `fleet/` by hand.
Every listed repository must use pnpm 11 (the `v11` store layout); the
seed test fails otherwise.

Homelab's canonical publisher measures every `pnpm*-store-content` target
before promotion and refuses a combined compressed seed above 1.5 GiB per
architecture. The seed stage is target-platform native, so native packages
such as SWC, esbuild, and sharp are fetched for the architecture being built.
