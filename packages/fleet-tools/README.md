# fleet-tools

`@agent-lcars/agent-tools`: the single source of the `fleet-*` commands that
fleet member repositories' agent hooks call, plus the dispatched-worker policy
modules the runner image uses. Member repositories do not vendor these files;
their hooks invoke the commands from `PATH` behind `command -v`, so a machine
without the package degrades quietly.

## Installing

- Workstations install it globally from `main`:

  ```bash
  pnpm add -g "github:jlapenna/agent-lcars#main&path:packages/fleet-tools"
  ```

  Reinstall to pick up changes; nothing updates it automatically.

- The runner image copies this directory from its fresh-`main` checkout to
  `/opt/agent-tools` and runs `npm install -g /opt/agent-tools`
  (`apps/runner-autoscaler/runner-image/Dockerfile`).

`tests/package-install.test.sh` checks that a global install materializes every
declared bin, omits `fleet-identity` from `bin/`, and keeps `fleet-identity.cjs`
beside the guardrail that requires it.

## Commands

| Command                       | Source                          | What it does                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet-claude-agent-session`  | `bin/claude-agent-session.sh`   | `resume-archive <gs://...jsonl \| run-id>` downloads one archived QueueExecutor Claude transcript into the current checkout's `~/.claude/projects/<slug>/` and prints the `claude --resume` command. Needs `gcloud`; `CLAUDE_AGENT_TRANSCRIPTS_BUCKET` overrides the bucket. Refuses to overwrite a differing file.                                       |
| `fleet-codex-issue-guardrail` | `bin/codex-issue-guardrail.cjs` | Claim guardrail that member repositories register as a `PostToolUse` hook in `.claude/settings.json` and `.codex/hooks.json`. Only in a fleet dispatch (`LCARS_RUN_ID` or `AGENT_DISPATCH_CONTEXT` set), it inspects `gh issue view`/`edit` commands and adds context when an issue is not assigned to the fleet login or, for `edit`, is already closed. |

`bin/fleet-identity.cjs` is an internal helper module rather than an installed
command: it exports `fleetLogin()` (`AGENT_FLEET_LOGIN`, default
`agent-lcars-bot`) and `DEFAULT_FLEET_LOGIN` for `codex-issue-guardrail.cjs` and
`worker-policy.cjs`.

## Worker policy modules

The `bin/worker-*` files are not exposed as commands. The runner image's
`runtime/worker-policy-bootstrap.sh` runs `worker-hook-setup.cjs` to register
the dispatched-worker `PreToolUse` policy for each provider
(`worker-policy.cjs`, through `worker-hook-bridge.cjs` or the OpenCode plugin
`worker-opencode-plugin.mjs`), bind the provider session (`worker-session.cjs`,
`worker-opencode-session.mjs`), and check review state (`worker-review.cjs`).
`worker-readiness.cjs` evaluates offline canary evidence. Their contract tests
live in `tools/contract-tests/worker-*.test.ts`.

The image always ships these modules, but enforcement is rolled out per
provider for legacy direct-runner Jobs: the trusted autoscaler forwards its
`LCARS_WORKER_POLICY_PROVIDERS` setting (comma-separated `claude`, `codex`,
`opencode`, `agy`) to those Jobs, and the bootstrap registers the policy only
when the run's pipeline is listed. Unset or empty skips registration entirely.
Declared-runtime Jobs use a separate environment and do not receive this
setting. An executor that launches direct-runner Jobs refuses to start when
the setting holds an unknown provider name, before any Job is attempted
([runner-autoscaler README](../../apps/runner-autoscaler/README.md)).
