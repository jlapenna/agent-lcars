#!/usr/bin/env bash
# .github/actions/resume-session/resume.test.sh -- modeled on
# direct-runner.test.sh's fake-PATH-binary pattern: a fake `node` ahead of
# the real one on PATH records its argv and prints a fake resumed path, so
# this asserts on resume.sh's own bash logic without spawning a real node
# subprocess or making a real GCS call.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
export tmp
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"

# The fixture shells out to this fake `node` binary rather than a real node
# subprocess -- it just records its argv and echoes a fake resumed-path, so
# the test asserts resume.sh's own guard/argument-assembly logic, not
# sidecar.cjs's real download behavior (covered separately by that tool's
# own tests).
cat > "$tmp/bin/node" <<'FAKE'
#!/usr/bin/env bash
echo "$@" > "$tmp/node-args.log"
echo "/fake/claude/projects/-fake-cwd/sess_1.jsonl"
FAKE
chmod +x "$tmp/bin/node"

export PATH="$tmp/bin:$PATH"

sidecar="$tmp/fake-sidecar.cjs"
echo 'console.log(1)' > "$sidecar"

WORK_JSON_WITH_RESUME='{"id":"01X","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"o/r"}},"resume":{"sessionId":"sess_1","transcriptGcsUri":"gs://b/x.jsonl"}}'
WORK_JSON_NO_RESUME='{"id":"01X","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"o/r"}}}'

# --- Scenario 1: resume present, credentials present, sidecar present --
# the sidecar is invoked with the session id and transcript uri, and
# resume.sh prints the session-id output line.
out="$(WORK_JSON="$WORK_JSON_WITH_RESUME" GOOGLE_APPLICATION_CREDENTIALS="$tmp/creds.json" \
  SIDECAR_BIN="$sidecar" bash "$here/resume.sh")"
grep -q 'sess_1' "$tmp/node-args.log" || { echo "FAIL: session id not passed to sidecar"; exit 1; }
grep -q 'gs://b/x.jsonl' "$tmp/node-args.log" || { echo "FAIL: transcript uri not passed to sidecar"; exit 1; }
[ "$out" = "session-id=sess_1" ] || { echo "FAIL: unexpected output: $out"; exit 1; }
echo "PASS: resume present -> sidecar invoked, session-id output"

# --- Scenario 2: no `resume` in the work JSON -> no sidecar invocation, no
# output, still exits 0.
rm -f "$tmp/node-args.log"
out="$(WORK_JSON="$WORK_JSON_NO_RESUME" GOOGLE_APPLICATION_CREDENTIALS="$tmp/creds.json" \
  SIDECAR_BIN="$sidecar" bash "$here/resume.sh")"
[ -z "$out" ] || { echo "FAIL: expected no output when work has no resume, got: $out"; exit 1; }
[ ! -s "$tmp/node-args.log" ] || { echo "FAIL: sidecar invoked despite no resume"; exit 1; }
echo "PASS: no resume -> no sidecar call, no output"

# --- Scenario 3: resume present but no writer credentials -> fail-soft, no
# sidecar invocation.
rm -f "$tmp/node-args.log"
out="$(WORK_JSON="$WORK_JSON_WITH_RESUME" GOOGLE_APPLICATION_CREDENTIALS="" \
  SIDECAR_BIN="$sidecar" bash "$here/resume.sh")"
[ -z "$out" ] || { echo "FAIL: expected no output with no credentials, got: $out"; exit 1; }
[ ! -s "$tmp/node-args.log" ] || { echo "FAIL: sidecar invoked despite missing credentials"; exit 1; }
echo "PASS: no credentials -> fail-soft, no output"

# --- Scenario 4: resume present but the baked sidecar binary is missing
# (runner image predates the bake-in) -> fail-soft.
out="$(WORK_JSON="$WORK_JSON_WITH_RESUME" GOOGLE_APPLICATION_CREDENTIALS="$tmp/creds.json" \
  SIDECAR_BIN="$tmp/does-not-exist.cjs" bash "$here/resume.sh")"
[ -z "$out" ] || { echo "FAIL: expected no output with missing sidecar binary, got: $out"; exit 1; }
echo "PASS: missing sidecar binary -> fail-soft, no output"

# --- Scenario 5: an issue-anchored dispatch, where `inputs.work` (and so
# WORK_JSON) is genuinely empty, not `{}` -- the lane must stay byte-for-
# byte a no-op here too.
rm -f "$tmp/node-args.log"
out="$(WORK_JSON="" GOOGLE_APPLICATION_CREDENTIALS="$tmp/creds.json" \
  SIDECAR_BIN="$sidecar" bash "$here/resume.sh")"
[ -z "$out" ] || { echo "FAIL: expected no output for an empty (issue-anchored) work-json, got: $out"; exit 1; }
[ ! -s "$tmp/node-args.log" ] || { echo "FAIL: sidecar invoked for an empty (issue-anchored) work-json"; exit 1; }
echo "PASS: empty work-json (issue-anchored dispatch) -> fail-soft, no output"

# --- Scenario 6 (I3): a traversal-shaped session id -- the fake sidecar
# still happily "resumes" it (it just echoes a fixed path regardless of
# argv), but resume.sh's own local guard must reject the id before it
# reaches its $GITHUB_OUTPUT line.
WORK_JSON_TRAVERSAL='{"id":"01X","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"o/r"}},"resume":{"sessionId":"../../etc/passwd","transcriptGcsUri":"gs://b/x.jsonl"}}'
rm -f "$tmp/node-args.log"
out="$(WORK_JSON="$WORK_JSON_TRAVERSAL" GOOGLE_APPLICATION_CREDENTIALS="$tmp/creds.json" \
  SIDECAR_BIN="$sidecar" bash "$here/resume.sh")"
[ -z "$out" ] || { echo "FAIL: expected no output for a traversal-shaped session id, got: $out"; exit 1; }
echo "PASS: traversal-shaped session id -> local guard rejects, no output"

# --- Scenario 7 (I3): the sidecar runs but the download itself fails (no
# resumed path on stdout) -- fail-soft, no output, same as a missing
# sidecar binary but this time the binary ran.
cat > "$tmp/bin/node" <<'FAKE'
#!/usr/bin/env bash
echo "$@" > "$tmp/node-args.log"
FAKE
chmod +x "$tmp/bin/node"
rm -f "$tmp/node-args.log"
out="$(WORK_JSON="$WORK_JSON_WITH_RESUME" GOOGLE_APPLICATION_CREDENTIALS="$tmp/creds.json" \
  SIDECAR_BIN="$sidecar" bash "$here/resume.sh")"
[ -z "$out" ] || { echo "FAIL: expected no output when the download fails, got: $out"; exit 1; }
grep -q 'sess_1' "$tmp/node-args.log" || { echo "FAIL: sidecar was not invoked before failing"; exit 1; }
echo "PASS: download failure -> fail-soft, no output"

echo "PASS"
