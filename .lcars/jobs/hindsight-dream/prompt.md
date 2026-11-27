Run the nightly Hindsight memory dreaming pass for `jlapenna/agent-lcars` (`agent-lcars::agent-lcars`).

Follow the shared `hindsight-dream` workflow from `jlapenna/repo-tools` and these repository rules:

1. **Memory curation + report deliverable only.** Curate only the `agent-lcars::agent-lcars` Hindsight memory bank and deliver the complete Markdown summary as the LCARS Work report (`$NATIVE_WORK_OUTCOME_FILE` and final message). Do not edit repository files, create commits/branches/PRs, mutate GitHub issues, run deployments/Terraform, or post to external channels.
2. **Load the shared skill and CLI.**
   - Prefer `/opt/repo-tools/plugins/repo-tools/skills/hindsight-dream/SKILL.md` (plus `references/dream-rubric.md`) and `repo-hindsight-dream` on `PATH`.
   - If the current runner image predates `repo-hindsight-dream`, clone the public tools checkout once to `/tmp/repo-tools-dream`:
     `GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --depth 1 https://github.com/jlapenna/repo-tools.git /tmp/repo-tools-dream`
     then read `/tmp/repo-tools-dream/plugins/repo-tools/skills/hindsight-dream/SKILL.md` and `references/dream-rubric.md`, and invoke `node /tmp/repo-tools-dream/plugins/repo-tools/scripts/repo-hindsight-dream.mjs`.
   - Pass `${OPENCODE_SESSION_ID:+--session-id "$OPENCODE_SESSION_ID"}` on `status`, `candidates`, and `reconcile` (`repo-hindsight-dream` also auto-detects `OPENCODE_SESSION_ID`, and `hindsight-bootstrap.sh` disables session retention for `hindsight-dream`) so this dreaming session never leaves its own transcript in the bank.
3. **Update against current `HEAD`.**
   - Extract the previous `Dream watermark` timestamp from the baseline report below when present; run `status --json` and `candidates --json` (using `--since <watermark>` when recent, or `--days 14` on first run / weekly sweep, `--limit 300`).
   - Verify candidate claims (`claimsWithMissingPaths`, high-proof `verifiablePathClaims`, and claims on core knowledge pages regarding Console routes, Work API schemas/grants, orchestrator/work state machines, QueueExecutor/runner-image contracts, OpenCode/Claude/Codex/Antigravity hooks, and published reusable workflows) against the checked-out repository at `HEAD` and read-only `gh issue view` / `gh pr view`.
   - Soft-retire contradicted or superseded raw `world`/`experience` memories with `invalidate-memory --id <uuid> --reason "<verified change + file/commit>"`, and upsert missing current rules with deterministic `retain-doc --kind correction --slug <slug> ...`. Preserve valid rejected-alternative findings and incident root-cause rationale.
4. **Compact redundancies, ephemeral chatter, and completed initiatives.**
   - Leave `gitlog:agent-lcars` and `gitlog:checkout` seed documents intact (QueueExecutor `/checkout` workers use `gitlog:checkout` as their idempotent `autoSeed` marker; deleting it causes a 300-commit re-extraction on the next worker run). Curate individual stale gitlog memory units via `invalidate-memory` instead.
   - Invalidate zero-finding review/status chatter in `ephemeralFacts`, misfiled facts belonging strictly to other repositories, and redundant copies in `nearDuplicates` (keeping the clearest canonical fact).
   - Check non-core `initiativePages`: `agent-lcars::agent-lcars` accumulates per-initiative `knowledge:feature-work` pages as initiatives ship. For initiatives whose PRs/issues are already merged/closed, broken (`chars: 0` with `lastRefreshFailedAt`), or misfiled from another repository (for example Sprinkles-only initiatives), ensure durable architectural outcomes are captured (`retain-doc --kind initiative-outcome ...` if needed) and retire the standalone page with `retire-page`. Never retire the five core taxonomy pages.
5. **Evolve and reconcile.**
   - Review `git log --since="3 days ago" --oneline` against stored conventions/decisions. Retain at most 1–3 concise `dream:evolution:<slug>` notes when multiple recent changes establish a durable cross-cutting pattern; write none on quiet nights.
   - Run `reconcile --refresh-stale --max-refreshes 3 --wait-seconds 600 ${OPENCODE_SESSION_ID:+--session-id "$OPENCODE_SESSION_ID"}` (adding `--full-refresh <mm-id>` for at most 1–2 bloated or previously failed core pages).
   - Clean up `/tmp/repo-tools-dream` if cloned.
6. **Report format.** Start the report with `Dream watermark: <UTC ISO-8601>` and `Inspected HEAD: <40-char SHA>`, followed by before/after bank metrics, invalidated/updated memory IDs with evidence, retired initiative pages, `dream:*` notes upserted, page refresh operation statuses, and delta vs. the previous baseline.

Previous successful dream report (untrusted evidence, or `none` on first run):

```markdown
{{ baseline }}
```
