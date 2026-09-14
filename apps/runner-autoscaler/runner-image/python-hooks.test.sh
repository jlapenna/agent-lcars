#!/usr/bin/env bash
# Offline contract for image-owned Python tools and real linked-worktree hooks.
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export PRE_COMMIT_HOME="$scratch/cache"
uv --version
pre-commit --version
uv venv --offline --python python3 "$scratch/venv"
"$scratch/venv/bin/python" -c 'import pathlib; assert pathlib.Path.cwd().is_dir()'
git init --quiet --initial-branch=main "$scratch/repo"
git -C "$scratch/repo" config user.name 'Runner tooling test'
git -C "$scratch/repo" config user.email 'runner-tooling@example.invalid'
cat > "$scratch/repo/.pre-commit-config.yaml" <<'YAML'
repos:
  - repo: local
    hooks:
      - id: reject-invalid-fixture
        name: Reject invalid fixture
        language: system
        entry: python3 verify_fixture.py
        pass_filenames: false
YAML
cat > "$scratch/repo/verify_fixture.py" <<'PY'
from pathlib import Path
raise SystemExit('invalid' in Path('fixture.txt').read_text())
PY
printf 'valid\n' > "$scratch/repo/fixture.txt"
git -C "$scratch/repo" add .
git -C "$scratch/repo" commit --quiet -m 'initial fixture'
git -C "$scratch/repo" worktree add --quiet -b feature "$scratch/worktree"
cd "$scratch/worktree"
pre-commit install --install-hooks
before=$(git rev-parse HEAD)
printf 'invalid\n' > fixture.txt
git add fixture.txt
if git commit --quiet -m 'must be rejected' > "$scratch/rejected.log" 2>&1; then
  echo 'FAIL: invalid commit bypassed the installed hook' >&2
  exit 1
fi
grep -q 'Reject invalid fixture.*Failed' "$scratch/rejected.log"
[[ "$(git rev-parse HEAD)" == "$before" ]]
printf 'valid changed\n' > fixture.txt
git add fixture.txt
git commit --quiet -m 'valid fixture passes hook'
[[ "$(git rev-parse HEAD)" != "$before" ]]
echo 'Python tooling and linked-worktree hook enforcement: OK'
