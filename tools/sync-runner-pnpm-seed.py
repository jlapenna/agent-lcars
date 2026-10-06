#!/usr/bin/env python3
"""Refresh the runner image's pnpm store seed from the fleet's lockfiles.

The runner image pre-fetches every package the fleet's JavaScript repositories
lock into its pnpm content store (apps/runner-autoscaler/runner-image/
Dockerfile, stage pnpm-store-seed), so a job's `pnpm install` reuses image
content instead of downloading it (agent-lcars#2076). This script copies, as
data, exactly what `pnpm fetch --frozen-lockfile` needs from each repository
listed in pnpm-seed/fleet.json at its default branch head:

  pnpm-lock.yaml       without its patch map or patch-qualified identities
  package.json         only name/private/packageManager (corepack version)
  pnpm-workspace.yaml  only supportedArchitectures

Nothing else is read: no source, scripts, patches, or build context. The
store holds unpatched package content either way (pnpm applies patches when
it links a package), so dropping the lockfile's patch map lets `pnpm fetch`
run without the patch files. Patch-qualified dependency paths must be normalized
consistently too: frozen pnpm rejects hashes without their patch map. Files are fetched
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
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

DEFAULT_SEED_DIR = Path(__file__).resolve().parent.parent / (
    "apps/runner-autoscaler/runner-image/pnpm-seed"
)
WORKSPACE_KEYS = ("supportedArchitectures",)


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


def without_patched_dependencies(lockfile: str) -> str:
    """Drop the lockfile's top-level patchedDependencies mapping."""
    kept: list[str] = []
    skipping = False
    for line in lockfile.splitlines(keepends=True):
        if line.startswith("patchedDependencies:"):
            skipping = True
            continue
        if skipping and (line[:1] in (" ", "\t") or not line.strip()):
            continue
        skipping = False
        kept.append(line)
    stripped = "".join(kept)
    qualifier = re.compile(r"\(patch_hash=[0-9a-f]+\)")
    normalized = qualifier.sub("", stripped)
    if "(patch_hash=" in normalized:
        raise ValueError("unsupported seed patch hash qualifier")
    if normalized == stripped:
        return stripped

    collided = False

    def normalize(value):
        nonlocal collided
        if isinstance(value, str):
            return qualifier.sub("", value)
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                normalized_key = normalize(key)
                normalized_item = normalize(item)
                if normalized_key in result:
                    if result[normalized_key] != normalized_item:
                        raise ValueError("contradictory normalized seed dependency identity")
                    collided = True
                result[normalized_key] = normalized_item
            return result
        return value

    parsed = normalize(yaml.safe_load(stripped))
    # Preserve source formatting unless identical keys need coalescing.
    return yaml.safe_dump(parsed, sort_keys=False) if collided else normalized


def validate_seed_lockfile(repo: str, lockfile: str) -> None:
    """Refuse a lockfile the image's `pnpm fetch --frozen-lockfile` cannot use.

    The seed is only exercised when the runner image is built, so a bad
    lockfile committed here surfaces as a failed publication of every later
    runner-image change (#2084 emptied them all; #2151 left stale patch
    hashes). Reject it before anything is written instead.
    """
    try:
        parsed = yaml.safe_load(lockfile)
    except yaml.YAMLError as error:
        raise ValueError(f"{repo} seed lockfile is not YAML: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"{repo} seed lockfile is empty")
    version = str(parsed.get("lockfileVersion", ""))
    if not version.startswith("9."):
        raise ValueError(
            f"{repo} seed lockfile has lockfileVersion {version!r}; the seed needs pnpm 11's 9.x"
        )
    packages = parsed.get("packages")
    if not isinstance(packages, dict) or not packages:
        raise ValueError(f"{repo} seed lockfile locks no packages")
    if "patchedDependencies" in parsed or "(patch_hash=" in lockfile:
        raise ValueError(f"{repo} seed lockfile still references patches")


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
    seed_lockfile = without_patched_dependencies(lockfile)
    validate_seed_lockfile(repo, seed_lockfile)

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    (destination / "pnpm-lock.yaml").write_text(seed_lockfile)
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
