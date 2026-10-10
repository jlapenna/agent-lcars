#!/usr/bin/env node
// Fleet onboarding scaffolder. Generates the target repository's fleet
// surface, admits the repository into this control plane's configuration,
// and prints the remaining operator steps. docs/onboarding-repo.md owns the
// runbook; this tool owns the repetitive file edits it used to prescribe by
// hand. It never touches GitHub, credentials, or Homelab.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parse as parseYaml } from 'yaml';

export const MANAGED_MARKER = 'fleet-onboard: managed';
const MANAGED_NOTE = `${MANAGED_MARKER} by jlapenna/agent-lcars tools/fleet-onboard.mjs. Re-run it to refresh; delete this line to own the file locally.`;
export const GUARDRAIL_COMMAND =
  'guard=$(command -v fleet-codex-issue-guardrail || true); if [ -n "$guard" ]; then fleet-codex-issue-guardrail; fi; exit 0';
export const BASELINE_CHECKS = Object.freeze([
  'gitleaks',
  'validate / repository validation',
  'repository-owned Terraform',
]);
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const AGENTS_BEGIN = '<!-- fleet-onboard:begin -->';
const AGENTS_END = '<!-- fleet-onboard:end -->';
const REPO_TOOLS_URL = 'https://github.com/jlapenna/repo-tools';
const CHECKOUT_PIN = '3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const GITLEAKS_PIN = 'e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0';
const SETUP_TERRAFORM_PIN = 'dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1';
const TERRAFORM_VERSION = 'v1.16.5';

export class OnboardError extends Error {}

function parseRepo(value) {
  if (!value || !REPO_PATTERN.test(value))
    throw new OnboardError(`--repo must be OWNER/NAME, got ${value ?? ''}`);
  const [owner, name] = value.split('/');
  return { full: value, owner, name };
}

function splitList(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function jsonArray(values) {
  return `'${JSON.stringify(values)}'`;
}

/** Resolve the repository shape the generated files depend on. */
export function resolveSpec(options) {
  const repo = parseRepo(options.repo);
  const runnerLabel = options['runner-label'] || null;
  const ciWorkflow = options['ci-workflow'] || null;
  const ciChecks = splitList(options['ci-checks']);
  if (ciChecks.length && !ciWorkflow)
    throw new OnboardError('--ci-checks requires --ci-workflow');
  const ciWorkflowName =
    options['ci-workflow-name'] || (ciWorkflow ? 'CI' : null);
  const requiredChecks = [...new Set([...BASELINE_CHECKS, ...ciChecks])];
  const hooks = options.hooks ?? 'auto';
  if (!['auto', 'pre-commit', 'husky', 'none'].includes(hooks))
    throw new OnboardError(`Unknown --hooks mode ${hooks}`);
  return {
    repo,
    alias: options.alias || repo.name,
    runnerLabel,
    ciWorkflow,
    ciWorkflowName,
    requiredChecks,
    hooks,
    repoToolsRev: options['repo-tools-rev'] || null,
  };
}

// Fork pull requests cannot reach a self-hosted scale set, so every
// credential-free job falls back to GitHub-hosted runners for them.
function glueRunsOn(spec) {
  if (!spec.runnerLabel) return 'ubuntu-latest';
  return `\${{ (github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork) && 'ubuntu-latest' || '${spec.runnerLabel}' }}`;
}

function workflowRunList(spec) {
  const names = ['validate', 'gitleaks', 'ruleset'];
  if (spec.ciWorkflowName) names.unshift(spec.ciWorkflowName);
  return `[${names.join(', ')}]`;
}

export function renderValidateWorkflow() {
  return `# ${MANAGED_NOTE}
name: validate

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}

jobs:
  # The job key composes the required check name "validate / repository
  # validation" (docs/published-actions.md in jlapenna/agent-lcars).
  validate:
    uses: jlapenna/agent-lcars/.github/workflows/repo-validation.yml@main # latest
`;
}

export function renderGitleaksWorkflow(spec) {
  return `# ${MANAGED_NOTE}
name: gitleaks

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  # PR revisions supersede each other, but every main revision must retain a
  # full-history scan: cancelling an earlier main run can leave a secret from
  # that commit outside the replacement run's diff range.
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}

permissions:
  contents: read
  pull-requests: read

jobs:
  gitleaks:
    runs-on: ${glueRunsOn(spec)}
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@${CHECKOUT_PIN}
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@${GITLEAKS_PIN}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_VERSION: '8.18.2'
`;
}

export function renderRulesetWorkflow() {
  return `# ${MANAGED_NOTE}
name: ruleset

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}

jobs:
  terraform:
    name: repository-owned Terraform
    # Credential-free and takes seconds; keep it off any self-hosted pool.
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7

      - uses: hashicorp/setup-terraform@${SETUP_TERRAFORM_PIN}
        with:
          terraform_version: ${TERRAFORM_VERSION}

      - name: Verify repository-owned Terraform
        run: |
          ./tools/github-ruleset-root.test.sh
          terraform -chdir=infra/github-ruleset init -backend=false -input=false -lockfile=readonly
          terraform -chdir=infra/github-ruleset fmt -check -recursive
          terraform -chdir=infra/github-ruleset validate
`;
}

export function renderAutomergeWorkflow(spec) {
  const runsOn = spec.runnerLabel ?? 'ubuntu-latest';
  return `# ${MANAGED_NOTE}
name: Agent PR Auto-Merge

# Thin caller of jlapenna/agent-lcars' fleet-published
# agent-automerge-reusable.yml (its docs/published-actions.md owns the
# contract). Agent-authored PRs (vars.AGENT_BOT_LOGINS) are armed for squash
# auto-merge with a repository-scoped Agent LCARS App token, so the App's
# merge emits the normal push/workflow_run chain, closes linked issues, and
# deletes the branch.

on:
  # App credentials must only enter workflow code loaded from the trusted
  # default branch. pull_request_target supplies PR metadata without
  # evaluating the PR head; no job here checks out or executes PR content.
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review, labeled]
  # Reconciliation is event-driven. A push to main is when an armed PR falls
  # behind and when a PR still armed by github-actions[bot] is re-armed as
  # the App.
  push:
    branches: [main]
  # Every workflow that posts checks on a PR head: a PR turns green when the
  # last one succeeds. The reusable admits only successful same-repository
  # pull_request runs.
  workflow_run:
    workflows: ${workflowRunList(spec)}
    types: [completed]
  # Daily backstop, not a poll: a review thread resolved after checks went
  # green, a late arm, mergeability still UNKNOWN when an event's sweep ran,
  # or a transiently failed sweep emits no subscribable event.
  schedule:
    - cron: '53 9 * * *'
  # Manual repair, e.g. after an Actions outage dropped events.
  workflow_dispatch:

permissions:
  actions: write
  checks: read
  contents: write
  issues: write
  pull-requests: write
  statuses: read

# Pull-request-target events for one PR supersede each other; push,
# workflow_run, schedule, and dispatch reconciliation use their own run IDs.
concurrency:
  group: \${{ github.workflow }}-\${{ github.event_name == 'pull_request_target' && format('pr-{0}', github.event.pull_request.number) || github.run_id }}
  cancel-in-progress: \${{ github.event_name == 'pull_request_target' }}

jobs:
  automerge:
    uses: jlapenna/agent-lcars/.github/workflows/agent-automerge-reusable.yml@main # latest
    with:
      bot-logins: \${{ vars.AGENT_BOT_LOGINS }}
      fleet-login: \${{ vars.AGENT_FLEET_LOGIN }}
      app-token-enabled: true
      app-client-id: \${{ vars.AGENT_LCARS_CLIENT_ID }}
      # Glue work must never queue behind a long agent session.
      runs-on: ${jsonArray([runsOn])}
      # The required checks in this repository's Protect main ruleset
      # (infra/github-ruleset/main.tf).
      required-checks: ${jsonArray(spec.requiredChecks)}
    secrets:
      APP_PRIVATE_KEY: \${{ secrets.AGENT_LCARS_PRIVATE_KEY }}
`;
}

export function renderActionlintConfig(spec) {
  return `# ${MANAGED_NOTE}
# This repository's Homelab runner scale-set label. Declaring it lets
# actionlint accept it, and makes agent-lcars' repo-validation.yml reject any
# job that pairs it with \`self-hosted\`: a scale set matches only its own
# name, so that combination never schedules.
self-hosted-runner:
  labels:
    - ${spec.runnerLabel}
`;
}

export function renderRulesetMain(spec) {
  const checks = spec.requiredChecks
    .map(
      (context) => `      required_check {
        context = "${context}"
      }`,
    )
    .join('\n');
  return `// ${MANAGED_NOTE}
//
// Repository-owned inputs for this repository's Protect main ruleset.
//
// Homelab remains the executor: it supplies the GCS backend configuration,
// GitHub credential, and scheduled drift check. Keeping this root here makes
// required checks reviewable beside the workflows that produce them.
terraform {
  required_version = ">= 1.11"

  // Backend values are deliberately absent. The trusted Homelab executor
  // injects the shared bucket and this repository's isolated state prefix.
  backend "gcs" {}

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "github" {
  owner = "${spec.repo.owner}"
}

resource "github_repository_ruleset" "protect_main" {
  name        = "Protect main"
  repository  = "${spec.repo.name}"
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  # Repository administrators retain the emergency escape hatch needed to
  # repair the ruleset that gates its own pull requests.
  bypass_actors {
    actor_id    = 5
    actor_type  = "RepositoryRole"
    bypass_mode = "always"
  }

  rules {
    deletion                = true
    non_fast_forward        = true
    required_linear_history = true

    pull_request {
      required_approving_review_count   = 0
      dismiss_stale_reviews_on_push     = true
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = true
      allowed_merge_methods             = ["merge", "squash", "rebase"]
    }

    required_status_checks {
      strict_required_status_checks_policy = false
      do_not_enforce_on_create             = false

${checks}
    }
  }
}
`;
}

export function renderRulesetReadme(spec) {
  return `# ${spec.repo.name} GitHub ruleset

This is the repository-owned declaration for its \`Protect main\` GitHub
ruleset. It intentionally has no credential, state-bucket value, or backend
prefix. The trusted Homelab executor (\`bin/plan-fleet-github-ruleset.sh\` in
jlapenna/homelab) supplies those at runtime and owns the scheduled drift
check. Do not run an unconfigured local apply.

Record the live ruleset id here once it is imported into this root's isolated
state. Repository CI initializes, formats, validates, and checks this root's
local contract; only the centralized executor receives backend and state
access.
`;
}

export function renderRulesetRootTest(spec) {
  const contexts = spec.requiredChecks
    .map((context) => `  '${context.replace(/'/g, `'\\''`)}'`)
    .join(' \\\n');
  return `#!/usr/bin/env bash
# ${MANAGED_NOTE}
set -euo pipefail

root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
config="$root/infra/github-ruleset/main.tf"

# The root must remain self-contained so fork pull requests can initialize and
# validate it without credentials or source from another fleet repository.
grep -Fqx '  owner = "${spec.repo.owner}"' "$config"
grep -Fqx '  repository  = "${spec.repo.name}"' "$config"
for context in \\
${contexts}; do
  grep -Fqx "        context = \\"$context\\"" "$config"
done
if grep -Fq 'source = "git::https://github.com/jlapenna/homelab.git' "$config"; then
  echo "github-ruleset root must not import Homelab source" >&2
  exit 1
fi

echo "repository-owned GitHub ruleset contract passed"
`;
}

// Terraform maintains this file; the generator only seeds it so a fresh root
// passes `init -lockfile=readonly` before anyone has run terraform locally.
export function renderProviderLock() {
  return `# This file is maintained automatically by "terraform init".
# Manual edits may be lost in future updates.

provider "registry.terraform.io/integrations/github" {
  version     = "6.13.0"
  constraints = "~> 6.0"
  hashes = [
    "h1:2kD+4leuV8tBBXv+EPeehmfW6cDhIzVki61OXsGCtRI=",
    "h1:YS8951MRtP4YNs2CNsDfqE7Mr9tDz/Y7xDSo18zyCkQ=",
    "zh:0ab29fc21699f34345cf0bbbe44745fd1b143b7c73b410c1dc4abe05ffad0a84",
    "zh:1aed10d06755d420bb3a893bf548ab2932297a9d094c04c5a8501e949ca186ed",
    "zh:2a6a11c21eae408055f45b9533c07afd2e845f6d496fd1b645aec2e873012103",
    "zh:5dd05dee677f6ebdbed00cbb1b9be444ab2d1062d345cbc9ec50a47cb41b8622",
    "zh:6b757d034831243d67ddda869eac4368cef539848bd97511f4d68f1aa38a9c88",
    "zh:947c9b5b238f0364c57a705beabd24d3eea3159a6f3a24c07e3fbb13657ffae0",
    "zh:a676549a98164b61630658cbeb6c17820331ca04a049dc9b5095996a0c31ffbe",
    "zh:a8a81b7fe41dd61eb6a6fa5e08a4dd9ee070e862868252a7fd4cfce30364efee",
    "zh:c26a9bca4865665084e7f59b1402d7aff34ee63a418d7401a0658fa280cad4d4",
    "zh:c638d8d0762e62ea188f86302954ef4c92803f2160f0a45fca0cd13974bd3725",
    "zh:e739a0b7e81ca816944a18a38e679f4015edf8be7ac319815cdea865ba7727d7",
    "zh:ec099487ea3de8999c84b3b791e242d728461e51fe344832b37bd8d521201c77",
    "zh:f016ff9e2daab5b88185cec0795213049d105439ffd585d3309a714514ccae13",
    "zh:fbd1fee2c9df3aa19cf8851ce134dea6e45ea01cb85695c1726670c285797e25",
  ]
}
`;
}

export function renderRenovateConfig() {
  return `${JSON.stringify(
    {
      $schema: 'https://docs.renovatebot.com/renovate-schema.json',
      extends: ['github>jlapenna/repo-tools//renovate-preset'],
      vulnerabilityAlerts: {
        enabled: true,
        labels: ['bot:renovate', 'type:security'],
      },
    },
    null,
    2,
  )}\n`;
}

export function renderPreCommitBlock(rev) {
  return `  - repo: ${REPO_TOOLS_URL}
    rev: ${rev}
    hooks:
      - id: repo-require-worktree
      - id: repo-require-worktree-push
`;
}

export function renderPreCommitConfig(rev) {
  return `default_install_hook_types: [pre-commit, pre-push]
default_stages: [pre-commit]

repos:
${renderPreCommitBlock(rev)}
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-added-large-files
`;
}

export function renderHuskyHook(stage) {
  const guard =
    stage === 'pre-push'
      ? `refs="$(cat)"
if command -v repo-require-worktree >/dev/null 2>&1; then
  printf '%s\\n' "$refs" | repo-require-worktree pushes
fi`
      : `if command -v repo-require-worktree >/dev/null 2>&1; then repo-require-worktree commits; fi`;
  return `#!/bin/sh
# ${MANAGED_NOTE}
set -e

# The public repo-tools worktree guard, guarded with command -v so a machine
# without the package still commits and pushes.
${guard}
`;
}

export function renderAgentsSection() {
  return `${AGENTS_BEGIN}

## Agent fleet membership

This repository is a member of the Agent LCARS fleet. The fleet's conventions
live in [jlapenna/agent-lcars](https://github.com/jlapenna/agent-lcars) and are
deliberately not restated here. Headless dispatches read the shared contract
from the file exported as \`$AGENT_PROTOCOL_PATH\`; interactive authors can
consult Agent LCARS's \`docs/\` for the dispatch, credential, and
published-workflow contracts. Do not copy the shared protocol into this repo.

Git safety and PR delivery follow the \`worktree-hygiene\` and \`land-pr\`
skills in the public [jlapenna/repo-tools](${REPO_TOOLS_URL}) plugin. Do not
mirror their bodies locally; use the \`repo-*\` commands they describe. Keep
the primary checkout clean on \`main\`, author in a linked worktree, and run
this repository's own setup step in every new worktree before trusting its
hooks. Fleet \`fleet-*\` commands come from the fleet-tools package in
jlapenna/agent-lcars; hooks guard every invocation with \`command -v\`, so a
machine without the package degrades quietly.

Required checks on \`main\` are declared in \`infra/github-ruleset/main.tf\`
and applied by the Homelab executor, never by hand in the GitHub UI.

${AGENTS_END}`;
}

function guardrailHook(matcher) {
  return {
    matcher,
    hooks: [{ type: 'command', command: GUARDRAIL_COMMAND, timeout: 10 }],
  };
}

/** Merge the issue-workflow guardrail into a Claude or Codex hooks file. */
export function mergeGuardrailHooks(existingText, matcher, description) {
  let config = {};
  if (existingText) {
    try {
      config = JSON.parse(existingText);
    } catch {
      throw new OnboardError('Existing hooks file is not valid JSON');
    }
  }
  if (description && !config.description) config.description = description;
  config.hooks ??= {};
  const post = (config.hooks.PostToolUse ??= []);
  const present = post.some((entry) =>
    (entry.hooks ?? []).some((hook) => hook.command === GUARDRAIL_COMMAND),
  );
  if (!present) post.push(guardrailHook(matcher));
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function mergeAgentsSection(existingText, section) {
  const text = existingText ?? '';
  const start = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END);
  if (start !== -1 && end !== -1 && end > start)
    return text.slice(0, start) + section + text.slice(end + AGENTS_END.length);
  if (start !== -1 || end !== -1)
    throw new OnboardError('AGENTS.md has an unterminated fleet-onboard block');
  if (!text.trim()) return `# Agent guide\n\n${section}\n`;
  return `${text.replace(/\s*$/, '')}\n\n${section}\n`;
}

export function mergePreCommitConfig(existingText, rev) {
  if (!existingText) return renderPreCommitConfig(rev);
  if (existingText.includes(`repo: ${REPO_TOOLS_URL}`)) return existingText;
  const lines = existingText.split('\n');
  const index = lines.findIndex((line) => /^repos:\s*$/.test(line));
  if (index === -1)
    throw new OnboardError('.pre-commit-config.yaml has no top-level repos:');
  lines.splice(index + 1, 0, renderPreCommitBlock(rev));
  return lines.join('\n');
}

export function resolveRepoToolsRev(spec, exec = execFileSync) {
  if (spec.repoToolsRev) return spec.repoToolsRev;
  const output = exec('git', ['ls-remote', `${REPO_TOOLS_URL}.git`, 'main'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  const sha = output.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha ?? ''))
    throw new OnboardError(
      'Could not resolve jlapenna/repo-tools main; pass --repo-tools-rev',
    );
  return sha;
}

function detectHooks(target, spec) {
  if (spec.hooks !== 'auto') return spec.hooks;
  if (existsSync(path.join(target, '.pre-commit-config.yaml')))
    return 'pre-commit';
  if (existsSync(path.join(target, 'package.json'))) return 'husky';
  return 'pre-commit';
}

/**
 * Plan every target-repository file. Each entry carries the desired content
 * and an ownership rule:
 *   managed  — overwritten whenever the file carries the managed marker;
 *   seed     — written only when absent (Terraform- or operator-maintained);
 *   merge    — existing content is merged structurally.
 */
export function planScaffold(target, spec, { resolveRev } = {}) {
  const read = (file) => {
    const full = path.join(target, file);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  };
  const files = [
    {
      file: '.claude/settings.json',
      kind: 'merge',
      render: (text) => mergeGuardrailHooks(text, 'Bash'),
    },
    {
      file: '.codex/hooks.json',
      kind: 'merge',
      render: (text) =>
        mergeGuardrailHooks(
          text,
          '^Bash$',
          'Repository workflow reminders for agent sessions.',
        ),
    },
    {
      file: '.github/workflows/validate.yml',
      kind: 'managed',
      render: renderValidateWorkflow,
    },
    {
      file: '.github/workflows/gitleaks.yml',
      kind: 'managed',
      render: () => renderGitleaksWorkflow(spec),
    },
    {
      file: '.github/workflows/ruleset.yml',
      kind: 'managed',
      render: renderRulesetWorkflow,
    },
    {
      file: '.github/workflows/agent-automerge.yml',
      kind: 'managed',
      render: () => renderAutomergeWorkflow(spec),
    },
    {
      file: 'infra/github-ruleset/main.tf',
      kind: 'managed',
      render: () => renderRulesetMain(spec),
    },
    {
      file: 'infra/github-ruleset/README.md',
      kind: 'seed',
      render: () => renderRulesetReadme(spec),
    },
    {
      file: 'infra/github-ruleset/.terraform.lock.hcl',
      kind: 'seed',
      render: renderProviderLock,
    },
    {
      file: 'tools/github-ruleset-root.test.sh',
      kind: 'managed',
      render: () => renderRulesetRootTest(spec),
      mode: 0o755,
    },
    { file: 'renovate.json', kind: 'seed', render: renderRenovateConfig },
    {
      file: 'AGENTS.md',
      kind: 'merge',
      render: (text) => mergeAgentsSection(text, renderAgentsSection()),
    },
  ];
  if (spec.runnerLabel)
    files.push({
      file: '.github/actionlint.yaml',
      kind: 'managed',
      render: () => renderActionlintConfig(spec),
    });
  const hooks = detectHooks(target, spec);
  const notes = [];
  if (hooks === 'pre-commit') {
    const existing = read('.pre-commit-config.yaml');
    const needsRev = !existing || !existing.includes(`repo: ${REPO_TOOLS_URL}`);
    const rev = needsRev ? (resolveRev ?? resolveRepoToolsRev)(spec) : null;
    files.push({
      file: '.pre-commit-config.yaml',
      kind: 'merge',
      render: (text) => mergePreCommitConfig(text, rev),
    });
    notes.push(
      'Install both hook stages in the primary checkout and in every linked worktree: `pre-commit install --install-hooks -t pre-commit -t pre-push` (pre-commit >= 4.4.0).',
    );
  } else if (hooks === 'husky') {
    for (const stage of ['pre-commit', 'pre-push']) {
      const existing = read(`.husky/${stage}`);
      if (existing && !existing.includes('repo-require-worktree'))
        notes.push(
          `.husky/${stage} exists without the repo-require-worktree guard; add the guarded call from sprinkles' hook of the same name.`,
        );
      else if (!existing)
        files.push({
          file: `.husky/${stage}`,
          kind: 'seed',
          render: () => renderHuskyHook(stage),
          mode: 0o755,
        });
    }
    notes.push(
      'Wire Husky through package.json `prepare` and run `repo-install-husky-hooks` so linked worktrees keep the hooks.',
    );
  }

  const actions = [];
  for (const entry of files) {
    const existing = read(entry.file);
    const desired = entry.render(existing);
    let action;
    if (existing === null) action = 'create';
    else if (existing === desired) action = 'unchanged';
    else if (entry.kind === 'seed') action = 'keep';
    else if (entry.kind === 'merge') action = 'update';
    else if (existing.includes(MANAGED_MARKER)) action = 'update';
    else action = 'locally-owned';
    actions.push({ ...entry, existing, desired, action });
  }
  return { actions, notes, hooks };
}

export function applyScaffold(target, plan, { force = false, check = false }) {
  const results = [];
  for (const entry of plan.actions) {
    let action = entry.action;
    if (action === 'locally-owned' && force) action = 'force-update';
    const writes = ['create', 'update', 'force-update'].includes(action);
    if (writes && !check) {
      const full = path.join(target, entry.file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, entry.desired, { mode: entry.mode });
    }
    results.push({ file: entry.file, action, drift: writes });
  }
  return results;
}

// --- admit: this repository's own projections -----------------------------

const PROJECTIONS = {
  labels: 'config/github-labels.json',
  apphosting: 'apps/console/apphosting.yaml',
  audit: '.github/workflows/label-contract-audit.yml',
};

function envValue(text, variable) {
  const env = parseYaml(text).env ?? [];
  const entry = env.find((item) => item.variable === variable);
  if (!entry || typeof entry.value !== 'string')
    throw new OnboardError(`${variable} is missing from apphosting.yaml`);
  return entry.value;
}

/** Read every membership projection from the control plane's own files. */
export function readMembership(root) {
  const text = Object.fromEntries(
    Object.entries(PROJECTIONS).map(([key, file]) => [
      key,
      readFileSync(path.join(root, file), 'utf8'),
    ]),
  );
  const labels = Object.keys(JSON.parse(text.labels).repositories ?? {});
  const controlPlane = envValue(
    text.apphosting,
    'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
  )
    .split(',')
    .filter(Boolean);
  const watched = JSON.parse(
    envValue(text.apphosting, 'AGENT_LCARS_WATCHED_REPOS'),
  ).map((repo) => `${repo.owner}/${repo.name}`);
  const audit = (
    parseYaml(text.audit).jobs?.audit?.strategy?.matrix?.include ?? []
  ).map((entry) => entry.full_name);
  return { text, labels, controlPlane, watched, audit };
}

/** Repositories missing from at least one projection, keyed by projection. */
export function membershipGaps(membership) {
  const sets = {
    labels: membership.labels,
    controlPlane: membership.controlPlane,
    watched: membership.watched,
    audit: membership.audit,
  };
  const union = new Set(Object.values(sets).flat());
  const gaps = {};
  for (const [name, list] of Object.entries(sets)) {
    const missing = [...union].filter((repo) => !list.includes(repo));
    if (missing.length) gaps[name] = missing;
  }
  return gaps;
}

function copyLabelEntry(text, like, repo) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `    "${like}": {`);
  if (start === -1)
    throw new OnboardError(`${like} has no entry in config/github-labels.json`);
  let end = start;
  while (end < lines.length && !/^ {4}\}(,?)$/.test(lines[end])) end++;
  if (end === lines.length)
    throw new OnboardError('Could not find the end of the label entry');
  const block = lines.slice(start, end + 1);
  block[0] = `    "${repo}": {`;
  block[block.length - 1] = '    }';
  // The repositories object closes with the first `  }` after the last entry.
  let close = end + 1;
  while (close < lines.length && lines[close] !== '  }') close++;
  if (close === lines.length)
    throw new OnboardError('Could not find the end of the repositories object');
  const last = close - 1;
  if (lines[last] !== '    }')
    throw new OnboardError('Unexpected label manifest layout');
  lines[last] = '    },';
  lines.splice(close, 0, ...block);
  return lines.join('\n');
}

function appendApphosting(text, spec) {
  const control = envValue(text, 'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES');
  const watched = envValue(text, 'AGENT_LCARS_WATCHED_REPOS');
  const nextControl = `${control},${spec.repo.full}`;
  const nextWatched = JSON.stringify([
    ...JSON.parse(watched),
    { owner: spec.repo.owner, name: spec.repo.name, alias: spec.alias },
  ]);
  const replaceValue = (source, previous, next) => {
    const needle = `value: '${previous}'`;
    if (!source.includes(needle))
      throw new OnboardError('apphosting.yaml value is not single-quoted');
    return source.replace(needle, `value: '${next}'`);
  };
  return replaceValue(
    replaceValue(text, control, nextControl),
    watched,
    nextWatched,
  );
}

function appendAuditMatrix(text, spec) {
  const lines = text.split('\n');
  let last = -1;
  lines.forEach((line, index) => {
    if (/^ {10}- full_name: /.test(line)) last = index;
  });
  if (last === -1 || !/^ {12}repository: /.test(lines[last + 2] ?? ''))
    throw new OnboardError('Unexpected label-contract-audit matrix layout');
  lines.splice(
    last + 3,
    0,
    `          - full_name: ${spec.repo.full}`,
    `            owner: ${spec.repo.owner}`,
    `            repository: ${spec.repo.name}`,
  );
  return lines.join('\n');
}

export function planAdmit(root, spec, like) {
  const membership = readMembership(root);
  const { text } = membership;
  const edits = [];
  if (!membership.labels.includes(spec.repo.full))
    edits.push({
      file: PROJECTIONS.labels,
      desired: copyLabelEntry(text.labels, like, spec.repo.full),
    });
  const inControl = membership.controlPlane.includes(spec.repo.full);
  const inWatched = membership.watched.includes(spec.repo.full);
  if (inControl !== inWatched)
    throw new OnboardError(
      `${spec.repo.full} is in only one of the two apphosting.yaml lists`,
    );
  if (!inControl)
    edits.push({
      file: PROJECTIONS.apphosting,
      desired: appendApphosting(text.apphosting, spec),
    });
  if (!membership.audit.includes(spec.repo.full))
    edits.push({
      file: PROJECTIONS.audit,
      desired: appendAuditMatrix(text.audit, spec),
    });
  return edits;
}

export function applyAdmit(root, edits, { check = false }) {
  if (!check)
    for (const edit of edits)
      writeFileSync(path.join(root, edit.file), edit.desired);
  return edits.map((edit) => edit.file);
}

// --- plan: the steps this tool cannot perform -----------------------------

export function renderPlan(spec) {
  const lane = spec.runnerLabel;
  const checks = spec.requiredChecks.map((c) => `\`${c}\``).join(', ');
  const parts = [
    `# Remaining onboarding steps for ${spec.repo.full}`,
    '',
    'Generated by tools/fleet-onboard.mjs. docs/onboarding-repo.md is the',
    'runbook; this list carries its repository-specific values.',
    '',
    '## 1. Target repository pull request',
    '',
    `- Review the scaffolded files, add the repository's own CI checks to the`,
    `  ruleset only once they emit stably, and merge. Required contexts: ${checks}.`,
    '- Set the repository variables and secret from the approved credential',
    '  environment (docs/fleet-credentials.md); never paste values into a log:',
    '',
    '  ```sh',
    `  gh variable set AGENT_BOT_LOGINS -R ${spec.repo.full} --body '<json array of bot logins>'`,
    `  gh variable set AGENT_FLEET_LOGIN -R ${spec.repo.full} --body '<fleet claim login>'`,
    `  gh variable set AGENT_LCARS_CLIENT_ID -R ${spec.repo.full} --body '<fleet App client id>'`,
    `  gh secret set AGENT_LCARS_PRIVATE_KEY -R ${spec.repo.full} < <private key file>`,
    '  ```',
    '',
    '## 2. GitHub App installations (maintainer, GitHub UI)',
    '',
    `- Add ${spec.repo.full} to the fleet App installation and the autoscaler`,
    '  App installation while retaining every existing repository.',
    '',
    '## 3. Homelab pull request (jlapenna/homelab)',
    '',
    `- \`bin/plan-fleet-github-ruleset.sh\`: add a \`${spec.repo.name})\` case with`,
    `  repository \`${spec.repo.full}\`, root \`infra/github-ruleset\`, and state`,
    `  prefix \`terraform/fleet-github-rulesets/${spec.repo.owner}-${spec.repo.name}\`.`,
    `- \`bin/check-drift.sh\`: add \`${spec.repo.name}\` to the fleet ruleset loop.`,
    `- \`observability/docker-compose.yml\`: append \`${spec.repo.full}\` to`,
    '  `GITHUB_REPOSITORIES` for the GitHub Actions exporter.',
  ];
  if (lane)
    parts.push(
      `- \`ansible/deploy_k3s.yml\`: add the \`${lane}\` ARC lane (next free`,
      '  node_port), then the matching Prometheus listener job, the',
      '  `ArcListenerMissing` alert term, and the installer-budget lane list.',
    );
  else
    parts.push(
      '- No dedicated ARC lane: glue and validation jobs run GitHub-hosted. Add',
      '  a lane later only when measured workload demands it.',
    );
  parts.push(
    '- After merge, the executor imports the live ruleset id into the isolated',
    '  state (or creates it) and applies the reviewed plan; record the id in',
    "  the target repository's infra/github-ruleset/README.md.",
    '',
    '## 4. Agent LCARS pull request (this repository)',
    '',
    `- \`node tools/fleet-onboard.mjs admit --repo ${spec.repo.full}\` (already`,
    '  applied if you ran it); merge after step 1 has landed on the target',
    "  repository's main. The console deploys from green CI on main.",
    '',
    '## 5. Audit, then prove with real work',
    '',
    '  ```sh',
    `  node tools/verify-onboarding.mjs --repo=${spec.repo.full}`,
    '  ```',
    '',
    '- Apply exactly one `agent:*` label to a real, suitably scoped issue and',
    '  follow docs/onboarding-repo.md section 6 for the evidence to record.',
    '',
  );
  return parts.join('\n');
}

// --- CLI -------------------------------------------------------------------

const USAGE = `usage:
  fleet-onboard.mjs scaffold --repo OWNER/NAME --target DIR [--runner-label L]
      [--ci-workflow FILE --ci-checks "A,B" [--ci-workflow-name NAME]]
      [--hooks auto|pre-commit|husky|none] [--repo-tools-rev SHA]
      [--check] [--force]
  fleet-onboard.mjs admit --repo OWNER/NAME [--alias NAME] [--like OWNER/NAME] [--check]
  fleet-onboard.mjs plan --repo OWNER/NAME [--runner-label L] [--ci-workflow FILE --ci-checks "A,B"]
  fleet-onboard.mjs check          # every membership projection agrees`;

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      target: { type: 'string' },
      alias: { type: 'string' },
      like: { type: 'string', default: 'jlapenna/sync-padd' },
      'runner-label': { type: 'string' },
      'ci-workflow': { type: 'string' },
      'ci-workflow-name': { type: 'string' },
      'ci-checks': { type: 'string' },
      hooks: { type: 'string' },
      'repo-tools-rev': { type: 'string' },
      check: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return { command: positionals[0], options: values };
}

export function main(argv, { root, log = console.log } = {}) {
  const { command, options } = parseCli(argv);
  if (options.help || !command) {
    log(USAGE);
    return options.help ? 0 : 64;
  }
  if (command === 'check') {
    const gaps = membershipGaps(readMembership(root));
    if (!Object.keys(gaps).length) {
      log('fleet membership projections agree');
      return 0;
    }
    for (const [projection, repos] of Object.entries(gaps))
      log(`MISSING\t${projection}\t${repos.join(',')}`);
    return 1;
  }
  const spec = resolveSpec(options);
  if (command === 'scaffold') {
    if (!options.target) throw new OnboardError('--target is required');
    const target = path.resolve(options.target);
    if (!existsSync(target))
      throw new OnboardError(`target directory does not exist: ${target}`);
    const plan = planScaffold(target, spec);
    const results = applyScaffold(target, plan, options);
    for (const result of results) log(`${result.action}\t${result.file}`);
    for (const note of plan.notes) log(`note\t${note}`);
    const drift = results.some((result) => result.drift);
    if (options.check) return drift ? 1 : 0;
    log(`\n${renderPlan(spec)}`);
    return 0;
  }
  if (command === 'admit') {
    const edits = planAdmit(root, spec, options.like);
    for (const file of applyAdmit(root, edits, options))
      log(`${options.check ? 'missing' : 'update'}\t${file}`);
    if (!edits.length) log(`${spec.repo.full} is already admitted`);
    return options.check && edits.length ? 1 : 0;
  }
  if (command === 'plan') {
    log(renderPlan(spec));
    return 0;
  }
  log(USAGE);
  return 64;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    process.exitCode = main(process.argv.slice(2), { root });
  } catch (error) {
    if (error instanceof OnboardError) {
      console.error(`fleet-onboard: ${error.message}`);
      process.exitCode = 2;
    } else throw error;
  }
}
