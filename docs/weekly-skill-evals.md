# Weekly skill evals

Every admitted repository's agent skills are scored once a week by a native
LCARS schedule that creates a `claude` pipeline Work item with
`deliverable: report`. The worker runs `repo-skill-evals` (repo-tools 4.1.0
and later, installed in the runner image) against the repository's committed
`evals.json` prompts and reports per skill: cases, score, how many runs fired
the skill, and failed graders. It changes nothing; findings name the SKILL.md
field or evals entry to fix.

## Why a native schedule and a Claude worker

- `claude plugin eval` needs Claude credentials. The `claude` pipeline already
  projects the maintainer's OAuth token into its worker; Goose jobs receive only
  the fleet's Goose provider environment, so a repository job cannot run it
  without widening model credentials.
- Worker pods run non-root with every capability dropped under the nodes'
  AppArmor user-namespace restriction, so bubblewrap cannot start. The runner
  only requires a sandbox backend when a case grants a shell tool; the eval
  cases grant `Skill, Read, Glob, Grep` only, so they run unsandboxed by
  design. A brief must never pass `--allow-tools` or grant Bash in a case.
- The worker's Bash environment is scrubbed, so the brief re-exports
  `CLAUDE_CODE_OAUTH_TOKEN` from the runner's token file for the child
  sessions the eval runner starts; the first qualification run parked on
  `Not logged in` without it.
- Native Work carries one repository's checkout credential, so there is one
  schedule per admitted repository. The agent-lcars schedule also clones the
  public repositories that have no LCARS admission (dev, repo-tools,
  herdr-overview) read-only and scores them in the same Work.

## Schedules

Created with `gh workflow run work-create.yml -f action=schedule-create
-f deliverable=report -f pipeline=claude -f cron=<utc> -f repo=<owner/name>
-f title=<title> -f description="$(cat <brief>)"`; disabled with
`-f action=schedule-disable -f id=<id>`. The brief template lives beside
this page in [`weekly-skill-evals.brief.md`](weekly-skill-evals.brief.md);
replace `__ROOTS__` with the repository's roots below. Crons are UTC and
staggered so at most one eval worker holds a runner slot at a time.

| Repository                                                      | Roots                                                                                      | Cron (UTC)    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| jlapenna/agent-lcars (+ public dev, repo-tools, herdr-overview) | `--root .agents/skills --root agents/shared/skills --evals-root agents/shared/skill-evals` | `0 15 * * 0`  |
| jlapenna/homelab                                                | `--root .agents/skills`                                                                    | `20 15 * * 0` |
| supersprinklesracing/sprinkles                                  | `--root .agents/skills`                                                                    | `40 15 * * 0` |
| supersprinklesracing/www                                        | `--root .`                                                                                 | `0 16 * * 0`  |
| jlapenna/labels                                                 | `--root .`                                                                                 | `10 16 * * 0` |
| jlapenna/jclaw                                                  | `--root .`                                                                                 | `20 16 * * 0` |

Schedule ids are recorded in the Work console; the schedule's title is
`Weekly skill evals: <owner/name>`.

Not covered: homegit, home-assistant-config and sparkstack-registry are private
and not admitted to the control plane, so no native Work can check them out.
Admitting one is a fleet policy change ([onboarding](onboarding-repo.md)); until
then score them from a workstation with `repo-skill-evals`.

## Cost and limits

Each pass is bounded by `--max-cost-usd` in the brief (6 for the trigger pass,
12 for the behavior pass, per repository); a pass that hits the ceiling is
reported as partial, never retried into success. Runs count against the
maintainer's Claude plan. The worker reports in its final message only; it
opens no PR or issue, and it must not edit skills or evals.
