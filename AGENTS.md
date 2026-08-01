# Agent LCARS contributor notes

Keep this repository independent from the supersprinklesracing source tree.
Shared telemetry integration is delivered by baking
`apps/telemetry-watcher`'s bundle into the shared runner image at
image-build time, built fresh from this repo's own `main`
(`apps/runner-autoscaler/runner-image/Dockerfile` — see issue #30); this
replaced an earlier versioned-standalone-bundle-on-GCS scheme (issue #29,
retired for good in #66) whose published pin went stale for months. Do
not add cross-repository _source_ imports or build contexts elsewhere —
this one image-build integration point is the sanctioned exception, not a
precedent for others.

Never commit credentials. Runtime secrets belong in GCP Secret Manager and the
host writer credential belongs in the encrypted homelab secret store. Terraform
owns secret containers but not secret values.

## Checkout safety

The primary checkout is shared state and is reserved for a clean `main`.
All implementation work — by people and agents alike — must happen in a
dedicated feature worktree. Before editing files or running a git-mutating
command (`branch`, `commit`, `push`, `checkout`, `stash`, `reset`, or a merge),
create one from the current remote base:

```bash
git fetch origin
git worktree add ../agent-lcars-<task> -b <branch> origin/main
cd ../agent-lcars-<task>
./tools/setup-worktree.sh
```

Apart from fetching, creating a worktree, and a fast-forward-only
synchronization of its clean `main` after a merge, only read-only inspection is
allowed in the primary checkout. Never switch the primary checkout to a feature
branch, and never use `--no-verify` to bypass commit or push hooks.

The hooks reject commits and pushes from `main` and from the primary checkout;
the policy above prevents edits from accumulating there in the first place.

Before publishing, run the affected Nx test, typecheck, and build targets.

After merging and safely removing the feature worktree, sync the primary
checkout to the latest remote base with a fast-forward-only pull. First confirm
that the primary checkout is clean, on the base branch, and not being used by
another session. If it is unsafe to update, fetch the remote and explicitly
report that the checkout remains behind and why; never stash, reset, switch
branches, or force the update.
