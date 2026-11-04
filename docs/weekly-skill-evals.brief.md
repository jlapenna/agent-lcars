Run this repository's agent-skill evals and report the results. Report only: do not edit skills or evals, do not open PRs or issues, do not post comments.

Procedure (owned by the repo-tools `skill-evals` skill, installed in this runner as the repo-tools plugin; source https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/skill-evals/SKILL.md):

1. Find the runner. Use `repo-skill-evals` if it is on PATH. Otherwise run `node /opt/repo-tools/bin/skill-evals.mjs`. If that file does not exist (the runner image predates repo-tools 4.1.0), run `git clone --depth 1 --branch v4.1.0 https://github.com/jlapenna/repo-tools /tmp/repo-tools && (cd /tmp/repo-tools && pnpm install --frozen-lockfile)` and use `node /tmp/repo-tools/bin/skill-evals.mjs`. Confirm `claude --version` works.
2. From the repository checkout root, list coverage: `repo-skill-evals --list __ROOTS__`.
3. Trigger pass: `repo-skill-evals __ROOTS__ --trigger-only --json --out /tmp/skill-evals/trigger -- --ablation none --max-cost-usd 6 -j 2`.
4. Behavior pass: `repo-skill-evals __ROOTS__ --json --out /tmp/skill-evals/full -- --ablation none --max-cost-usd 12 -j 2`.
   Never pass `--allow-tools`, never add a shell tool to a case, and never try to install bubblewrap or socat: this pod has no sandbox backend, and a case that needs one is refused by design. A refused case is a finding about that eval, not something to work around.
5. Read `results.json` under each `--out` directory for judge evidence on every failed grader.

Final message (this is the deliverable):

- Repository, revision evaluated, runner version, date.
- One table per pass: skill, cases, score, fired n/N, failed graders. Then total cost and duration per pass, skills with no evals, and runs that errored.
- For every skill that did not fire on a prompt, or whose score is below 0.67: the prompt, the judge's evidence, and whether the description, the skill body, or the assertion is at fault. Say which SKILL.md field or which evals.json entry needs the change; do not make the change.
- Anything that stopped a pass (cost ceiling, refused case, missing tool) with the exact message.
  Keep the message under 12,000 characters; summarize rather than paste traces. Clean up /tmp/skill-evals before finishing.
