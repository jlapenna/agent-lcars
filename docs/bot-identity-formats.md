# Agent bot identity format

GitHub represents the same App installation in three surface formats. Agent LCARS uses
the REST format as its canonical comparison value.

| API surface                                                                    | Format                            | Example                                       |
| ------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------- |
| REST (`pulls`/`issues` `.user.login`, `commits` `.author.login`), Actions, SDK | `{app-slug}[bot]`                 | `agent-lcars[bot]`                            |
| Raw GraphQL `Actor { __typename login }`                                       | `__typename: "Bot"`, `{app-slug}` | `{ __typename: "Bot", login: "agent-lcars" }` |
| `gh pr`/`gh issue` `--json` author fields                                      | `app/{app-slug}`                  | `app/agent-lcars`                             |

## Rule

Compare only REST-shaped values with `AGENT_BOT_LOGINS`,
`AGENT_FLEET_LOGIN`, or a literal bot login.

- Prefer a REST endpoint such as `gh api repos/.../pulls/$PR --jq '.user.login'`.
- In TypeScript GraphQL callers, always select `author { __typename login }` and
  normalize through `normalizeGraphqlActorLogin` (`apps/console/src/lib/graphql-actor.ts`),
  which maps `Bot` actors (`agent-lcars`) and `gh --json` values (`app/agent-lcars`)
  to `{app-slug}[bot]` without promoting `User` logins.
- In shell scripts consuming `gh --json`, normalize before comparing:

  ```sh
  AUTHOR_REST=$(sed -E 's#^app/(.+)#\1[bot]#' <<<"$AUTHOR_GRAPHQL")
  ```

Do not compare a raw GraphQL `Bot` login or `app/<slug>` value with a REST login.

## Maintained callsites

| Callsite                                                                            | Required format                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Actions event payload checks                                                        | REST                                                                            |
| `agent-automerge-reusable.yml` PR-author lookup                                     | REST                                                                            |
| Console GitHub REST client                                                          | REST                                                                            |
| Console GraphQL reads (`pr-remediation`, `ready-delivery`, `github-anchor-refresh`) | Normalize `Actor { __typename login }` via `normalizeGraphqlActorLogin` to REST |
| Native outcome verifier bot filtering                                               | REST; filter on user type where a specific login is unnecessary                 |

Before adding a callsite, identify the API that produced the value and
normalize it at that boundary.
