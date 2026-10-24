#!/usr/bin/env node
// Fleet onboarding scaffolder. Generates the target repository's fleet
// surface, admits the repository into this control plane's configuration,
// and prints the remaining operator steps. docs/onboarding-repo.md owns the
// runbook; this tool owns the repetitive file edits it used to prescribe by
// hand. It never touches GitHub, credentials, or Homelab.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parse as parseYaml } from 'yaml';

export const MANAGED_MARKER = 'fleet-onboard: managed';
const MANAGED_NOTE = `${MANAGED_MARKER} by jlapenna/agent-lcars tools/fleet-onboard.mjs. Re-run it to refresh; delete this line to own the file locally.`;
export const GUARDRAIL_COMMAND =
  'guard=$(command -v fleet-codex-issue-guardrail || true); if [ -n "$guard" ]; then fleet-codex-issue-guardrail; fi; exit 0';
// Every shape the fleet guardrail hook has shipped as (an in-repo
// tools/codex-issue-guardrail.cjs, the packaged bin, or the PATH command).
// A hook matching this is the same guardrail and is replaced, never doubled.
const LEGACY_GUARDRAIL = /codex-issue-guardrail/;
export const BASELINE_CHECKS = Object.freeze([
  'gitleaks',
  'validate / repository validation',
  'repository-owned Terraform',
]);
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const AGENTS_BEGIN = '<!-- fleet-onboard:begin -->';
const AGENTS_END = '<!-- fleet-onboard:end -->';
const REPO_TOOLS_URL = 'https://github.com/jlapenna/repo-tools';
const REPO_TOOLS_PACKAGE = '@jlapenna/repo-tools';
const REPO_TOOLS_TAG_SPEC = /^github:jlapenna\/repo-tools#v\d+\.\d+\.\d+$/;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
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

// A comma list, a repeated option (array), or nothing.
function splitList(value) {
  return []
    .concat(value ?? [])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

// A YAML single-quoted scalar; the only escape is a doubled apostrophe.
function yamlSingleQuoted(text) {
  return `'${text.replace(/'/g, "''")}'`;
}

function jsonArray(values) {
  return yamlSingleQuoted(JSON.stringify(values));
}

// Required-check contexts are embedded in HCL strings, a bash loop, and a
// YAML scalar; reject the characters that would change meaning in any of them.
function validateContext(context) {
  const control = [...context].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (control || /["\\]/.test(context) || /[$%]\{/.test(context))
    throw new OnboardError(
      `check name ${JSON.stringify(context)} may not contain double quotes, backslashes, control characters, or \${ / %{`,
    );
  return context;
}

function validateRunnerLabel(label) {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(label))
    throw new OnboardError(
      `--runner-label must be a scale-set name ([A-Za-z0-9][A-Za-z0-9_.-]*), got ${label}`,
    );
  return label;
}

/** Resolve the repository shape the generated files depend on. */
export function resolveSpec(options) {
  const repo = parseRepo(options.repo);
  const runnerLabel = options['runner-label']
    ? validateRunnerLabel(options['runner-label'])
    : null;
  const ciFiles = splitList(options['ci-workflow']);
  const ciNames = splitList(options['ci-workflow-name']);
  const ciChecks = splitList(options['ci-checks']).map(validateContext);
  if (ciChecks.length && !ciFiles.length)
    throw new OnboardError('--ci-checks requires --ci-workflow');
  if (ciNames.length && !ciFiles.length)
    throw new OnboardError('--ci-workflow-name requires --ci-workflow');
  if (ciNames.length && ciNames.length !== ciFiles.length)
    throw new OnboardError(
      `--ci-workflow-name names ${ciNames.length} workflows but --ci-workflow lists ${ciFiles.length}; give one name per workflow, in order`,
    );
  for (const file of ciFiles)
    if (file !== path.basename(file) || !/\.ya?ml$/.test(file))
      throw new OnboardError(
        `--ci-workflow must be a file name under .github/workflows, got ${file}`,
      );
  // A single unnamed workflow keeps the conventional default; scaffold reads
  // the real name: from the target when the file exists.
  const ciWorkflows = ciFiles.map((file, index) => ({
    file,
    name: ciNames[index] ?? (ciFiles.length === 1 ? 'CI' : null),
    explicit: index < ciNames.length,
  }));
  const requiredChecks = [...new Set([...BASELINE_CHECKS, ...ciChecks])];
  const hooks = options.hooks ?? 'auto';
  if (!['auto', 'pre-commit', 'husky', 'none'].includes(hooks))
    throw new OnboardError(`Unknown --hooks mode ${hooks}`);
  const defaultBranch = options['default-branch'] || 'main';
  if (!/^[\w][\w./-]*$/.test(defaultBranch) || defaultBranch.includes('..'))
    throw new OnboardError(
      `--default-branch must be a branch name, got ${defaultBranch}`,
    );
  return {
    repo,
    alias: options.alias || repo.name,
    runnerLabel,
    ciWorkflows,
    ciChecks,
    requiredChecks,
    hooks,
    repoToolsRev: options['repo-tools-rev'] || null,
    defaultBranch,
  };
}

// Fork pull requests cannot reach a self-hosted scale set, so every
// credential-free job falls back to GitHub-hosted runners for them.
function glueRunsOn(spec) {
  if (!spec.runnerLabel) return 'ubuntu-slim';
  return `\${{ (github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork) && 'ubuntu-slim' || '${spec.runnerLabel}' }}`;
}

// workflow_run.workflows entries are the `name:` of each workflow that posts
// a check on a PR head; they must match the generated workflows below.
export const GENERATED_WORKFLOW_NAMES = Object.freeze([
  'validate',
  'gitleaks',
  'ruleset',
]);

export function workflowRunNames(spec) {
  const names = spec.ciWorkflows.map((workflow) => {
    if (!workflow.name)
      throw new OnboardError(
        `.github/workflows/${workflow.file} needs --ci-workflow-name (its name: is only read when scaffold can see the target)`,
      );
    return workflow.name;
  });
  return [...new Set([...names, ...GENERATED_WORKFLOW_NAMES])];
}

function workflowRunList(spec) {
  const names = workflowRunNames(spec);
  return `[${names
    .map((name) => (/^[\w.-]+$/.test(name) ? name : JSON.stringify(name)))
    .join(', ')}]`;
}

export function renderValidateWorkflow(spec) {
  return `# ${MANAGED_NOTE}
name: validate

on:
  push:
    branches: [${spec.defaultBranch}]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/${spec.defaultBranch}' }}

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
    branches: [${spec.defaultBranch}]
  workflow_dispatch:

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  # PR revisions supersede each other, but every main revision must retain a
  # full-history scan: cancelling an earlier main run can leave a secret from
  # that commit outside the replacement run's diff range.
  cancel-in-progress: \${{ github.ref != 'refs/heads/${spec.defaultBranch}' }}

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

export function renderRulesetWorkflow(spec) {
  return `# ${MANAGED_NOTE}
name: ruleset

on:
  push:
    branches: [${spec.defaultBranch}]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/${spec.defaultBranch}' }}

jobs:
  terraform:
    name: repository-owned Terraform
    # Credential-free and takes seconds; keep it off any self-hosted pool.
    runs-on: ubuntu-slim
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7

      - uses: hashicorp/setup-terraform@${SETUP_TERRAFORM_PIN}
        with:
          terraform_version: ${TERRAFORM_VERSION}

      - name: Verify repository-owned Terraform
        run: |
          terraform -chdir=infra/github-ruleset init -backend=false -input=false -lockfile=readonly
          terraform -chdir=infra/github-ruleset fmt -check -recursive
          terraform -chdir=infra/github-ruleset validate
`;
}

export function renderAutomergeWorkflow(spec) {
  const runsOn = spec.runnerLabel ?? 'ubuntu-slim';
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
    branches: [${spec.defaultBranch}]
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

export function renderPreCommitBlock(rev, { item = '  ', inner } = {}) {
  const key = inner ?? `${item}  `;
  const step = key.slice(item.length) || '  ';
  return `${item}- repo: ${REPO_TOOLS_URL}
${key}rev: ${rev}
${key}hooks:
${key}${step}- id: repo-require-worktree
${key}${step}- id: repo-require-worktree-push
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
      # Content-rewriting hooks (trailing-whitespace, end-of-file-fixer) are
      # deliberately not seeded: they rewrite tracked artifacts such as
      # exported G-code or JSON summaries. Add them per repository.
      - id: check-yaml
      - id: check-added-large-files
`;
}

function huskyGuard(stage) {
  return stage === 'pre-push'
    ? `refs="$(cat)"
printf '%s\\n' "$refs" | repo-require-worktree pushes`
    : 'repo-require-worktree commits';
}

export function renderHuskyHook(stage) {
  return `#!/bin/sh
# ${MANAGED_NOTE}
set -e

# The public repo-tools worktree guard. Husky puts node_modules/.bin on PATH,
# and the ${REPO_TOOLS_PACKAGE} devDependency installs the command there, so a
# checkout missing it fails closed instead of skipping the guard.
${huskyGuard(stage)}
`;
}

/** The package manager whose lockfile the target already commits. */
export function dependencyInstallArgs(read) {
  if (read('pnpm-lock.yaml') !== null) return ['pnpm', 'install'];
  if (read('yarn.lock') !== null) return ['yarn', 'install'];
  if (read('bun.lock') !== null || read('bun.lockb') !== null)
    return ['bun', 'install'];
  return ['npm', 'install'];
}

/**
 * Add the repo-tools devDependency the Husky hooks run. An existing entry is
 * never rewritten; one that is not a release-tag pin is reported, because
 * Renovate only updates github: dependencies by tag.
 * Returns { text, note }.
 */
export function mergeRepoToolsDependency(existingText, rev) {
  let pkg;
  try {
    pkg = JSON.parse(existingText);
  } catch {
    return {
      text: existingText,
      note: `package.json is not valid JSON; add "${REPO_TOOLS_PACKAGE}": "github:jlapenna/repo-tools#<release tag>" to devDependencies by hand`,
    };
  }
  const current =
    pkg.devDependencies?.[REPO_TOOLS_PACKAGE] ??
    pkg.dependencies?.[REPO_TOOLS_PACKAGE];
  if (current !== undefined)
    return {
      text: existingText,
      note: REPO_TOOLS_TAG_SPEC.test(current)
        ? null
        : `package.json pins ${REPO_TOOLS_PACKAGE} to ${JSON.stringify(current)}, not a release tag; Renovate only updates tag pins, so change it to "github:jlapenna/repo-tools#<release tag>" by hand`,
    };
  const indent = existingText.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
  const devDependencies = {
    ...pkg.devDependencies,
    [REPO_TOOLS_PACKAGE]: `github:jlapenna/repo-tools#${rev}`,
  };
  const keys = Object.keys(pkg.devDependencies ?? {});
  const sorted = keys.every((key, i) => i === 0 || keys[i - 1] <= key);
  pkg.devDependencies = sorted
    ? Object.fromEntries(
        Object.entries(devDependencies).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      )
    : devDependencies;
  return {
    text: `${JSON.stringify(pkg, null, indent)}\n`,
    note: null,
  };
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
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new OnboardError('Existing hooks file is not a JSON object');
  if (description && !config.description) config.description = description;
  config.hooks ??= {};
  if (typeof config.hooks !== 'object' || Array.isArray(config.hooks))
    throw new OnboardError('Existing hooks file has a non-object "hooks"');
  const post = (config.hooks.PostToolUse ??= []);
  if (!Array.isArray(post))
    throw new OnboardError(
      'Existing hooks file has a non-array "hooks.PostToolUse"',
    );
  const isLegacy = (hook) =>
    typeof hook?.command === 'string' &&
    hook.command !== GUARDRAIL_COMMAND &&
    LEGACY_GUARDRAIL.test(hook.command);
  let present = post.some((entry) =>
    (entry?.hooks ?? []).some((hook) => hook?.command === GUARDRAIL_COMMAND),
  );
  // Replace the first legacy guardrail in place (keeping its matcher and any
  // sibling hooks) and drop every other copy, so a re-run converges on one.
  const emptied = new Set();
  for (const entry of post) {
    if (!Array.isArray(entry?.hooks)) continue;
    const before = entry.hooks.length;
    entry.hooks = entry.hooks.flatMap((hook) => {
      if (!isLegacy(hook)) return [hook];
      if (present) return [];
      present = true;
      return [{ ...hook, ...guardrailHook(matcher).hooks[0] }];
    });
    if (before > 0 && entry.hooks.length === 0) emptied.add(entry);
  }
  config.hooks.PostToolUse = post.filter((entry) => !emptied.has(entry));
  if (!present) config.hooks.PostToolUse.push(guardrailHook(matcher));
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function mergeAgentsSection(existingText, section) {
  const text = existingText ?? '';
  // Follow the file's own line endings so a CRLF file stays CRLF and the
  // drift check does not flip-flop between runs.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = section.replace(/\r?\n/g, eol);
  const begins = text.split(AGENTS_BEGIN).length - 1;
  const ends = text.split(AGENTS_END).length - 1;
  if (begins > 1 || ends > 1)
    throw new OnboardError(
      `AGENTS.md has ${Math.max(begins, ends)} fleet-onboard blocks; keep exactly one`,
    );
  const start = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END);
  if (start !== -1 && end !== -1 && end > start)
    return text.slice(0, start) + body + text.slice(end + AGENTS_END.length);
  if (start !== -1 || end !== -1)
    throw new OnboardError(
      `AGENTS.md has a broken fleet-onboard block: ${AGENTS_BEGIN} must come before ${AGENTS_END}, and both must be present`,
    );
  if (!text.trim()) return `# Agent guide${eol}${eol}${body}${eol}`;
  return `${text.replace(/\s*$/, '')}${eol}${eol}${body}${eol}`;
}

function hasRepoToolsHooks(text) {
  let parsed;
  try {
    parsed = parseYaml(text);
  } catch {
    return false;
  }
  return (parsed?.repos ?? []).some((entry) => entry?.repo === REPO_TOOLS_URL);
}

const REPO_TOOLS_HOOK_IDS = Object.freeze([
  'repo-require-worktree',
  'repo-require-worktree-push',
]);

/**
 * An existing repo-tools entry is not enough: a repository that adopted
 * repo-tools for another hook, or only the commit guard, still lacks the
 * push guard. Complete the entry in place and re-parse to prove it.
 */
export function ensureRepoToolsHookIds(text) {
  const hookIds = (parsed) =>
    (Array.isArray(parsed?.repos) ? parsed.repos : [])
      .find((item) => item?.repo === REPO_TOOLS_URL)
      ?.hooks?.map((hook) => hook?.id)
      .filter(Boolean) ?? null;
  let parsed;
  try {
    parsed = parseYaml(text);
  } catch {
    throw new OnboardError('.pre-commit-config.yaml does not parse as YAML');
  }
  const present = hookIds(parsed);
  if (present === null)
    throw new OnboardError(
      '.pre-commit-config.yaml mentions repo-tools without a repos entry for it; add the entry by hand',
    );
  const missing = REPO_TOOLS_HOOK_IDS.filter((id) => !present.includes(id));
  if (!missing.length) return text;
  const lines = text.split('\n');
  const start = lines.findIndex(
    (line) =>
      /^\s*-\s+repo:/.test(line) && line.includes(`repo: ${REPO_TOOLS_URL}`),
  );
  if (start === -1)
    throw new OnboardError(
      '.pre-commit-config.yaml repo-tools entry has an unexpected layout; add the guard hooks by hand',
    );
  const itemIndent = lines[start].match(/^(\s*)-/)[1];
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trim().startsWith('#')) {
      const indent = line.match(/^\s*/)[0];
      if (indent.length <= itemIndent.length) break;
    }
    end++;
  }
  const hooksOffset = lines
    .slice(start + 1, end)
    .findIndex((line) => /^\s*hooks:\s*(\[\]\s*)?(#.*)?$/.test(line));
  const insertion = [];
  let insertAt;
  let hookIndent = `${itemIndent}    `;
  if (hooksOffset === -1) {
    insertion.push(`${itemIndent}  hooks:`);
    insertAt = end;
    while (insertAt > start + 1 && !lines[insertAt - 1].trim()) insertAt--;
  } else {
    const hooksLine = start + 1 + hooksOffset;
    lines[hooksLine] = lines[hooksLine].replace(/\[\]\s*/, '');
    const firstHook = lines
      .slice(hooksLine + 1, end)
      .find((line) => /^\s*-\s+id:/.test(line));
    if (firstHook) hookIndent = firstHook.match(/^(\s*)-/)[1];
    insertAt = hooksLine + 1;
    for (let i = hooksLine + 1; i < end; i++)
      if (lines[i].trim()) insertAt = i + 1;
  }
  for (const id of missing) insertion.push(`${hookIndent}- id: ${id}`);
  lines.splice(insertAt, 0, ...insertion);
  const merged = lines.join('\n');
  let check = null;
  try {
    check = hookIds(parseYaml(merged));
  } catch {
    check = null;
  }
  if (!REPO_TOOLS_HOOK_IDS.every((id) => check?.includes(id)))
    throw new OnboardError(
      '.pre-commit-config.yaml repo-tools entry could not be completed automatically; add repo-require-worktree and repo-require-worktree-push by hand',
    );
  return merged;
}

export function mergePreCommitConfig(existingText, rev) {
  if (!existingText) return renderPreCommitConfig(rev);
  if (existingText.includes(`repo: ${REPO_TOOLS_URL}`))
    return ensureRepoToolsHookIds(existingText);
  const lines = existingText.split('\n');
  const index = lines.findIndex((line) => /^repos:(\s|$)/.test(line));
  if (index === -1)
    throw new OnboardError(
      '.pre-commit-config.yaml has no top-level repos: list; add one (or pass --hooks none) and re-run',
    );
  const inline = lines[index]
    .replace(/^repos:/, '')
    .replace(/#.*$/, '')
    .trim();
  if (inline && inline !== '[]')
    throw new OnboardError(
      '.pre-commit-config.yaml repos: is not a block list; convert it and re-run',
    );
  // Match the existing list's indentation: YAML rejects sibling sequence
  // items at different indents. `repos: []` becomes a block list.
  let indent = {};
  if (inline === '[]') lines[index] = 'repos:';
  else {
    const first = lines
      .slice(index + 1)
      .find((line) => line.trim() && !line.trim().startsWith('#'));
    const item = first?.match(/^(\s*)- /)?.[1];
    if (item === undefined)
      throw new OnboardError(
        '.pre-commit-config.yaml repos: is not a block list; convert it and re-run',
      );
    const firstIndex = lines.indexOf(first);
    const inner = lines
      .slice(firstIndex + 1)
      .find((line) => line.trim() && !line.trim().startsWith('#'))
      ?.match(/^(\s+)\S/)?.[1];
    indent = {
      item,
      inner: inner && inner.length > item.length ? inner : null,
    };
    if (indent.inner === null) delete indent.inner;
  }
  lines.splice(
    index + 1,
    0,
    renderPreCommitBlock(rev, indent).replace(/\n$/, ''),
  );
  const merged = lines.join('\n');
  if (!hasRepoToolsHooks(merged))
    throw new OnboardError(
      '.pre-commit-config.yaml merge did not parse back as YAML; add the repo-tools hooks by hand',
    );
  return merged;
}

/** The highest vX.Y.Z tag in `git ls-remote --tags` output, or null. */
export function latestReleaseTag(lsRemoteOutput) {
  const versions = lsRemoteOutput
    .split('\n')
    .map((line) => line.split('\t')[1]?.trim() ?? '')
    // Annotated tags list a peeled ^{} line too; the tag ref itself suffices.
    .filter((ref) => ref.startsWith('refs/tags/') && !ref.endsWith('^{}'))
    .map((ref) => ref.slice('refs/tags/'.length))
    .map((tag) => ({
      tag,
      parts: tag.match(RELEASE_TAG)?.slice(1).map(Number),
    }))
    .filter(({ parts }) => parts);
  versions.sort(
    (a, b) =>
      b.parts[0] - a.parts[0] ||
      b.parts[1] - a.parts[1] ||
      b.parts[2] - a.parts[2],
  );
  return versions[0]?.tag ?? null;
}

/**
 * The repo-tools revision new pins use: the latest release tag, because
 * Renovate updates github: and pre-commit pins only by tag.
 */
export function resolveRepoToolsRev(spec, exec = execFileSync) {
  if (spec.repoToolsRev) return spec.repoToolsRev;
  let output;
  try {
    output = exec(
      'git',
      ['ls-remote', '--tags', `${REPO_TOOLS_URL}.git`, 'v*'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
      },
    );
  } catch (error) {
    throw new OnboardError(
      `Could not list jlapenna/repo-tools release tags (${error.message}); pass --repo-tools-rev`,
    );
  }
  const tag = latestReleaseTag(String(output));
  if (!tag)
    throw new OnboardError(
      'jlapenna/repo-tools has no vX.Y.Z release tag; pass --repo-tools-rev',
    );
  return tag;
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
const TERRAFORM_IGNORE = 'infra/github-ruleset/.terraform/';

/** Ensure the ruleset root's provider cache is ignored. */
export function mergeGitignore(existingText) {
  const text = existingText ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const covered = new Set([
    TERRAFORM_IGNORE,
    TERRAFORM_IGNORE.replace(/\/$/, ''),
    `/${TERRAFORM_IGNORE}`,
    '.terraform/',
    '.terraform',
    '**/.terraform/',
    '**/.terraform',
  ]);
  if (text.split(/\r?\n/).some((line) => covered.has(line.trim()))) return text;
  if (!text.trim()) return `${TERRAFORM_IGNORE}${eol}`;
  return `${text.replace(/\s*$/, '')}${eol}${TERRAFORM_IGNORE}${eol}`;
}

function parseWorkflow(text) {
  try {
    return parseYaml(text) ?? {};
  } catch {
    return null;
  }
}

// The check name a job posts: its `name:` or its key. A reusable-workflow job
// posts `<key> / <inner job name>` instead, which callers below special-case.
function jobCheckNames(doc) {
  return Object.entries(doc?.jobs ?? {}).map(([key, job]) => job?.name ?? key);
}

/**
 * A locally owned workflow still has to produce what the generated ruleset
 * requires and what agent-automerge subscribes to; otherwise merging the
 * scaffold locks main. Returns a reason string or null.
 */
function workflowConflict(text, expectedName, emits) {
  const doc = parseWorkflow(text);
  if (!doc) return 'is not valid YAML';
  const problems = [];
  const name = doc.name ?? null;
  if (name !== expectedName)
    problems.push(
      `workflow name is ${JSON.stringify(name)} but agent-automerge's workflow_run trigger lists ${JSON.stringify(expectedName)}`,
    );
  if (emits && !emits.test(doc))
    problems.push(
      `no job posts the required check ${JSON.stringify(emits.context)}`,
    );
  return problems.length ? problems.join('; ') : null;
}

function automergeConflict(text, spec) {
  const doc = parseWorkflow(text);
  if (!doc) return 'is not valid YAML';
  const problems = [];
  let required = null;
  try {
    required = JSON.parse(
      doc.jobs?.automerge?.with?.['required-checks'] ?? 'null',
    );
  } catch {
    required = null;
  }
  const missing = spec.requiredChecks.filter((c) => !required?.includes(c));
  if (!Array.isArray(required) || missing.length)
    problems.push(
      `required-checks does not include ${JSON.stringify(missing.length ? missing : spec.requiredChecks)}`,
    );
  const subscribed = doc.on?.workflow_run?.workflows ?? [];
  const unsubscribed = workflowRunNames(spec).filter(
    (n) => !subscribed.includes(n),
  );
  if (unsubscribed.length)
    problems.push(
      `workflow_run.workflows does not list ${JSON.stringify(unsubscribed)}`,
    );
  return problems.length ? problems.join('; ') : null;
}

function rulesetMainConflict(text, spec) {
  const missing = spec.requiredChecks.filter(
    (context) => !text.includes(`context = "${context}"`),
  );
  return missing.length
    ? `does not require ${JSON.stringify(missing)}, which agent-automerge expects`
    : null;
}

// --check must stay offline: when the hook block is absent the file drifts
// whatever the revision would be, so no lookup is needed to decide.
const UNRESOLVED_REV = '<unresolved: --check does not resolve repo-tools>';

export function planScaffold(target, spec, { resolveRev, check = false } = {}) {
  const read = (file) => {
    const full = path.join(target, file);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  };
  const notes = [];
  const ciJobs = [];
  let sawCiFile = false;
  const ciWorkflows = spec.ciWorkflows.map((workflow) => {
    const file = `.github/workflows/${workflow.file}`;
    const text = read(file);
    if (text === null) {
      if (!workflow.name)
        throw new OnboardError(
          `${file} does not exist; pass --ci-workflow-name for it so agent-automerge's workflow_run trigger has a name to subscribe to`,
        );
      notes.push(
        `${file} does not exist yet; its name: must be ${JSON.stringify(workflow.name)} for agent-automerge's workflow_run trigger to fire.`,
      );
      return workflow;
    }
    const doc = parseWorkflow(text);
    if (!doc) throw new OnboardError(`${file} is not valid YAML`);
    sawCiFile = true;
    ciJobs.push(...Object.keys(doc.jobs ?? {}), ...jobCheckNames(doc));
    const actual = doc.name ?? null;
    if (workflow.explicit && actual !== workflow.name)
      throw new OnboardError(
        `${file} is named ${JSON.stringify(actual)}, not ${JSON.stringify(workflow.name)}; agent-automerge's workflow_run trigger would never fire`,
      );
    if (!actual)
      throw new OnboardError(
        `${file} has no name:; agent-automerge's workflow_run trigger subscribes by workflow name`,
      );
    return { ...workflow, name: actual };
  });
  spec = { ...spec, ciWorkflows };
  if (sawCiFile) {
    const ciFiles = spec.ciWorkflows.map((w) => w.file).join(', ');
    for (const check of spec.ciChecks)
      if (!ciJobs.includes(check))
        notes.push(
          `--ci-checks ${JSON.stringify(check)} is not a job id or name in ${ciFiles}; the ruleset will wait on a check that never posts.`,
        );
    // sync-padd runs its Terraform job inside CI; a generated ruleset.yml
    // would then post a second check run under the same name.
    for (const context of BASELINE_CHECKS)
      if (ciJobs.includes(context))
        notes.push(
          `${ciFiles} already posts the check ${JSON.stringify(context)}; the generated fleet workflow posts it too. Remove the local job, or delete the generated file's managed line to own that check locally.`,
        );
  }
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
      render: () => renderValidateWorkflow(spec),
      conflict: (text) =>
        workflowConflict(text, 'validate', {
          context: 'validate / repository validation',
          test: (doc) =>
            String(doc.jobs?.validate?.uses ?? '').includes(
              'jlapenna/agent-lcars/.github/workflows/repo-validation.yml',
            ),
        }),
    },
    {
      file: '.github/workflows/gitleaks.yml',
      kind: 'managed',
      render: () => renderGitleaksWorkflow(spec),
      conflict: (text) =>
        workflowConflict(text, 'gitleaks', {
          context: 'gitleaks',
          test: (doc) => jobCheckNames(doc).includes('gitleaks'),
        }),
    },
    {
      file: '.github/workflows/ruleset.yml',
      kind: 'managed',
      render: () => renderRulesetWorkflow(spec),
      conflict: (text) =>
        workflowConflict(text, 'ruleset', {
          context: 'repository-owned Terraform',
          test: (doc) =>
            jobCheckNames(doc).includes('repository-owned Terraform'),
        }),
    },
    {
      file: '.github/workflows/agent-automerge.yml',
      kind: 'managed',
      render: () => renderAutomergeWorkflow(spec),
      conflict: (text) => automergeConflict(text, spec),
    },
    {
      file: 'infra/github-ruleset/main.tf',
      kind: 'managed',
      render: () => renderRulesetMain(spec),
      conflict: (text) => rulesetMainConflict(text, spec),
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
    { file: 'renovate.json', kind: 'seed', render: renderRenovateConfig },
    { file: '.gitignore', kind: 'merge', render: mergeGitignore },
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
      conflict: (text) =>
        (parseWorkflow(text)?.['self-hosted-runner']?.labels ?? []).includes(
          spec.runnerLabel,
        )
          ? null
          : `self-hosted-runner.labels does not declare ${spec.runnerLabel}`,
    });
  const hooks = detectHooks(target, spec);
  if (hooks === 'pre-commit') {
    const existing = read('.pre-commit-config.yaml');
    const needsRev = !existing || !existing.includes(`repo: ${REPO_TOOLS_URL}`);
    if (!needsRev) {
      const current = parseYaml(existing)?.repos?.find(
        (entry) => entry?.repo === REPO_TOOLS_URL,
      )?.rev;
      if (!RELEASE_TAG.test(String(current ?? '')))
        notes.push(
          `.pre-commit-config.yaml pins repo-tools to ${JSON.stringify(current ?? null)}, not a release tag; Renovate only updates tag pins, so change rev to a vX.Y.Z release tag by hand.`,
        );
    }
    let rev = null;
    if (needsRev)
      rev = check
        ? spec.repoToolsRev || UNRESOLVED_REV
        : (resolveRev ?? resolveRepoToolsRev)(spec);
    files.push({
      file: '.pre-commit-config.yaml',
      kind: 'merge',
      render: (text) => mergePreCommitConfig(text, rev),
    });
    if (!existing)
      notes.push(
        'Seeded .pre-commit-config.yaml without content-rewriting hooks (trailing-whitespace, end-of-file-fixer); add them only after confirming no tracked artifact would be rewritten.',
      );
    notes.push(
      'Install both hook stages in the primary checkout and in every linked worktree: `pre-commit install --install-hooks -t pre-commit -t pre-push` (pre-commit >= 4.4.0).',
    );
  } else if (hooks === 'husky') {
    for (const stage of ['pre-commit', 'pre-push']) {
      const existing = read(`.husky/${stage}`);
      if (existing && !existing.includes('repo-require-worktree'))
        notes.push(
          `.husky/${stage} exists without the repo-require-worktree guard; add this call to it: ${huskyGuard(stage).replace(/\n/g, '; ')}`,
        );
      // A locally owned guarded hook is reported as unchanged; a managed one
      // is refreshed so earlier command -v guarded copies fail closed.
      else
        files.push({
          file: `.husky/${stage}`,
          kind: 'merge',
          render: (text) =>
            text && !text.includes(MANAGED_MARKER)
              ? text
              : renderHuskyHook(stage),
          mode: 0o755,
        });
    }
    const pkgText = read('package.json');
    if (pkgText !== null) {
      const needsRev =
        mergeRepoToolsDependency(pkgText, UNRESOLVED_REV).text !== pkgText;
      let rev = null;
      if (needsRev)
        rev = check
          ? spec.repoToolsRev || UNRESOLVED_REV
          : (resolveRev ?? resolveRepoToolsRev)(spec);
      const { note } = mergeRepoToolsDependency(pkgText, rev);
      if (note) notes.push(note);
      files.push({
        file: 'package.json',
        kind: 'merge',
        render: (text) => mergeRepoToolsDependency(text, rev).text,
      });
      if (needsRev)
        notes.push(
          `Added ${REPO_TOOLS_PACKAGE} to package.json devDependencies; run \`${dependencyInstallArgs(read).join(' ')}\` and commit the lockfile, or the Husky hooks fail closed because repo-require-worktree is not installed.`,
        );
    } else
      notes.push(
        `No package.json; Husky hooks need ${REPO_TOOLS_PACKAGE} as a devDependency (github:jlapenna/repo-tools#<release tag>) to find repo-require-worktree.`,
      );
    let hasPrepare;
    try {
      hasPrepare = Boolean(
        JSON.parse(read('package.json') ?? '{}')?.scripts?.prepare,
      );
    } catch {
      hasPrepare = false;
    }
    if (!hasPrepare)
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
    const conflict =
      action === 'locally-owned' && entry.conflict
        ? entry.conflict(existing)
        : null;
    actions.push({ ...entry, existing, desired, action, conflict });
  }
  return { actions, notes, hooks, spec };
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
      // writeFileSync applies mode only on create; a refreshed script must
      // stay executable.
      if (entry.mode !== undefined) chmodSync(full, entry.mode);
    }
    results.push({
      file: entry.file,
      action,
      drift: writes,
      // --force rewrites the file, which resolves the conflict.
      conflict: writes ? null : (entry.conflict ?? null),
    });
  }
  return results;
}

// --- admit: this repository's own projections -----------------------------

const PROJECTIONS = {
  labels: 'config/github-labels.json',
  apphosting: 'apps/console/apphosting.yaml',
  audit: '.github/workflows/label-contract-audit.yml',
  variables: 'config/github-variables.json',
};

function envValue(text, variable) {
  const env = parseYaml(text).env ?? [];
  const entry = env.find((item) => item.variable === variable);
  if (!entry || typeof entry.value !== 'string')
    throw new OnboardError(`${variable} is missing from apphosting.yaml`);
  return entry.value;
}

/** Parse every membership projection from its file text. */
export function parseMembership(text) {
  const labels = Object.keys(JSON.parse(text.labels).repositories ?? {});
  const variables = Object.values(JSON.parse(text.variables).profiles).flatMap(
    (profile) => profile.repositories,
  );
  const controlPlane = envValue(
    text.apphosting,
    'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
  )
    .split(',')
    .filter(Boolean);
  const watchedEntries = JSON.parse(
    envValue(text.apphosting, 'AGENT_LCARS_WATCHED_REPOS'),
  );
  const watched = watchedEntries.map((repo) => `${repo.owner}/${repo.name}`);
  const audit = (
    parseYaml(text.audit).jobs?.audit?.strategy?.matrix?.include ?? []
  ).map((entry) => entry.full_name);
  return {
    text,
    labels,
    controlPlane,
    watched,
    watchedEntries,
    audit,
    variables,
  };
}

/** Read every membership projection from the control plane's own files. */
export function readMembership(root) {
  return parseMembership(
    Object.fromEntries(
      Object.entries(PROJECTIONS).map(([key, file]) => [
        key,
        readFileSync(path.join(root, file), 'utf8'),
      ]),
    ),
  );
}

/** Repositories missing from at least one projection, keyed by projection. */
export function membershipGaps(membership) {
  const sets = {
    labels: membership.labels,
    controlPlane: membership.controlPlane,
    watched: membership.watched,
    audit: membership.audit,
    variables: membership.variables,
  };
  const union = new Set(Object.values(sets).flat());
  const gaps = {};
  for (const [name, list] of Object.entries(sets)) {
    const missing = [...union].filter((repo) => !list.includes(repo));
    if (missing.length) gaps[name] = missing;
  }
  return gaps;
}

// Brace depth of one line with string contents blanked out.
function braceDelta(line) {
  const bare = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let delta = 0;
  for (const char of bare) {
    if (char === '{' || char === '[') delta++;
    else if (char === '}' || char === ']') delta--;
  }
  return delta;
}

const LABEL_LAYOUT_HINT =
  'copy the template entry by hand in config/github-labels.json (one "OWNER/NAME": { ... } entry per line-delimited block under "repositories")';

/**
 * Copy one repository's block under "repositories" to a new key, preserving
 * the file's formatting. The manifest is prettier-formatted JSON whose short
 * arrays are inline, so a parse/re-serialize round trip would reformat it;
 * instead the copy is line-based and then verified structurally.
 */
function copyLabelEntry(text, like, repo) {
  const parsed = JSON.parse(text);
  const repositories = parsed.repositories ?? {};
  if (!(like in repositories))
    throw new OnboardError(
      `${like} has no entry in config/github-labels.json (pass --like with an onboarded repository)`,
    );
  const lines = text.split('\n');
  const open = lines.findIndex((line) =>
    /^\s*"repositories":\s*\{\s*$/.test(line),
  );
  if (open === -1)
    throw new OnboardError(
      `Unexpected label manifest layout; ${LABEL_LAYOUT_HINT}`,
    );
  const entries = [];
  let depth = 0;
  let close = -1;
  let current = null;
  for (let index = open; index < lines.length; index++) {
    const line = lines[index];
    const key =
      depth === 1 && line.match(/^(\s*)"((?:[^"\\]|\\.)*)":\s*\{\s*$/);
    if (key) current = { key: key[2], indent: key[1], start: index };
    depth += braceDelta(line);
    if (depth === 1 && current && index > current.start) {
      entries.push({ ...current, end: index });
      current = null;
    }
    if (depth === 0) {
      close = index;
      break;
    }
  }
  const template = entries.find((entry) => entry.key === like);
  const last = entries.at(-1);
  if (close === -1 || !template || !last)
    throw new OnboardError(
      `Unexpected label manifest layout; ${LABEL_LAYOUT_HINT}`,
    );
  const block = lines.slice(template.start, template.end + 1);
  block[0] = `${template.indent}"${repo}": {`;
  block[block.length - 1] = block[block.length - 1].replace(/,\s*$/, '');
  if (!/,\s*$/.test(lines[last.end])) lines[last.end] = `${lines[last.end]},`;
  lines.splice(last.end + 1, 0, ...block);
  const merged = lines.join('\n');
  let check;
  try {
    check = JSON.parse(merged);
  } catch {
    throw new OnboardError(
      `Label manifest edit did not parse as JSON; ${LABEL_LAYOUT_HINT}`,
    );
  }
  const expected = {
    ...parsed,
    repositories: { ...repositories, [repo]: repositories[like] },
  };
  if (JSON.stringify(check) !== JSON.stringify(expected))
    throw new OnboardError(
      `Label manifest edit changed more than the new entry; ${LABEL_LAYOUT_HINT}`,
    );
  return merged;
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
    const parts = source.split(needle);
    if (parts.length !== 2)
      throw new OnboardError(
        parts.length === 1
          ? 'apphosting.yaml value is not single-quoted'
          : 'apphosting.yaml value appears more than once',
      );
    // Join rather than String.replace: a replacement string would interpret
    // `$&`, `$1`, and `$'` sequences inside the JSON.
    return parts.join(`value: '${next}'`);
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
  const next = { ...text };
  const edits = [];
  if (!membership.labels.includes(spec.repo.full)) {
    next.labels = copyLabelEntry(text.labels, like, spec.repo.full);
    edits.push({ file: PROJECTIONS.labels, desired: next.labels });
  }
  const inControl = membership.controlPlane.includes(spec.repo.full);
  const inWatched = membership.watched.includes(spec.repo.full);
  if (inControl !== inWatched)
    throw new OnboardError(
      `${spec.repo.full} is in only one of the two apphosting.yaml lists`,
    );
  // Aliases must stay unique across the watched list; an already watched
  // repository keeps whatever alias it has.
  const collision = membership.watchedEntries.find(
    (entry) =>
      entry.alias === spec.alias &&
      `${entry.owner}/${entry.name}` !== spec.repo.full,
  );
  if (!inControl && collision)
    throw new OnboardError(
      `alias ${spec.alias} is already used by ${collision.owner}/${collision.name}; pass a distinct --alias`,
    );
  if (!inControl) {
    next.apphosting = appendApphosting(text.apphosting, spec);
    edits.push({ file: PROJECTIONS.apphosting, desired: next.apphosting });
  }
  if (!membership.audit.includes(spec.repo.full)) {
    next.audit = appendAuditMatrix(text.audit, spec);
    edits.push({ file: PROJECTIONS.audit, desired: next.audit });
  }
  if (!membership.variables.includes(spec.repo.full)) {
    const manifest = JSON.parse(text.variables);
    const repositories = manifest.profiles?.['fleet-member']?.repositories;
    if (!Array.isArray(repositories))
      throw new OnboardError(
        'github-variables.json has no fleet-member repository list',
      );
    repositories.push(spec.repo.full);
    next.variables = `${JSON.stringify(manifest, null, 2)}\n`;
    edits.push({ file: PROJECTIONS.variables, desired: next.variables });
  }
  // Every edit is textual; prove the result still parses and now agrees.
  const gaps = membershipGaps(parseMembership(next));
  if (Object.keys(gaps).length)
    throw new OnboardError(
      `admit would leave projections disagreeing: ${JSON.stringify(gaps)}`,
    );
  return edits;
}

export function applyAdmit(root, edits, { check = false }) {
  if (!check)
    for (const edit of edits)
      writeFileSync(path.join(root, edit.file), edit.desired);
  return edits.map((edit) => edit.file);
}

// --- plan: the steps this tool cannot perform -----------------------------

export function renderPlan(spec, plan = null) {
  const lane = spec.runnerLabel;
  const code = (value) => `\`${value}\``;
  const checks = spec.requiredChecks.map(code).join(', ');
  const parts = [
    `# Remaining onboarding steps for ${spec.repo.full}`,
    '',
    'Generated by tools/fleet-onboard.mjs. docs/onboarding-repo.md is the',
    'runbook; this list carries its repository-specific values.',
    '',
    '## 1. Target repository pull request',
    '',
  ];
  if (spec.ciChecks.length)
    parts.push(
      `- Review the scaffolded files and merge. Required contexts: ${checks}`,
      `  (repository CI checks included: ${spec.ciChecks.map(code).join(', ')}).`,
    );
  else
    parts.push(
      `- Review the scaffolded files, add the repository's own CI checks to the`,
      `  ruleset only once they emit stably, and merge. Required contexts: ${checks}.`,
    );
  parts.push(
    `- agent-automerge subscribes to workflow_run from: ${workflowRunNames(spec).map(code).join(', ')}.`,
  );
  const conflicts = (plan?.actions ?? []).filter((action) => action.conflict);
  const locallyOwned = (plan?.actions ?? []).filter(
    (action) => action.action === 'locally-owned' && !action.conflict,
  );
  if (conflicts.length)
    parts.push(
      '- CONFLICTS: these locally owned files do not match what the generated',
      '  ruleset requires or what agent-automerge must subscribe to; merging',
      '  as-is can lock main or strand green PRs. Re-run with `--force`, or',
      '  rename/retarget the local file and re-run:',
      ...conflicts.map((a) => `  - ${code(a.file)}: ${a.conflict}`),
    );
  if (locallyOwned.length)
    parts.push(
      `- Left untouched (no ${code(MANAGED_MARKER)} line): ${locallyOwned.map((a) => code(a.file)).join(', ')}.`,
    );
  if (
    plan?.hooks === 'pre-commit' &&
    plan.actions.some(
      (a) => a.file === '.pre-commit-config.yaml' && a.action === 'create',
    )
  )
    parts.push(
      '- The seeded pre-commit config has no content-rewriting hooks; add',
      '  trailing-whitespace/end-of-file-fixer only if no tracked artifact',
      '  would be rewritten.',
    );
  parts.push(
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
  );
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
      [--ci-workflow FILE[,FILE] [--ci-workflow-name NAME[,NAME]] --ci-checks "A,B"]
      [--hooks auto|pre-commit|husky|none] [--repo-tools-rev TAG]
      [--default-branch NAME] [--check] [--force]
  fleet-onboard.mjs admit --repo OWNER/NAME [--alias NAME] [--like OWNER/NAME] [--check]
  fleet-onboard.mjs plan --repo OWNER/NAME [--runner-label L]
      [--ci-workflow FILE --ci-workflow-name NAME --ci-checks "A,B"]
  fleet-onboard.mjs check          # every membership projection agrees

--ci-workflow may be repeated or comma-separated; each workflow's name: joins
agent-automerge's workflow_run list (scaffold reads it from the target when
the file exists). Exit codes: 0 ok, 1 drift (--check) or conflicts, 2 usage
or input error, 64 unknown command.`;

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
      'ci-workflow': { type: 'string', multiple: true },
      'ci-workflow-name': { type: 'string', multiple: true },
      'ci-checks': { type: 'string' },
      hooks: { type: 'string' },
      'repo-tools-rev': { type: 'string' },
      'default-branch': { type: 'string' },
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
    const plan = planScaffold(target, spec, { check: options.check });
    const results = applyScaffold(target, plan, options);
    for (const result of results) {
      log(`${result.action}\t${result.file}`);
      if (result.conflict) log(`conflict\t${result.file}\t${result.conflict}`);
    }
    for (const note of plan.notes) log(`note\t${note}`);
    const drift = results.some((result) => result.drift);
    const conflicts = results.some((result) => result.conflict);
    if (options.check) return drift || conflicts ? 1 : 0;
    log(`\n${renderPlan(plan.spec, plan)}`);
    return conflicts ? 1 : 0;
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

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
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
