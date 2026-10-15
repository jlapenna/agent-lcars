# Onboard a repository to the agent fleet

Use this runbook to add a repository to Agent LCARS. It is the entry point
for the whole process: console discovery, QueueExecutor capacity, GitHub Apps,
repository integration, and an end-to-end dispatch.

`tools/fleet-onboard.mjs` owns the repetitive file edits this runbook used to
prescribe by hand. It edits files in a checkout and prints the remaining
operator steps with the repository's values filled in; it never touches
GitHub, credentials, Homelab, or Terraform state. Homelab-side and GitHub-side
helpers for those remaining steps are being added in parallel; until they
land, follow the procedures in steps 2 and 3 below and, for the Homelab half,
"Onboarding or changing a repository" in `jlapenna/homelab`'s
`terraform/README.md`.

This runbook deliberately coordinates the focused runbooks rather than
copying them. Those documents own their domains and should be updated there
when the underlying system changes:

- [Console and telemetry onboarding](onboarding-console-and-telemetry.md) —
  protocol, telemetry, console configuration, and the telemetry IAM boundary.
- [Fleet credentials](fleet-credentials.md) — credential ownership, minting,
  and centrally owned Codex authentication.
- [Published actions](published-actions.md) — supported reusable workflows
  and composite actions.

## At a glance

One command runs the repository-change steps end to end:

```sh
node tools/fleet-onboard-run.mjs --repo OWNER/NAME \
  [--runner-label NAME-default] [--ci-workflow ci.yml --ci-checks "A,B"] \
  [--copy-from OWNER/MEMBER] [--homelab ../homelab] [--dry-run]
```

It scaffolds the target repository and opens its draft PR, opens this
repository's admission PR and Homelab's membership PR, then runs the
GitHub-side helper (`tools/fleet-onboard-github.mjs`) for variables, the
secret, the App-installation check, and labels. Every step is idempotent: an
open PR on the step's branch counts as done, so a rerun resumes. It leaves
the App installations and the Homelab Terraform apply to a human and prints
them. The numbered steps below are what it does, and how to do each by hand.

Run the commands from a dedicated worktree of this repository. Each step
links to the section that owns its policy and evidence.

1. **Scaffold** the target repository's fleet surface —
   `node tools/fleet-onboard.mjs scaffold --repo OWNER/NAME --target ../NAME`
   ([step 1](#1-bootstrap-the-target-repository)).
2. **Target PR merges** — review the generated files, open the target
   repository PR, and confirm its `main` carries the merged contract
   ([step 1](#1-bootstrap-the-target-repository)).
3. **Homelab PR** — `node tools/fleet-onboard.mjs plan --repo OWNER/NAME`
   lists the Homelab edits; capacity and ruleset execution stay with
   `jlapenna/homelab` ([step 2](#2-give-it-runner-capacity)).
4. **App installations and variables** — maintainer adds the repository to
   both GitHub App installations in the GitHub UI and provisions the
   variables and secret the plan output names
   ([step 3](#3-install-both-github-apps-and-provision-variables)).
5. **Admit** — `node tools/fleet-onboard.mjs admit --repo OWNER/NAME`, then
   `node tools/fleet-onboard.mjs check`; open and merge this repository's PR
   only after the target PR has landed
   ([step 4](#4-add-the-repository-to-agent-lcars)).
6. **Audit** — `node tools/verify-onboarding.mjs --repo=OWNER/NAME` from the
   approved credential environment
   ([step 5](#5-audit-setup-before-dispatch)).
7. **Prove** — label exactly one real issue `agent:*` and record the
   evidence ([step 6](#6-prove-the-complete-path)).
8. **Qualify** — run the full audit with existing maintainer and actual
   registration identities, retaining every fact as the final setup record
   ([step 7](#7-complete-the-authoritative-onboarding-audit)).

### Operations beyond the scaffolder

The scaffolder edits files only. A repository-onboarding request also authorizes
the necessary account, credential and infrastructure operations below; do not
ask for a separate maintainer approval. Use the owning workflows and preserve
unrelated access and resources:

- **GitHub App installations.** Adding the repository to the fleet and
  autoscaler App installations uses a supported GitHub credential or the
  signed-in App-installation UI. A missing credential or sign-in is a
  capability blocker, not an additional approval requirement (step 3).
- **Variable and secret provisioning.** Values come from the existing
  credential environment described in [fleet credentials](fleet-credentials.md)
  and are set with `gh variable set` / `gh secret set`; the plan output
  prints the commands with placeholders, never values (step 3).
- **Terraform import and apply.** Homelab's executor imports the live
  ruleset id into the repository's isolated state and applies the reviewed
  plan through the central workflow (step 2).
- **Lane capacity decisions.** Whether the repository needs a dedicated ARC
  lane, and sizing it, is a measured Homelab decision, not a scaffold
  default (step 2).

## What “onboarded” means

A repository is onboarded only when all of the following are true:

1. The fleet and autoscaler GitHub Apps can access the repository.
2. QueueExecutor's shared direct-runner pool has capacity for its agent
   runs, and, if its own CI uses self-hosted runners, a Homelab-owned ARC
   runner scale set accepts those jobs.
3. The repository has its label and local-instruction contract.
4. The console knows to watch the repository and QueueExecutor can report its
   telemetry.
5. A real issue dispatch reaches QueueExecutor and leaves useful,
   inspectable evidence.

Merging configuration or seeing a green check is not sufficient evidence
on its own.

## Before you start

Choose the owner, repository, and first provider(s). Confirm the repo is not
already covered by the relevant GitHub App installations, console config, or
autoscaler registration. Reuse the shared runner image and start with one
general-purpose pool unless measured workload needs a separate pool.

This work normally spans three independent changes:

| Surface           | Owner              | Outcome                                                    |
| ----------------- | ------------------ | ---------------------------------------------------------- |
| Agent LCARS       | this repository    | Console discovery, labels, and QueueExecutor authorization |
| Homelab           | `jlapenna/homelab` | QueueExecutor capacity and any approved infrastructure     |
| Target repository | new repository     | Labels, hooks, configuration, and validation               |

Use a dedicated worktree for every repository change. Complete the operational
steps needed for the requested onboarding through their owning workflows;
inspect plans and keep changes within that scope. Do not add another approval
gate. Never print, commit, or paste a credential value into an issue, PR,
terminal log, or chat.

**Order matters: configure the target repository (step 1) before admitting it
to the control plane (step 4).** Admission lets the Console turn the
repository's webhook events into QueueExecutor work. There are no target
repository agent workflow callers.

## 1. Bootstrap the target repository

Generate the repository's fleet surface with the scaffolder instead of
copying files from the last onboarded repository:

```sh
node tools/fleet-onboard.mjs scaffold --repo OWNER/NAME --target ../NAME \
  [--runner-label NAME-default] \
  [--ci-workflow ci.yml --ci-checks "Check A,Check B" [--ci-workflow-name CI]] \
  [--hooks auto|pre-commit|husky|none] [--repo-tools-rev TAG] \
  [--check] [--force]
```

### What the scaffolder generates

This is the one list of generated files; later steps refer back to it rather
than restating it.

- `.claude/settings.json` and `.codex/hooks.json`: the issue-workflow
  guardrail hook, merged into any existing hook configuration.
- `.github/workflows/validate.yml`, `gitleaks.yml`, `ruleset.yml`, and
  `agent-automerge.yml`: thin callers of the published reusable workflows
  (`repo-validation` and App-token `agent-automerge`), plus the repository's
  secret scan and ruleset plan.
- `infra/github-ruleset/main.tf`: the repository-owned ruleset root carrying
  the baseline required checks (`gitleaks`,
  `validate / repository validation`, `repository-owned Terraform`) plus any
  `--ci-checks`; `infra/github-ruleset/README.md` and
  `.terraform.lock.hcl` are seeded once.
- `repo-require-worktree` wiring: a `.pre-commit-config.yaml` block
  pinned to `--repo-tools-rev` (the latest `jlapenna/repo-tools` `vX.Y.Z`
  release tag when omitted), or, for Node repositories, `.husky/pre-commit`
  and `.husky/pre-push` hooks plus a `@jlapenna/repo-tools` devDependency
  pinned to that tag. The hooks call the guard unconditionally, so a checkout
  without the devDependency installed fails closed; run the package manager
  install after scaffolding. Renovate updates both pins by tag. `--hooks`
  overrides the auto-detection; the tool prints the install note for the
  mechanism it chose.
  Existing pre-commit revisions are preserved; branch/SHA revisions are reported
  for manual migration to release tags. The automated onboarding wrapper runs
  the detected package manager before committing a changed package manifest,
  and stops before commit/push when installation fails.
- `renovate.json`: seeded once, extending the repo-tools preset.
- `AGENTS.md`: a marker-delimited fleet-membership section merged into the
  existing file.
- `.github/actionlint.yaml`: only with `--runner-label`, declaring that
  label under `self-hosted-runner.labels`.

Ownership rule: a generated file carries a `fleet-onboard: managed` line and
is refreshed on re-run. A file without that line is reported as locally
owned and left alone unless `--force` is given; delete the line to own a
file locally. Seeded files are created once and then kept; merged files are
updated in place. `--check` reports drift without writing and exits nonzero
when any file would change. Without `--runner-label`, glue and validation
jobs run GitHub-hosted and no Homelab lane is needed.

After writing, the tool prints the `plan` output for this repository: the
remaining operator steps with its values filled in. Keep that output for
steps 2 through 5.

### Review the generated files before opening the PR

Open a target-repository PR for its label, hook, validation, and local
instruction contract; do not vendor fleet execution implementation. The
scaffolder covers the items below; review its output against them rather
than re-deriving them by hand.

- The thin `agent-automerge` and `repo-validation` callers. Keep repository
  validation runnable on GitHub-hosted runners so it can establish a
  baseline before self-hosted capacity is healthy. The repository's runner
  scale-set labels must be declared under `self-hosted-runner.labels` in
  `.github/actionlint.yaml`; repository validation uses that list to reject
  `self-hosted` paired with a scale-set label. App-enabled `agent-automerge`
  callers get event triggers and at most a daily backstop.
- `.github/workflows/gitleaks.yml` must exist before the `gitleaks` context
  is made required. It follows homelab's pinned, full-history scanner shape:
  read-only `contents` and `pull-requests` permissions, `fetch-depth: 0`, a
  named `gitleaks` job, and a bounded timeout. Its workflow must run on pull
  requests and pushes to `main`; retain every `main` scan while cancelling
  superseded pull-request scans. Use the repository's approved runner and
  scanner integration, then prove the check appears on this bootstrap PR.
- The issue-workflow guardrail hook in `.claude/settings.json` and
  `.codex/hooks.json`, and the `repo-require-worktree` check in the
  repository's Git hook mechanism. The published workflow documentation owns
  the exact supported caller shapes.
- `AGENTS.md` links to the shared fleet protocol and distinguishes
  fleet-specific commands from public `repo-tools` commands; it must not
  copy either instruction set into the repository.
- Add the repository's own CI checks to the ruleset only once they emit
  stably, using the exact, case-sensitive contexts observed on successful
  default-branch runs (`--ci-workflow`/`--ci-checks`, or edit the managed
  root and re-run `--check`).
- Do not add a project `opencode.json` unless a setting is genuinely local to
  that repository. The shared runner image already supplies its fleet-wide
  OpenCode configuration.

For provider telemetry and its evidence, follow the separate [console and
telemetry onboarding](onboarding-console-and-telemetry.md) runbook.

Merge this PR — and confirm the target repository's `main` branch carries the
merged label and instruction contract — before admitting it to the Console.

## 2. Give it runner capacity

`node tools/fleet-onboard.mjs plan --repo OWNER/NAME [--runner-label L]`
prints the Homelab edits for this repository: the
`bin/plan-fleet-github-ruleset.sh` allowlist case with its repository-owned
root and isolated state prefix, the `bin/check-drift.sh` fleet ruleset loop,
the GitHub Actions exporter's `GITHUB_REPOSITORIES` list, and whether a
dedicated lane is requested. Open one `jlapenna/homelab` PR with those edits.
The import, plan review, apply, and post-apply verification procedure for the
ruleset is owned by "Onboarding or changing a repository" in that
repository's `terraform/README.md`.

Every GitHub Actions runner lane runs on Actions Runner Controller (k3s),
owned and deployed by `jlapenna/homelab` (homelab#1623); `apps/runner-autoscaler`
in this repo no longer manages GitHub scale-set runner registrations, only the
LCARS QueueExecutor's shared direct-runner pool. Confirm QueueExecutor's
shared runner pool has capacity for the target repository's work, and provision
a dedicated ARC lane in `jlapenna/homelab` only when measured workload
duration or isolation demands it. Register the repository's ruleset with
homelab's `protect-main` policy as well: new repositories carry the
scaffolded repository-owned root and are added to the central executor's
allowlist. Every repository starts with required `gitleaks` and
`validate / repository validation` checks: secret scanning is the fleet's
minimum security baseline, and a reusable validation workflow has no consumer
until its result blocks merges. It must also retain linear history, protection
against force-push and deletion, and required review-thread resolution.
Inspect and apply the scoped Terraform plan through the central executor.
After the executor applies, record the live ruleset id in the target
repository's `infra/github-ruleset/README.md`.

The registration uses the autoscaler GitHub App, not the fleet App. Its App
key belongs in the homelab encrypted secret store; it never belongs in this
repository or the target repository. After the homelab change deploys, verify
the real listener is polling for the new scale set. A configuration merge or
healthy container alone does not prove registration coverage.

## 3. Install both GitHub Apps and provision variables

Use a supported credential or the signed-in GitHub App-installation UI to add
the target repository to both installations:

- **Fleet App**: QueueExecutor dispatch authorization, claims, comments, pull
  requests, labels, and console reads.
- **Autoscaler App**: ARC runner registration and scale-set listener
  (deployed by Homelab).

Use least privilege: add the target repository while retaining the
installation's other approved repositories. The selected-repository list is
the installation's complete access set, so replacing it with just the new
repository would silently revoke access from existing fleet members. Verify
membership with an installation token and `/installation/repositories` rather
than assuming that an account-wide installation includes it. The exact App
identifiers and installation guidance live in
[fleet credentials](fleet-credentials.md).

Provision the target repository's variables and secret from the approved
credential environment. The plan output prints the baseline
`gh variable set` and `gh secret set` commands (`AGENT_BOT_LOGINS`,
`AGENT_FLEET_LOGIN`, `AGENT_LCARS_CLIENT_ID`, `AGENT_LCARS_PRIVATE_KEY`) with
placeholders; [fleet credentials](fleet-credentials.md) owns the complete
list, including provider credentials, and the fan-out loop for the fleet App
key. Never paste a value into a command line, log, PR, or chat.

## 4. Add the repository to Agent LCARS

Open one PR in this repository to make the control plane recognize the new
repository:

```sh
node tools/fleet-onboard.mjs admit --repo OWNER/NAME [--alias NAME] [--like OWNER/NAME]
node tools/fleet-onboard.mjs check
```

`admit` makes all four edits below, copying the standard member label
profile (`--like` names a different member to copy from). `check`, and the
`fleet-onboard` contract test on every CI run, fail when any projection of
fleet membership disagrees with the others; `admit --check` reports the
projections a repository is missing from without writing.

- The repository’s label manifest in `config/github-labels.json`, using
  the fleet’s standard `type:*`, `status:*`, `agent:*`, and `review:*` labels.
- Both console settings in `apps/console/apphosting.yaml`:
  `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` and
  `AGENT_LCARS_WATCHED_REPOS`. The repository name is its console alias
  unless a distinct human-facing alias is needed (`--alias`). `admit`
  refuses to proceed when a repository is already in only one of the two
  lists; repair that by hand first.
- The matrix in `.github/workflows/label-contract-audit.yml`; a manifest
  entry without this matrix entry will not be reconciled.
- The `fleet-member` repository list in `config/github-variables.json`, so
  the onboarding audit recognizes the repository's shared variable contract.

The normal deployment path deploys the console after green CI on `main`.
Do not run a direct deploy merely to accelerate this step. Do this step only
after step 1 has merged and landed on the target repository's `main` — see
"Order matters" above.

## 5. Audit setup before dispatch

Run `node tools/verify-onboarding.mjs` with `APP_CLIENT_ID`,
`APP_PRIVATE_KEY`, and `AGENT_FLEET_LOGIN` supplied by the approved credential
environment. Do not paste credentials into commands or logs. Use
`--repo=OWNER/REPO` to narrow repository checks, or `--registrations=PATH` to
read an operator-supplied registration configuration. The default watches the
console's actual repository list and reads Homelab's legacy
`github-runner-autoscaler/orchestrator.yml` through the GitHub API; it does not
copy the registration list or import Homelab source code. That file now owns
QueueExecutor, not ARC registrations. If it contains no active registrations,
the audit emits `registrations/configuration: unverifiable`, explicitly reporting
that runner coverage was not audited. An empty or entirely disabled operator
inventory produces the same result; a green workflow is not complete coverage.

For ARC runner-scope checks, an operator must supply current registration data
from Homelab in the accepted format: `registrations` entries with `name`,
`github.url`, and resolved `app.client_id` / `app.installation_id`. Homelab's
public listener-routing lane list alone is insufficient: it does not carry the
App identity. Supplying this inventory verifies the named targets only; it
does not establish inventory completeness, live listener polling, or deployment.

The tool emits one JSON result per repository and setup fact: App installation,
fleet-login push permission and assignability, declared label metadata,
required variables, required-check contexts, and registration runner-list
scope. It only reads configuration. The only non-GET requests mint temporary
read-permission installation tokens and revoke them afterward. Values of
variables, private keys, tokens, and raw GitHub error bodies are not reported.
Label repair remains the separate, explicit label-sync operation.

`config/github-variables.json` classifies every variable referenced by this
repository's workflows. The other fleet profiles specify their shared inputs;
they do not replace each member repository's application-specific configuration
contract. Required values are checked through the published `assert-repo-vars`
implementation. Required check names and App identities come from the effective
default-branch rules and are compared with checks/statuses observed on its
current head. A head whose CI has not emitted every context yet needs a repeat
after CI completes; this audit does not wait for CI or grade check conclusions.

`pass` means that particular setup fact was observed. `fail` identifies a
measured mismatch or operational error. `unverifiable` means the necessary
access, identity, inventory, or completed CI evidence was unavailable. GitHub
403 and 404 responses are unverifiable because they can hide resources from
the current identity; they never establish a pass. Rate limits (including
403 with exhausted quota or Retry-After), invalid authentication, server errors,
and token-revocation failures remain failures. Only `fail` produces a nonzero
exit; an all-unverifiable run is successful execution with zero verified facts.
For every run, retain the per-fact statuses rather than treating green workflow
conclusion as full onboarding qualification. In particular,
the legacy root autoscaler registration gets its App identity from deployment
environment variables. Its identity cannot be established from the committed
YAML alone. Supply its resolved registration metadata and its actual App
credential for that check; another App's successful runner-list response is
not evidence for it. No private-key file referenced by registration YAML is
opened by this tool. Record per-fact results when registrations use different
Apps, rather than treating one credential's audit as complete fleet coverage.

At onboarding, `AUDIT_READ_TOKEN` supplies the existing maintainer credential
for repository variables and rules/check metadata (see the final step below). All use of that token is GET-only; installation,
claim permission, labels, and runner scope still use the actual fleet or
runner App. This avoids granting administrative visibility to the fleet App
solely for auditing. For the autoscaler App, supply `RUNNER_APP_CLIENT_ID` and
`RUNNER_APP_PRIVATE_KEY` separately. Resolve the legacy registration identity
from deployment into `LEGACY_RUNNER_APP_CLIENT_ID` and
`LEGACY_RUNNER_APP_INSTALLATION_ID`, or supply resolved `app` metadata in the
operator configuration file. These identifiers must describe the actual
registration, not whichever credential happens to be available.
Missing optional credentials and authorization gaps are emitted as
`unverifiable` facts without failing the workflow; only an observed mismatch or
operational request failure is `fail`.

The `Fleet onboarding audit` workflow runs daily, on demand, and after changes
to its local configuration sources. It uses the existing fleet App credential;
an unavailable permission or different registration App remains a reported gap,
not an automatic permission grant. Rerun after changes to watched repositories,
App permissions, registration configuration, or rulesets. A configuration audit
does not establish that committed configuration is deployed or that a real
dispatch works.

The scheduled and manual workflow accepts the optional repository variable
`ONBOARDING_AUDIT_REGISTRATIONS` containing the resolved registration YAML.
The approved Homelab ARC apply produces
`github-runner-autoscaler/.arc-registration-audit.yml` beside its accepted
`.arc-lanes.applied.yml` receipt; see the
[Homelab input owner](https://github.com/jlapenna/homelab/blob/main/github-runner-autoscaler/README.md#resolved-arc-onboarding-input).
After an approved apply, an operator can copy that public identity projection
into the variable. Refresh it after each accepted lane/App identity change;
a source merge alone does not create a deployed receipt. The workflow validates the nonempty allowlisted identity shape, rejects duplicate
lane names and extra fields (including private keys), and passes the value as data through a private temporary file to `--registrations=PATH`
and removes the file on exit. An unset variable preserves the default
configuration lookup and its explicit coverage gap. A supplied empty or
invalid inventory cannot silently fall back to that lookup. GitHub may display public step environment values in its run log. Keep private
keys out of this inventory. This transport does not authenticate the declared App;
runner scope still requires its separately supplied actual credential.
Publishing the public inventory remains an operator action. Reuse existing
identities; do not provision another unattended credential or widen App grants
for this audit.

The scheduled workflow uses only the existing Fleet App client ID and private
key, minting temporary read-only installation tokens within its existing grants.
It does not use a maintainer metadata token or a separate runner private key.
Facts outside that identity's visibility remain `unverifiable`. A registration
belonging to another App cannot be authenticated by substituting the Fleet App.
These visibility gaps are expected schedule results, not requests to provision
new credentials. The full audit at onboarding is authoritative for them.

## 6. Prove the complete path

Use a real, suitably scoped issue rather than a synthetic success check.

1. Apply exactly one `agent:*` routing label for an enabled lane.
2. Confirm the Console shows the QueueExecutor run and its dispatch marker;
   there is no target-repository provider workflow to inspect.
3. Confirm the agent acknowledges and reports through the shared protocol:
   claim, progress, handoff/parking when needed, and a durable deliverable.
4. Confirm the console shows the provider-appropriate telemetry and final
   archive after the run; do not treat an absent GitHub Actions workflow as a
   failure because none is dispatched.
5. If a provider is intentionally not credentialed yet, record its first named
   QueueExecutor failure as the known dark state. Do not call it onboarded for
   that provider until its credential and dispatch are proven.

## 7. Complete the authoritative onboarding audit

As the final setup step, run the same verifier from the approved maintainer
credential environment with the existing maintainer credential available as
`AUDIT_READ_TOKEN`. Keep the actual Fleet App environment from step 5 for
installation, login, and label facts. Supply the accepted Homelab registration
receipt and, when its identity differs from the Fleet App, its **existing**
`RUNNER_APP_CLIENT_ID` / `RUNNER_APP_PRIVATE_KEY` environment. Do not copy these
credentials into Actions or add App permissions. No registration credential
file named by the YAML is read automatically.

```bash
# Existing approved credentials are already in the environment; no values in
# shell history or logs. gh uses the existing maintainer login for this command.
AUDIT_READ_TOKEN="$(gh auth token)" \
  node tools/verify-onboarding.mjs --registrations=/path/to/accepted-registration-receipt.yml
```

Run this on the completed default-branch CI head. Preserve all per-repository
and per-registration JSON facts. Repeat the audit after adding a watched repo
or changing App permissions, registration identities, or rulesets. Every fact
must be `pass` for complete qualification; `unverifiable` explicitly records
what remains unproven even when the command exits zero. Resolve a measured
`fail` through its owning setup path; no repair mode is provided. If the
existing maintainer or actual registration identity still cannot read a fact,
record that exact gap rather than treating the scheduled job as its proof.

Before closing the onboarding work, record the audit results, links to the
three PRs, their merged commits, the App-membership verification,
QueueExecutor-capacity evidence, Console admission, and the test dispatch.
State which providers are fully live, which are intentionally dark, and any
maintainer-owned follow-up.

This evidence makes the next repository onboarding faster without turning an
old rollout's incidental identifiers into a new repository's instructions.
