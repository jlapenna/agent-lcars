# Agent bot identity format

GitHub represents the same App installation in two formats. Agent LCARS uses
the REST format as its canonical comparison value.

| API surface                                       | Format            | Example            |
| ------------------------------------------------- | ----------------- | ------------------ |
| REST, Actions event payloads, Octokit             | `{app-slug}[bot]` | `agent-lcars[bot]` |
| GraphQL and `gh pr`/`gh issue` JSON author fields | `app/{app-slug}`  | `app/agent-lcars`  |

## Rule

Compare only REST-shaped values with `AGENT_BOT_LOGINS`,
`AGENT_FLEET_LOGIN`, or a literal bot login.

- Prefer a REST endpoint such as `gh api repos/.../pulls/$PR --jq '.user.login'`.
- If GraphQL is required, normalize before comparing:

  ```sh
  AUTHOR_REST=$(sed -E 's#^app/(.+)#\1[bot]#' <<<"$AUTHOR_GRAPHQL")
  ```

Do not compare a raw `app/<slug>` value with a REST login.

## Maintained callsites

| Callsite                                        | Required format                                                 |
| ----------------------------------------------- | --------------------------------------------------------------- |
| Actions event payload checks                    | REST                                                            |
| `agent-automerge-reusable.yml` PR-author lookup | REST                                                            |
| Console GitHub client                           | REST                                                            |
| Native outcome verifier bot filtering           | REST; filter on user type where a specific login is unnecessary |

Before adding a callsite, identify the API that produced the value and
normalize it at that boundary.
