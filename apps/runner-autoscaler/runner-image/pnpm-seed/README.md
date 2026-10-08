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
`pnpm-lock.yaml` without the `patchedDependencies` map or its patch-hash
qualifiers (including dependency references and snapshot identities), a `package.json`
carrying only `packageManager`, and its `supportedArchitectures`. No source,
script, patch, or build context is copied (the store holds unpatched package
content either way; pnpm applies patches when it links); the
Dockerfile's `pnpm-store-seed` stage fetches with `--ignore-scripts`, and the
final image copies only the resulting store.

The image also carries pnpm's registry-metadata cache from the same fetch
(`~/.cache/pnpm/v11/metadata`). pnpm 11 verifies every locked package against
its supply-chain policies on each install and caches the metadata it reads;
without the baked cache each job re-downloaded and re-wrote about 590 MiB of
it (#2082).

Each `fleet/*/package.json` `packageManager` pin is also the image's list of
pnpm releases to serve offline. Fetching makes Corepack download each one; the
image copies that Corepack cache to the runner user, records the pins in
`/usr/local/share/agent-lcars-corepack/fleet-pnpm-pins`, and makes this
repository's own pin the default outside any project
(`COREPACK_DEFAULT_TO_LATEST=0`). `verify-image-invariants.sh` refuses an image
in which any of them needs the registry, so a job whose repository pin matches
the seed starts pnpm without a download.

`tools/sync-runner-pnpm-seed.py` writes `fleet/`, and
`.github/workflows/refresh-runner-pnpm-seed.yml` runs it weekly and opens an
auto-merged bot PR when anything changed. Do not edit `fleet/` by hand.
The sync refuses an empty, non-pnpm-11, or still-patched lockfile before
writing anything, and the required `Runner image pnpm-store seed` check
(`pnpm-store-seed.test.sh`) fetches the committed seed through the
Dockerfile's own `pnpm-store-seed` stage, so a seed the publisher cannot
build fails before merge instead of blocking every later runner-image
publication. The stage carries git because a consumer may lock a git-hosted
package (`type: git`), which pnpm clones.
Every listed repository must use pnpm 11 (the `v11` store layout); the
seed test fails otherwise.

Homelab's canonical publisher measures every `pnpm*-store-content` target
before promotion and refuses a combined compressed seed above 1.5 GiB per
architecture. The seed stage is target-platform native, so native packages
such as SWC, esbuild, and sharp are fetched for the architecture being built.

## Why the store and cache paths are pinned

Copying the seed into `~/.local/share/pnpm/store` and `~/.cache/pnpm` is not
enough on its own: pnpm's _default_ store-dir is chosen on the same
filesystem as the project being installed, so it can hardlink package
content into the project's virtual store. That default broke once a job's
project directory stopped being on the image's own filesystem -- the k3s
runner pods (homelab#1623) mount `/home/runner/_work` as its own volume
(hostPath before, emptyDir now), so a job there silently got a brand-new,
empty store under `_work` and re-downloaded every locked package on every
run, discarding this seed entirely. The retired Docker runners never hit
this: their `_work` lived on the container's own overlay filesystem, same
as the seed.

The Dockerfile fixes this by writing pnpm's own global config file
(`~/.config/pnpm/config.yaml`, not `.npmrc`) with explicit `storeDir`/
`cacheDir` entries, so the paths above are used regardless of which
filesystem a job's project lives on. Neither the `PNPM_STORE_DIR` nor the
`npm_config_store_dir` environment variable changes pnpm 11's resolved
store-dir; this global config file is the mechanism pnpm 11 actually
honors, and it takes precedence over a project's own `.npmrc` `store-dir`,
so no consuming repository's checkout can accidentally un-pin it. When the
store ends up on a different filesystem than the project (as on the k3s
pods), pnpm falls back from hardlinking to copying package content
(`package-import-method=copy`); that is slower per file than a hardlink,
but the content is still `reused`, never re-downloaded, which is the
property that matters. `pnpm-store-seed.test.sh`'s separate-mount case
proves this against a tmpfs standing in for `_work`.

The pin is config baked into the image at `~/.config/pnpm/config.yaml`, keyed
off the runner user's `$HOME`, not an environment variable threaded through a
specific launch path -- so it applies equally to a QueueExecutor direct-runner
session (`direct-runner.sh`, which runs this same image under plain Docker and
never reassigns `$HOME`) and to a k3s ARC pod, with no launcher-specific
handling needed in either.
