#!/usr/bin/env bash
# Exercises the build-time image gate (#2033) and the fail-closed layer-1
# skill installer against a fake image filesystem: a healthy image passes, a
# no-op rerun is safe, and each broken invariant fails the build by name.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "verify-image-invariants.test.sh: $*" >&2
  exit 1
}

lib="$tmp/lib"
home="$tmp/home"
bin="$tmp/bin"
mkdir -p "$lib/runtime" "$lib/agents/shared" "$home" "$bin" "$tmp/corepack" \
  "$tmp/externals/node20/bin" "$tmp/externals/node24/bin" "$tmp/archive"
cp "$here/externals-health.sh" "$here/toolchain-health.sh" "$here/verify-image-invariants.sh" "$lib/"
cp "$here/runtime/install-skills.sh" "$here/runtime/layer1-skills.conf" "$lib/runtime/"
cp -R "$repo_root/agents/shared/skills" "$lib/agents/shared/skills"

write_exe() {
  printf '%s\n' '#!/bin/sh' "$2" > "$1"
  chmod +x "$1"
}
write_exe "$tmp/externals/node20/bin/node" 'exit 0'
write_exe "$tmp/externals/node24/bin/node" 'exit 0'
write_exe "$bin/pnpm" 'exit 0'
write_exe "$bin/java" "echo 'openjdk version \"21.0.8\" 2025-07-15' >&2"
write_exe "$bin/opencode" '[ "$1 $2" = "run --help" ] && echo "      --auto   auto-approve permissions"; exit 0'
write_exe "$bin/lcars" 'exit 0'

gate() {
  env HOME="$home" PATH="$bin:/usr/bin:/bin" \
    AGENT_LCARS_LIB_DIR="$lib" \
    AGENT_LCARS_EXTERNALS_DIR="$tmp/externals" \
    AGENT_LCARS_COREPACK_DIR="$tmp/corepack" \
    AGENT_LCARS_JAVA_COMMAND="$bin/java" \
    AGENT_LCARS_OPENCODE="$bin/opencode" \
    AGENT_LCARS_LCARS="$bin/lcars" \
    AGENT_LCARS_ARCHIVE_CACHE="$tmp/archive" \
    bash "$lib/verify-image-invariants.sh" >"$tmp/out" 2>&1
}

install_skills() {
  bash "$lib/runtime/install-skills.sh" "$lib/agents/shared/skills" "$home/.claude/skills" >/dev/null 2>"$tmp/install.err"
}

# Setup order matters: the gate refuses an image whose skills were never installed.
if gate; then fail "gate accepted an image with no layer-1 skills installed"; fi
grep -q "FAIL: layer-1 skill 'agent-protocol' is installed" "$tmp/out" ||
  fail "missing skill was not named ($(cat "$tmp/out"))"

install_skills || fail "installer rejected the real layer-1 skills ($(cat "$tmp/install.err"))"
gate || fail "healthy image was rejected ($(cat "$tmp/out"))"

# A no-op repeat of setup is safe: reinstalling yields the same content and
# the gate still passes.
digest() { find "$home/.claude/skills" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum; }
before="$(digest)"
install_skills || fail "repeat install failed ($(cat "$tmp/install.err"))"
[ "$(digest)" = "$before" ] || fail "repeat install changed the installed skills"
gate || fail "gate failed after a no-op setup repeat ($(cat "$tmp/out"))"

# Each broken invariant fails the build and is reported by name, while the
# gate keeps going so one build shows every regression.
expect_failure() {
  local label="$1" message="$2"
  if gate; then fail "$label: gate accepted a broken image"; fi
  grep -Fq "FAIL: $message" "$tmp/out" || fail "$label: expected 'FAIL: $message' ($(cat "$tmp/out"))"
}

write_exe "$tmp/externals/node20/bin/node" 'exit 1'
write_exe "$bin/opencode" 'exit 0'
expect_failure "two regressions" "Actions node20/node24 runtimes run"
grep -Fq "FAIL: trusted OpenCode CLI supports QueueExecutor's --auto mode" "$tmp/out" ||
  fail "gate stopped at the first failure instead of reporting all of them"
grep -Fq "2 image invariant(s) failed" "$tmp/out" || fail "failure count was wrong ($(cat "$tmp/out"))"
write_exe "$tmp/externals/node20/bin/node" 'exit 0'
write_exe "$bin/opencode" '[ "$1 $2" = "run --help" ] && echo "      --auto   auto-approve permissions"; exit 0'

write_exe "$bin/java" "echo 'openjdk version \"17.0.16\" 2025-07-15' >&2"
expect_failure "java 17" "Java 21+ runs"
write_exe "$bin/java" "echo 'openjdk version \"21.0.8\" 2025-07-15' >&2"

mkdir -p "$home/.codex" && : > "$home/.codex/auth.json"
expect_failure "baked codex auth" "image carries no Codex authentication"
rm -f "$home/.codex/auth.json"

rmdir "$tmp/archive"
expect_failure "archive cache" "action-archive cache is baked"
mkdir "$tmp/archive"

rm "$bin/lcars"
expect_failure "lcars" "lcars CLI is executable"
write_exe "$bin/lcars" 'exit 0'

gate || fail "restored image was rejected ($(cat "$tmp/out"))"

# The installer fails closed: a listed skill the image does not carry is a
# build failure, not a per-dispatch warning.
mv "$lib/agents/shared/skills/lcars-session-updates" "$tmp/moved-skill"
if install_skills; then fail "installer accepted a missing layer-1 skill"; fi
grep -q "lcars-session-updates" "$tmp/install.err" || fail "installer did not name the missing skill"
mv "$tmp/moved-skill" "$lib/agents/shared/skills/lcars-session-updates"

printf '# nothing\n' > "$lib/runtime/layer1-skills.conf"
if install_skills; then fail "installer accepted an empty layer-1 list"; fi

rm "$lib/runtime/layer1-skills.conf"
if install_skills; then fail "installer accepted a missing layer-1 list"; fi

echo "verify-image-invariants.test.sh: all cases passed"
