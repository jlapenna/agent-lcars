#!/usr/bin/env python3
"""Refresh the runner image's pnpm store seed from the fleet's lockfiles.

The runner image pre-fetches every package the fleet's JavaScript repositories
lock into its pnpm content store (apps/runner-autoscaler/runner-image/
Dockerfile, stage pnpm-store-seed), so a job's `pnpm install` reuses image
content instead of downloading it (agent-lcars#2076). This script copies, as
data, exactly what `pnpm fetch --frozen-lockfile` needs from each repository
listed in pnpm-seed/fleet.json at its default branch head:

  pnpm-lock.yaml       verbatim
  package.json         only name/private/packageManager (corepack version)
  pnpm-workspace.yaml  only patchedDependencies and supportedArchitectures
  <patch files>        the files patchedDependencies names

Nothing else is read: no source, scripts, or build context. Files are fetched
through `gh api` with the raw media type (lockfiles exceed the 1 MB JSON
contents limit). GH_TOKEN_<OWNER> (owner upper-cased, `-` as `_`) is used for
that owner's repositories when set, otherwise GH_TOKEN.

Usage: sync-runner-pnpm-seed.py [--seed-dir DIR]
Prints one `<repository> <commit>` line per synced repository.
"""

from __future__ import annotations

import argparse
import json
import os
import posixpath
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

DEFAULT_SEED_DIR = Path(__file__).resolve().parent.parent / (
    "apps/runner-autoscaler/runner-image/pnpm-seed"
)
WORKSPACE_KEYS = ("patchedDependencies", "supportedArchitectures")


def gh(owner: str, *args: str) -> str:
    env = dict(os.environ)
    token = os.environ.get(f"GH_TOKEN_{owner.upper().replace('-', '_')}")
    if token:
        env["GH_TOKEN"] = token
    return subprocess.run(
        ["gh", "api", *args], check=True, capture_output=True, text=True, env=env
    ).stdout


def raw_file(repo: str, owner: str, path: str, ref: str) -> str | None:
    try:
        return gh(
            owner,
            "-H",
            "Accept: application/vnd.github.raw+json",
            f"repos/{repo}/contents/{path}?ref={ref}",
        )
    except subprocess.CalledProcessError as error:
        if "404" in (error.stderr or ""):
            return None
        raise


def safe_relative(path: str) -> str:
    normalized = posixpath.normpath(path)
    if normalized.startswith(("/", "../")) or normalized in ("..", "."):
        raise ValueError(f"patch path escapes the repository: {path}")
    return normalized


def sync_repository(repo: str, destination: Path) -> str:
    owner = repo.split("/", 1)[0]
    branch = gh(owner, f"repos/{repo}", "--jq", ".default_branch").strip()
    commit = gh(owner, f"repos/{repo}/commits/{branch}", "--jq", ".sha").strip()

    manifest = json.loads(raw_file(repo, owner, "package.json", commit) or "{}")
    package_manager = manifest.get("packageManager", "")
    if not package_manager.startswith("pnpm@"):
        raise ValueError(f"{repo} does not declare a pnpm packageManager")
    lockfile = raw_file(repo, owner, "pnpm-lock.yaml", commit)
    if lockfile is None:
        raise ValueError(f"{repo} has no pnpm-lock.yaml at {commit}")
    workspace = yaml.safe_load(
        raw_file(repo, owner, "pnpm-workspace.yaml", commit) or "{}"
    ) or {}
    seed_workspace = {key: workspace[key] for key in WORKSPACE_KEYS if key in workspace}

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    (destination / "pnpm-lock.yaml").write_text(lockfile)
    (destination / "package.json").write_text(
        json.dumps(
            {
                "name": f"runner-pnpm-seed-{repo.replace('/', '-')}",
                "private": True,
                "packageManager": package_manager,
            },
            indent=2,
        )
        + "\n"
    )
    if seed_workspace:
        (destination / "pnpm-workspace.yaml").write_text(
            yaml.safe_dump(seed_workspace, sort_keys=True)
        )
    for patch in sorted(set(seed_workspace.get("patchedDependencies", {}).values())):
        relative = safe_relative(patch)
        content = raw_file(repo, owner, relative, commit)
        if content is None:
            raise ValueError(f"{repo} names missing patch file {relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return commit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--seed-dir", type=Path, default=DEFAULT_SEED_DIR)
    args = parser.parse_args()

    repositories = json.loads((args.seed_dir / "fleet.json").read_text())[
        "repositories"
    ]
    fleet_dir = args.seed_dir / "fleet"
    wanted = {repo.replace("/", "__") for repo in repositories}
    if fleet_dir.exists():
        for stale in fleet_dir.iterdir():
            if stale.is_dir() and stale.name not in wanted:
                shutil.rmtree(stale)
    for repo in repositories:
        commit = sync_repository(repo, fleet_dir / repo.replace("/", "__"))
        print(f"{repo} {commit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
