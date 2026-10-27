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

| Identity                                                    | Work principal            | Scope           |
| ----------------------------------------------------------- | ------------------------- | --------------- |
| `jlapenna`                                                  | `user:jlapenna`           | `work.operator` |
| `agent-lcars-production-verifier`                           | `svc:production-verifier` | `work.operator` |
| Google SA `work-reader@agent-lcars.iam.gserviceaccount.com` | `svc:work-reader`         | `work.reader`   |

The production-verifier grant applies to sessions with that login, including
existing unexpired sessions. It is an identity grant, not a grant limited to
one browser or one cleanup. `work.operator` permits Work creation, cancellation,
redispatch, replies, and schedule management across the configured pipelines.
The shared verification credential therefore carries operational authority;
its holders must act only within the requested task.

`work.reader` authorizes only the read-only issue-owner query,
`GET /anchors/github/owner` (`lcars work owner <owner/repo>#<n>`). It cannot
list or read items, mutate, or manage schedules. Interactive Claude and Codex
sessions use it through `LCARS_SERVICE_ACCOUNT=work-reader@agent-lcars.iam.gserviceaccount.com`;
only the maintainer's Google account may impersonate that identity.

Grant changes go through a PR, required checks, merge, and the normal
[Deploy console workflow](.github/workflows/deploy-console.yml). The server
caches grants, so editing source alone does not change live authorization.
After rollout, verify the session login at `GET /api/auth/session`, then verify
Work access with `GET /api/work/v1/items?limit=1` (a `work.reader` identity
instead with the owner query, and expect `items` to be refused). Admin status
alone is not proof. Removing the grant through the same deployment path revokes Work access
for that identity without having to wait for its sessions to expire.

### Integrating Work platforms

All `/api/work/v1` adapters share authentication and cookie-origin enforcement
at the catch-all route. Resource authorization lives in
[`work-authorization.ts`](apps/console/src/lib/work-authorization.ts): admitted
repository, verified source-repository restriction, and pipeline capability.
Native minting, GitHub admission, delivery evidence, provider fallback and
repository jobs consume that policy. Stored-item reads and mutations use
`readWorkTask`; lists use the same stored-resource policy without changing
pagination cursors. Unbound operator/reaper read access remains unchanged.

Repository-bound identities are refused at the shared HTTP entry point unless
the operation declares repository-bound access. Adding an adapter therefore
does not silently grant it cross-repository authority. Adapters declare their
operation scope and bind their resource to the shared policy; they do not interpret
OIDC claims or implement repository comparisons. Services with transaction-time
grant checks bind their callback with `scopedWorkGrant`, so replay, disabling,
and concurrent requests keep the authenticated repository boundary. Keep live
grant revalidation and platform-specific execution/profile validation in place.

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
  as well as an application Work grant. Interactive sessions on the
  maintainer's hosts use `work-reader` for the owner query; they do not
  impersonate `codex-agent`, whose grant carries `work.operator`.

A failed bearer token does not fall back to session cookies. Use one valid
method. If a session expires, follow the saved-session capture or maintainer
mint workflow; never print session cookies or `AUTH_SECRET` into logs. Do not
use the saved-session verification tool's `--click` option for mutations;
use the authorized application API operation.

## Worker investigation client

`lcars investigate --request-id <key> --question-file <path> [--context-file <path>]`
uses the existing runner bundle, `LCARS_RUN_ID` and `LCARS_RUN_TOKEN`.
Receipt-mode runs additionally require their existing projected Pod JWT file
and activated generation. Operator credentials are not used.

The client reads canonical identity from the fixed Console introspection route,
then sends the agreed v1 payload to
`https://investigate.lan.jlapenna.net/v1/investigations`. This endpoint is a
client contract; gateway implementation and adoption remain Homelab-owned.
The strict wire schemas live in [the Work contract](libs/work/src/investigation-contract.ts):
32 KiB requests, 64 KiB findings and 2 KiB errors, including streamed bodies.
The client bounds transport to 65 seconds or the smaller observed authorization
validity, refuses redirects, and never retries. Reuse a request key only for the
same question/context; gateway quota, idempotency, final authorization, probe
catalog/evidence linkage and retained audit remain required server behavior.
An unavailable gateway fails safely and proves no investigator execution.

## Operator evidence for stopped work

When a worker cannot observe a required runtime or remote-source fact, use the
[bounded evidence handoff](.agents/skills/debug-agent-run/references/evidence-handoff.md).
The operator-bastion helper is not a worker capability. Preserve the original
trust/access error and request a credential-free receipt bound to the subject
run, original Job UID, controller revision and missing observation.

This reuses existing owners: the shared protocol's marker-bound PARK artifact
is the request; `run.result.message` retains the human handoff; explicit native
parks derive `state: parked` and the decision inbox offers Reply; GitHub parks
project `status:needs-human` from the accepted outcome. The console owns those
projections, not the worker. No new evidence state or endpoint is required.

An authorized operator returns the bounded receipt through the existing native
[Work reply](libs/work/README.md#replying-from-the-cli) or the GitHub anchor's
evidence comment and recognized provider reply command. The Work reply stores
the authenticated principal/channel and admits the next run with the text in
its `reply` context; keep the idempotency key and verify `admittedRunId`.
GitHub workers read paginated anchor/linked-PR comments on redispatch. Receipts
are evidence, not authorization to change trust, credentials or runtime.

Operator access is an external prerequisite. If it is unavailable, retain the
explicit request rather than provision access or duplicate delivered source.
If the required natural event is absent, its observation gate remains separate
from the access handoff. A parked exit 0 is not accepted verification.

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

## Changing a GitHub task's provider

An administrator may remove the current canonical `agent:*` label and apply
one supported replacement. Apply it only after the complete label set has one
choice. The signed delivery's actor and source clock authorize and order this
request; missing clocks, conflicting labels and out-of-order deliveries fail
closed. Same-provider requests preserve ordinary redispatch semantics.

The controller replaces only an unclaimed queued attempt. Work stays immutable;
the canceled predecessor retains its provider and the successor is a fresh run.
No production-data repair or direct queue manipulation is needed. Task history
shows the requested provider, effective provider and handoff refusal. A claimed
or physically retained attempt must settle, resolve credential cleanup and
complete physical retirement first. A refusal never schedules a competing
executor: reapply the chosen label after those gates pass (and after GitHub's
source clock advances). Parked and terminal tasks follow those same gates and
start fresh across providers; provider-specific sessions are never resumed.
