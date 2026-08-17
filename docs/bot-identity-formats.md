# Canonical format for agent bot identities: REST vs GraphQL

`claude[bot]`/`app/claude` and `agent-lcars[bot]`/`app/agent-lcars` are pairs
of different string encodings of the _same_ underlying GitHub App
installation. They are not accounts that can drift apart; they are two
serializations of one identity that happen to look nothing alike. Mixing
them without translating is what silently broke the CI → deploy chain for
every agent-merged PR (#175): the auto-merge workflow's `restore-main-checks`
job read a GraphQL-shaped login (`app/claude`) and compared it against
`vars.AGENT_BOT_LOGINS`, a REST-shaped list (`["claude[bot]", ...]`) —
the two never matched, so the job always took the "not agent-authored"
branch and skipped the manual CI/deploy dispatch it exists to perform.

## Why the two shapes exist

GitHub represents the actor behind a bot/App differently depending on
which API answers the query:

- **REST** renders any bot actor (a `User` whose `type` is `Bot`, backing a
  GitHub App installation) as `{app-slug}[bot]` — e.g. `claude[bot]` or
  `agent-lcars[bot]`.
- **GraphQL** has a distinct `Bot` node type for the same actor and renders
  it as `app/{app-slug}` — e.g. `app/claude` or `app/agent-lcars`.

Both are deterministic, 1:1 functions of the same App slug.
There is no trigger path (a `workflow_dispatch` run, an `@claude` mention
reply, a direct API push) that changes which identity is acting — it is
always the same App installation — only which API you asked, and therefore
which string you got back, changes.

`gh`'s CLI convenience flags follow the API they're backed by, not the
command's own consistency: `gh api repos/.../pulls/$PR` (plain REST) and
`github.event.*.user.login` (Actions event payloads, always REST) return
`claude[bot]`; `gh pr view`/`gh pr list --json author` (GraphQL under the
hood) return `app/claude`. Two calls that look similar can return
differently-shaped strings for the exact same PR.

## Decision: standardize on REST shape (`login[bot]`)

REST shape is canonical for this repo. Reasons:

- `github.event.pull_request.user.login` / `github.event.issue.user.login`
  (Actions event payloads) are REST-shaped and unavoidable — every workflow
  reads triggering events this way.
- `vars.AGENT_BOT_LOGINS`, `vars.AGENT_FLEET_LOGIN`, `vars.MAINTAINER_LOGIN`
  (see `docs/deployment-boundary.md`) are all REST-shaped, ordinary-login
  values.
- `apps/console` never talks to GitHub over GraphQL at all — `github-client.ts`
  wraps `@octokit/rest` exclusively, so every login the console reads
  (`action-items.ts`'s `issue.user?.login`, etc.) is REST-shaped by
  construction.
- `gh api repos/.../pulls/$PR --jq '.user.login'` (the fix landed in #188
  for the exact bug above) is REST-shaped and already the pattern to follow
  when a workflow needs a PR's author.

The GraphQL-shaped surface to watch is `gh pr`/`gh issue list`/`view --json
author` — the CLI's convenience JSON flags for those two subcommands are
backed by GraphQL. **Don't compare that field's value
directly against anything REST-shaped** (`AGENT_BOT_LOGINS`,
`AGENT_FLEET_LOGIN`, a literal `x[bot]`). Two ways to avoid it, in order of
preference:

1. **Prefer the REST endpoint instead of the GraphQL-backed flag.**
   `gh api repos/.../pulls/$PR` / `gh api repos/.../issues/$NUM` (or the
   paginated list form for multiple items) returns `.user.login` already
   REST-shaped — this sidesteps the translation question entirely. This is
   the #188 pattern.
2. **When only the GraphQL shape is available** (e.g. `gh pr list --json
author` across many PRs, where the REST list endpoint would need
   separate pagination/query handling), normalize before comparing:
   ```sh
   AUTHOR_REST=$(sed -E 's#^app/(.+)#\1[bot]#' <<<"$AUTHOR_GRAPHQL")
   ```
   Compare `$AUTHOR_REST` against REST-shaped values, never the raw
   GraphQL string.

Per-callsite handling — each script deciding for itself whether it's
holding a REST or GraphQL login and translating (or not) accordingly — is
rejected. #175 is the direct proof this fails silently in practice: it is
not a hypothetical risk.

## Current-state inventory

| Callsite                                                                                                                                                                                                                                                    | Shape | Status                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-automerge-reusable.yml`'s `restore-main-checks` (`gh api .../pulls/$PR --jq '.user.login'`)                                                                                                                                                          | REST  | Fixed (#188)                                                                                                                                                                                                                                                                                                        |
| `agent-automerge-reusable.yml`'s `automerge` job `if:` / event-payload checks (`github.event.pull_request.user.login`)                                                                                                                                      | REST  | Always was correct — Actions event payloads are REST-shaped                                                                                                                                                                                                                                                         |
| `apps/console` (`github-client.ts`, `action-items.ts`)                                                                                                                                                                                                      | REST  | Correct by construction — Octokit REST only, no GraphQL client in this codebase                                                                                                                                                                                                                                     |
| `.github/actions/verify-deliverable/verify-deliverable.sh` — the deliverable-evidence gate's bot filter (`gh api .../pulls?...` / `select(.user.type == "Bot")`), shared composite used by all three worker lanes (`claude.yml`/`codex.yml`/`opencode.yml`) | REST  | Correct — uses the REST list endpoints; #1223 filters on `.user.type`, deliberately never a specific login, and the old `select(.user.login != $exclude)` dedup guard (moved here from `opencode.yml`'s inline construct in #330) was deleted with the inference mode in #1303, so no login comparison remains here |

## If you add a new callsite

Ask "which API is this login coming from" before comparing it to anything:
Actions event payload, `gh api`, or Octokit → REST, already canonical, safe
to compare. `gh pr`/`issue list`/`view --json author`/`actor` → GraphQL,
normalize with the `sed` pattern above (or switch to the REST endpoint)
before comparing against `AGENT_BOT_LOGINS`/`AGENT_FLEET_LOGIN`/any
REST-shaped literal.
