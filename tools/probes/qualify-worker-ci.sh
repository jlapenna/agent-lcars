#!/usr/bin/env bash
# Existing provider suites in an ordinary CI allocation. No agent dispatch,
# Docker, external archive receiver, or production-policy selector change.
set -euo pipefail

provider="${LCARS_QUALIFICATION_PROVIDER:?provider is required}"
image_id="${LCARS_QUALIFICATION_IMAGE_ID:?expected image ID is required}"
output="${LCARS_QUALIFICATION_OUTPUT:?new output directory is required}"
case "$provider" in claude|codex|opencode) ;; *) echo 'Unsupported provider' >&2; exit 2 ;; esac
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Expected immutable image ID required' >&2; exit 2; }
[[ "$output" = /* ]] || { echo 'Absolute output directory required' >&2; exit 2; }
[[ "$(id -u)" = 1001 ]] || { echo 'Run as the normal image job user (1001)' >&2; exit 2; }

source_root="$(git rev-parse --show-toplevel)"
cd "$source_root"
mkdir -m 700 "$output" # Refuse an existing run; never overwrite a failure.
scratch="$(mktemp -d "${RUNNER_TEMP:-/tmp}/worker-policy-scratch.XXXXXX")"
mkdir -m 700 "$scratch/home" "$scratch/tmp"
binary="$(command -v "$provider")"
[[ "$binary" = /* ]] || { echo 'Image CLI must resolve to an absolute path' >&2; exit 2; }

run_phase() {
  local phase="$1" seconds="$2" status
  shift 2
  if timeout --signal=TERM --kill-after=10s "${seconds}s" "$@" \
    >"$output/$phase.stdout.txt" 2>"$output/$phase.stderr.txt"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$status" >"$output/$phase.exit"
  return "$status"
}

# The native driver already supplies localhost model/transport fixtures. Keep
# its normal passing-scratch cleanup; do not archive copied dependency trees.
run_phase version 30 env -i PATH="$PATH" HOME="$scratch/home" \
  TMPDIR="$scratch/tmp" "$binary" --version
version="$(cat "$output/version.stdout.txt")"
run_phase native 1200 env -i PATH="$PATH" HOME="$scratch/home" \
  TMPDIR="$scratch/tmp" node tools/probes/in-runner-image.mjs \
  "$provider" "$binary" "$version" "$image_id"
run_phase setup-negative 180 env -i PATH="$PATH" HOME="$scratch/home" \
  TMPDIR="$scratch/tmp" node tools/probes/in-runner-image.mjs \
  "$provider" "$binary" "$version" "$image_id" setup-negative

export LCARS_QUALIFICATION_OUTPUT="$output"
export LCARS_QUALIFICATION_PROVIDER="$provider"
export LCARS_QUALIFICATION_IMAGE_ID="$image_id"
export LCARS_QUALIFICATION_VERSION="$version"
run_phase evaluator 30 node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { artifactHashes, evaluateImageEvidence } from './tools/probes/qualification-evidence.mjs';

const output = process.env.LCARS_QUALIFICATION_OUTPUT;
const expected = {
  provider: process.env.LCARS_QUALIFICATION_PROVIDER,
  providerVersion: process.env.LCARS_QUALIFICATION_VERSION,
  imageId: process.env.LCARS_QUALIFICATION_IMAGE_ID,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  ...artifactHashes(process.cwd()),
};
const read = (phase) => JSON.parse(readFileSync(join(output, `${phase}.stdout.txt`), 'utf8'));
const result = evaluateImageEvidence(expected, read('native'), read('setup-negative'));
writeFileSync(join(output, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
writeFileSync(join(output, 'qualification.json'), JSON.stringify({
  ...expected,
  ...result,
  imageIdentityVerified: false,
  qualificationAccepted: false,
  imageIdentitySource: 'Operator-supplied expected ID; actual runner Pod binding must be verified before acceptance',
  workflowRunId: process.env.GITHUB_RUN_ID,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runnerName: process.env.RUNNER_NAME,
}, null, 2) + '\n');
if (!result.offlinePassed) process.exitCode = 1;
JS

reports="$(node --input-type=module -e 'console.log(JSON.stringify([process.argv[1]]))' "$output/native.stdout.txt")"
run_phase consumer 600 env -i PATH="$PATH" HOME="$scratch/home" \
  TMPDIR="$scratch/tmp" LCARS_NATIVE_FAILURE_REPORTS="$reports" \
  pnpm exec vitest run --config tools/probes/failure-qualification.config.mts --maxWorkers=1

printf 'Provider tests and failure consumer passed. Image acceptance and production activation remain separate.\n'
