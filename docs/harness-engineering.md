# Maintaining the Agent LCARS harness

The harness is the context, tools, execution environment, and feedback around
the selected coding agent. Maintain it against a concrete LCARS job: an agent
must find the owning contract, perform authorized work, and produce evidence
that answers the request. A documentation edit establishes guidance; its effect
on later workers requires observed use.

This is Agent LCARS's local application of Ryan Lopopolo's
[Harness Engineering field guide](https://github.com/lopopolo/harness-engineering)
and [original essay](https://openai.com/index/harness-engineering/).
The field guide was read at revision
[`226c8d35`](https://github.com/lopopolo/harness-engineering/tree/226c8d35fb6ea3ed55467753dba6dea2b5fd5778).
Its [application playbooks](https://github.com/lopopolo/harness-engineering/blob/226c8d35fb6ea3ed55467753dba6dea2b5fd5778/playbooks/README.md)
are editorial syntheses with stated validation limits. The procedures below
are local policy choices, not claims that those playbooks have been validated
here. Repository contracts and the user's authorization govern their use.

## Retrieve the local quality bar

Start with [AGENTS.md](../AGENTS.md), then the task's owner in
[ARCHITECTURE.md](../ARCHITECTURE.md) and [the documentation map](README.md).
Recover implicit requirements from neighboring accepted implementations and
the relevant contract:

| Requirement                                       | Existing owner                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Durable work, admission, leases, and completion   | `libs/orchestrator`, `libs/work`, and [lifecycle systems](lifecycle-systems.md)                                         |
| Published compatibility and consumer behavior     | [Published actions](published-actions.md), `.github/actions`, and their contract tests                                  |
| Browser behavior and visual quality               | [Console design system](console-design-system.md), product specs, and [E2E reliability](e2e-reliability.md)             |
| Credentials, scopes, and consequential operations | [Deployment boundary](deployment-boundary.md), [IAM contract](iam-contract.md), and `agent-lcars-dev`                   |
| Shared primitives and dependency direction        | [Architecture](../ARCHITECTURE.md) and `eslint.config.mjs`                                                              |
| Required proof and test selection                 | [Testing policy](testing-policy.md) and [verification workflow](../.agents/skills/agent-lcars-dev/references/verify.md) |

When a requirement is missing, name the behavior and affected boundary before
adding guidance. Keep qualitative choices in examples or focused review; put
deterministic invariants in their type, API, state machine, or existing check.
Shared primitives remain in the published fleet packages. A desire for easier
inspection does not justify a local copy of their implementation.

## Keep context recoverable

`AGENTS.md` routes task classes. A skill advertises when an approach is useful;
its entry point carries essential constraints and links to conditional detail.
A runbook owns repeatable operational steps, preconditions, evidence, and
recovery. Keep each fact with one owner and load detail at the decision that
needs it. Adding a skill is appropriate only when an existing owner cannot
serve a concrete recurring workflow.

For multi-session work, use the existing issue or scoped plan to preserve the
accepted outcome, current revision, decisions, completed evidence, next step,
and unresolved approval boundary. Reconcile that record with current source
and tracker state when resuming. A plan is coordination history; migrate any
resulting current contract to its semantic owner.

Tool discovery must lead to a usable call and an interpretable result. Prefer
the existing CLI or script, consult its help, and inspect bounded output. A
failure should identify the target, violated contract, and recovery route.
Preserve full diagnostic output and the command's exit status when summarizing
long checks; output truncation must not masquerade as a successful run.

## Repair an observed harness gap

Use a failed run, repeated review correction, incident, or missed retrieval as
evidence. For runner diagnosis, start with
[debug-agent-run](../.agents/skills/debug-agent-run/SKILL.md); for acceptance
and ownership reconciliation, use
[issue-triage](../.agents/skills/issue-triage/SKILL.md).

1. Record the requested outcome, target revision, relevant external state,
   selected model/agent configuration, and available authority. Connect the
   symptom to the actual tool result, diff, review, or runtime observation.
2. Find the first missing handoff: absent or stale context, an undiscoverable
   or unusable capability, competing domain owners, insufficient authority,
   or proof that misses the acceptance boundary. Separate those from external
   failures and uncertain worker behavior.
3. Choose the smallest authorized repair at that owner and state the expected
   observable change. Search for sibling cases within scope. Remove obsolete
   routes or downstream defenses when their replacement covers the same
   contract; preserve supported exceptions.
4. Run the relevant native checks and assemble the evidence described in
   [verification](../.agents/skills/agent-lcars-dev/references/verify.md#evidence-for-the-requested-outcome).
   Use the normal protected delivery path when delivery is authorized.
5. When claiming improved agent behavior, inspect a fresh comparable run that
   actually retrieves or invokes the change. Keep model, agent configuration,
   authority, and starting conditions comparable; record differences. Retain,
   revise, or remove the intervention according to that evidence and its
   maintenance cost.

A clean formatter or link check proves structure, not worker effectiveness.
One successful rerun supports the observed job under those conditions; it
does not prove general improvement or causation. A model or agent change starts
a new comparison condition. Do not change the worker merely to make a harness
comparison succeed.

## Garden documentation and skills within the requested scope

For a requested maintenance pass, follow a task route from the root map through
the skill and canonical document to its code, configuration, and evidence.
Report the exact stale claim and the source that contradicts it. Repair broken
links, duplicate owners, retired paths, and unsupported guarantees at their
owner; update inbound routes when moving material.

Keep raw transcripts and credentials in their existing protected storage.
Agent explanations and Mistakes/Learnings/Desires reports are candidate
observations: corroborate them before promoting a bounded, audience-appropriate
lesson into maintained guidance. Do not make a raw session archive mandatory
context or invent root learning files for every task.

Check changed Markdown with the repository formatter and ESLint; resolve
relative links and anchors from each file's actual location, including shared
skill symlinks. `tools/check-repo-symlinks.sh` checks symlink integrity in CI;
it does not check Markdown links or semantic freshness. This document defines
a maintenance workflow, not an installed scheduled gardener or freshness gate.

Judge later use by accepted outcomes, proof quality, human steering, repair
cycles, latency, risk, and maintenance burden. Token volume, document count,
and additional validators are costs or activity signals. Add automation only
for authorized recurring work with an owner, a bounded scope, a proof path,
and a retirement condition.
