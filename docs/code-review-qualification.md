# Qualifying the native review procedure

The runner packages Anthropic's immutable `code-review` command and the LCARS
adapter for Claude Code, Codex, OpenCode and Antigravity. The Git submodule is
its dependency lock. The adapter lives at
`agents/shared/skills/agent-protocol/reference/anthropic-code-review/README.md`.

The four native CLI versions are image dependencies too. Renovate updates
`runner-image/runtime-clis/package.json` and its npm lock for Codex and Claude,
and the `opencode-version`, `agy-version` and `runtime-releases.json` platform
locks for the standalone releases. The attachment datasource resolves updated
SHA-256 values. Installers reject a selector without a matching platform lock.
These inputs invalidate the image layers when a release changes. Runtime and
upstream-procedure updates arrive as draft PRs outside unattended auto-merge;
the maintainer completing an update runs qualification before making it ready.

Run this explicit, paid functional evaluation when changing the procedure or
qualifying runtime updates. It is not scheduled monitoring or a health probe.
Build the pushed candidate with `AGENT_LCARS_REF` set to its full source SHA
and `--label org.opencontainers.image.revision=<same-SHA>`. Use the owning image
workflow’s other build inputs, then inspect its immutable local ID:

```bash
docker image inspect --format '{{.Id}}' <candidate-tag>
LCARS_REVIEW_CODEX_MODEL=<caller-selected-model> \
LCARS_REVIEW_CODEX_EFFORT=<caller-selected-effort> \
LCARS_REVIEW_OPENCODE_KEY_FILE=<protected-native-key-file> \
  node tools/probes/qualify-review-matrix.mjs \
  <candidate-PR-number> <sha256:image-id> <new-absolute-private-evidence-directory>
```

The key file is a protected consuming-process binding for the existing named
`OPENCODE_LLM_API_KEY`, never a committed file or a value in argv. Other
providers use the caller's existing native authentication directory, mounted
without copying rotating login state. The container drops to the caller's UID
so those files retain their ownership. The hook registrations LCARS's worker installer
writes, and the scripts they run, are overlaid read-only when present: Claude
`settings.json`, `settings.local.json` and `hooks/`, and Codex `hooks.json`.
The launcher also snapshots those registration files before the run. If the
run created one, it is moved aside to `<file>.review-qualification-<time>` and
the qualification fails; any other change fails the qualification and is
recorded in `registration-changes.json` (#3379). The rest of the directory
stays writable for rotating login state, so Claude `plugins/` and Codex
`config.toml` are not protected by this guard. The image's normal runner UID and setup
are checked by the image build gates; this caller-authenticated test does not
establish LCARS control-plane dispatch coverage. Never change accounts or
models to evade an exhausted provider quota.

The explicit PR argument selects the current candidate. The historical anchors
remain fixed. The committed cases cover the actual candidate PR, the earlier real PR revision
with the unqualified-upstream-update defect, and PR #3355's file-mount change.
Historical source is materialized at the requested head before native startup,
so project guidance imports come from that revision. The earlier revision is
reviewed under an explicitly recorded shared-preset
snapshot. Its bytes and provenance are inputs for every reviewer and validator;
the test does not assert what an unversioned hosted URL served historically.
Expectations remain in the driver and are not included in model prompts.

Each provider runs cases serially and stops at its first failed case; the other
providers finish independently. This also stops exhausted-account failures that
happen before native JSON is emitted. A stopped lane cannot qualify: acceptance
still requires every case for all four providers.
The optional final provider argument selects one lane for diagnosis. Keep the
first failure, its source and logs. Retry only after diagnosing an environment
failure or changing a relevant input; do not rerun a quality failure until green.
Use `run-review-image.mjs` with a historical case SHA for a targeted follow-up.
A provider limit is incomplete qualification, never a clean review or PARK.
Each provider uses the existing 80-minute production execution budget; OpenCode
runs children sequentially with the same local model and an explicit `medium`
reasoning budget in review mode. The native OpenAI-compatible request must carry
`reasoning_effort: "medium"`; a CLI variant without a declared model variant is
not sufficient. Other worker modes keep their existing model configuration.
Claude print mode keeps awaiting background reviewers
under that bounded outer deadline, without its earlier ten-minute idle cutoff.

Inspect `matrix.json` and each case's `run/evaluation.json`, `receipt.json`,
`review.json`, native transcripts and manifest. Acceptance requires all four
providers to complete all cases, four distinct native reviewer completions per
case, a fresh completed validator for every candidate, the known defect found
and independently confirmed, and source-bound publication payloads. The native
collector checks parent/session identity rather than trusting model-authored
receipts. Its regression keyword check is only a minimum guard: inspect the
actual claimed defect and validator evidence before accepting it.

Publication is captured as COMMENT payloads to avoid posting evaluation traffic
to historical PRs. These tests do not prove a successful GitHub review API write.
Perform and verify an actual current-head review through the owning review path
before claiming end-to-end publication coverage. Keep raw evidence private for
at least 90 days, record model/config/source/image hashes, and link a bounded
summary in the PR. Preserve failed trials alongside later corrected runs.
