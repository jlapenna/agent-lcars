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
providers authenticate with the maintainer's subscriptions, but a review
never mounts the caller's provider directories: they configure the caller's
live sessions (settings, hooks, plugins, skills, rules, MCP servers, memory,
sourced shell state), and a review once rewrote one (#3379).
`review-auth-mounts.mjs` gives each review a fresh private provider home under
the run's `native-home/`, and no review can change a rotating login the
caller's sessions depend on:

- Claude uses the fleet's long-lived, non-rotating `CLAUDE_CODE_OAUTH_TOKEN`
  ([fleet credentials](fleet-credentials.md)). The launcher reads it from
  Secret Manager, which needs project-level access to `agent-lcars` (otherwise
  supply a protected `LCARS_REVIEW_CLAUDE_TOKEN_FILE`), into a private
  temporary file, mounts it read-only and removes it after the run.
- Codex has no long-lived token, so the caller's `auth.json` is bound
  read-only. Codex refreshes at a known time (access-token expiry or
  `last_refresh` + 8 days). When that falls inside the run, the launcher waits
  for it and lets the refresh happen on the host in the caller's own
  directory (a live session's next request, or one minimal host request),
  then starts the review. Only a host that cannot refresh stops the launch.
- The Antigravity token is bound read-only, as the fleet runner copies it.

Bind targets live in the private home, so a host-side replace of a bound file
only detaches the review from it. The review's transcripts land in the private
home, where the in-container evidence collector reads them. The container
drops to the caller's UID. The image's normal runner UID and setup
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
