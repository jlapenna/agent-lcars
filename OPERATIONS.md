# Operations

## Work API access

The production Work API is `https://lcars.jlapenna.net/api/work/v1`.
Its [OpenAPI contract](docs/api/work-v1.openapi.json) defines the supported
operations. Use these application routes for maintenance; database edits are
not the normal operations path.

Console admin status and Work authorization are separate. An authenticated
admin can still receive `401` with `work.operator or work.reaper scope
required`. Work grants are declared in `AGENT_LCARS_WORK_GRANTS` in
[apphosting.yaml](apps/console/apphosting.yaml), parsed by
[work-grants.ts](apps/console/src/lib/work-grants.ts), and matched against the
verified identity by [work-auth.ts](apps/console/src/lib/work-auth.ts).

| Session login                     | Work principal            | Scope           |
| --------------------------------- | ------------------------- | --------------- |
| `jlapenna`                        | `user:jlapenna`           | `work.operator` |
| `agent-lcars-production-verifier` | `svc:production-verifier` | `work.operator` |

The production-verifier grant applies to sessions with that login, including
existing unexpired sessions. It is an identity grant, not a grant limited to
one browser or one cleanup. `work.operator` permits Work creation, cancellation,
redispatch, replies, and schedule management across the configured pipelines.
The shared verification credential therefore carries operational authority;
its holders must act only within the requested task.

Grant changes go through a PR, required checks, merge, and the normal
[Deploy console workflow](.github/workflows/deploy-console.yml). The server
caches grants, so editing source alone does not change live authorization.
After rollout, verify the session login at `GET /api/auth/session`, then verify
Work access with `GET /api/work/v1/items?limit=1`. Admin status alone is not
proof. Removing the grant through the same deployment path revokes Work access
for that identity without having to wait for its sessions to expire.

### Authentication options

- Reuse an existing authenticated console session. For dedicated verification
  sessions, follow the [saved-session skill](.agents/skills/verifying-console-session/SKILL.md).
  Its local backend is `${XDG_STATE_HOME:-~/.local/state}/agent-lcars/sessions/admin.json`;
  the shared backend is the latest `AGENT_LCARS_ADMIN_STORAGE_STATE` secret
  version in project `agent-lcars` (base64-encoded Playwright storage state).
  Use its matching-origin cookies in the consuming HTTP client without printing
  them. Keep storage state private and outside the repository.
- For service-account callers, the [Work CLI](libs/work/README.md) accepts
  `LCARS_TOKEN`, or `LCARS_SERVICE_ACCOUNT` plus optional `LCARS_AUDIENCE`
  (default `agent-lcars-work`). Google impersonation requires IAM permission
  as well as an application Work grant. A locally signed-in Google account
  does not automatically have permission to impersonate `codex-agent`.

A failed bearer token does not fall back to session cookies. Use one valid
method. If a session expires, follow the saved-session capture or maintainer
mint workflow; never print session cookies or `AUTH_SECRET` into logs. Do not
use the saved-session verification tool's `--click` option for mutations;
use the authorized application API operation.

## Clear obsolete parked native work

Cancellation preserves the item and run history while removing it from the
parked state. It does not mean the work succeeded. Use it when the maintainer
has authorized clearing obsolete work, such as superseded “main advanced”
items.

1. Enumerate `GET /api/work/v1/items?state=parked&limit=200`. Follow every
   `nextCursor` by passing it as `cursor`, even when a filtered page contains
   no items. Stop only when the response omits `nextCursor`.
2. Inspect each candidate's title, description, and run results. Confirm the
   reported blocker and that the work is obsolete; matching words in an older
   run are not sufficient evidence for canceling unrelated current work.
   Record the selected IDs and reasons before mutation.
3. Immediately re-read `GET /api/work/v1/items/{id}`. Require the item still
   to be parked and its runs unchanged since inspection. Leave running,
   already settled, or newly updated items for separate assessment. The
   cancellation API can also stop live runs, so this check matters.
4. Submit `POST /api/work/v1/items/{id}/cancel` for each approved candidate.
   Require a successful response with `state: canceled`, then re-read each
   item to verify the persisted state and `closedAt`.
5. Enumerate all parked pages again and report how many selected items were
   canceled and whether any matching candidates remain. Report skips and
   errors explicitly. Never infer success from an HTTP request being sent.

Do not redispatch obsolete work to clear the list. GitHub-anchored tasks are
separate from native `/items`; use their supported console workflow and
verify the linked issue/PR state before changing them.
