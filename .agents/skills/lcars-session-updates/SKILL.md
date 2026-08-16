---
name: lcars-session-updates
description: Use when working a long or multi-phase task while the person who asked is away, when several agents run at once and someone needs to tell them apart at a glance, when a session's focus drifts from the prompt that opened it, or when about to report progress only into chat that nobody is reading.
---

# LCARS Session Updates

Every agent session on a watched host already appears in the LCARS console. Two commands
control what it says about itself. Neither needs a session id — the CLI reads
`CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` from its own environment.

```bash
lcars session title  "Land session titles end to end"   # the session's stable NAME
lcars session status "waiting on CI for #1247"          # what it is doing RIGHT NOW
lcars session title --clear                             # revert to the transcript's own title
lcars session status --clear                            # no longer doing that thing
```

## Why this is easy to miss

Left alone, a session is named after the prompt that opened it. Claude Code writes that name
**once, early, and never revises it**; Codex's is similar. An hour later the console still
advertises what you started on, not what you are doing — and the person scanning it has no way
to know the difference.

## Choosing a channel

| Channel                    | Reaches                                      | Use for                                 |
| -------------------------- | -------------------------------------------- | --------------------------------------- |
| Chat output                | whoever is reading the transcript right now  | reasoning, findings, the actual work    |
| tmux window title          | a human at _that terminal_                   | distinguishing panes on one workstation |
| **`lcars session title`**  | anyone with the console, incl. headless runs | what this session **is**                |
| **`lcars session status`** | same                                         | what it is **doing right now**          |
| Telegram / SMS / Slack     | interrupts a person                          | something that cannot wait              |

The row that gets skipped is the LCARS one. A tmux title is invisible to someone looking at the
console, and invisible for any CI-dispatched run — there is no pane. Chat output is invisible to
anyone not reading that transcript. If the person is away, only LCARS reaches them.

**Status is the non-interrupting channel.** That is its whole point: things worth _glancing_ at,
not worth waking someone for. Something genuinely urgent still warrants a real interrupt.

## When to update

- **Title** — once, when you know what the session actually is, and again if the focus genuinely
  changes. It is a name; it should be stable enough to recognize later.
- **Status** — on state changes someone might act on: `waiting on CI for #1247`,
  `blocked on review`, `deploying to pike`, `rerunning after a flake`.

Clear the status when it stops being true. A stale status is not silently discarded — the console
renders its age, so a wrong one is visibly wrong next to a live session.

## Restraint

Status is not narration. Updating it every few seconds, or once per tool call, makes the field
noise, and a field that is always changing is one people stop reading. If you would not say it out
loud to someone walking past, it is not a status.

A useful test: **would this change what someone decides to do?** "waiting on CI" tells them not to
bother you. "reading daemon.ts" does not.

## Common mistakes

| Mistake                                              | Reality                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| "The repo is read-only, so I shouldn't write status" | These write to `~/.local/state/agent-lcars/`, never the repo. A read-only-checkout constraint does not forbid them. |
| Setting a tmux title and stopping there              | Works only for a human at that terminal. Useless in the console, useless headless.                                  |
| Overwriting the title with progress                  | Then the session has no durable name. Progress is what `status` is for.                                             |
| Narrating each step into status                      | Trains people to ignore the field.                                                                                  |
| Leaving a finished status set                        | Clear it. The console shows its age, so it reads as stale rather than current.                                      |

## When it is not available

The `lcars` command is absent on hosts without the CLI installed, and an older installed copy may
not have every subcommand yet — `session status` is newer than `session title`. Either way: check
once (`command -v lcars`), try the command, and if it is missing or prints usage, carry on
silently. Never fail a task over telemetry, and never report a status you did not actually manage
to set.
