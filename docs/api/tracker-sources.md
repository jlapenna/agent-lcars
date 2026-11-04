# Tracker sources over HTTP

External clients can inspect GitHub and Linear issues and explicitly request
execution through `/api/work/v1`. The [OpenAPI contract](work-v1.openapi.json)
defines the wire format; server policy lives in
[`work-auth.ts`](../../apps/console/src/lib/work-auth.ts),
[`work-authorization.ts`](../../apps/console/src/lib/work-authorization.ts),
[`work-router.ts`](../../apps/console/src/lib/work-router.ts) and
[`issue-sources.ts`](../../apps/console/src/lib/issue-sources.ts).
For integration setup and source lifecycle, see [Linear](../linear.md); for
credential provisioning, see [Work API access](../../OPERATIONS.md#work-api-access).

## Authentication and scope

Send an authorized Work API bearer JWT, such as a Google ID token for the
configured Work audience whose verified identity has an application Work grant.
A Linear API key or GitHub personal token is not a Work API credential. Supported
GitHub Actions OIDC identities also resolve through Work grants and carry a
restriction to their signed source repository. A run claim token is for run
routes, not these external-client operations.

| Operation                                       | Required scope                   |
| ----------------------------------------------- | -------------------------------- |
| `GET /issues/owner`                             | `work.reader` or `work.operator` |
| `GET /issues/source`, `GET /issues`             | `work.reaper` or `work.operator` |
| `POST /issues/refresh`, `POST /issues/dispatch` | `work.operator`                  |

`work.reader` is only an ownership reader; it cannot browse sources. Dispatch
also requires permission for the selected pipeline and repository. Repositories
must be admitted to the control plane. GitHub lookup needs `repo`; Linear must
belong to the configured organization and team. Linear dispatch needs a
configured team/repository/pipeline route. A repository-bound caller cannot
access another repository's source or stored Work, including after an issue
moves. An unrouted Linear issue is unavailable to repository-bound callers.
`POST /issues/refresh` does not declare repository-bound access and is refused
for those identities even with operator scope; use an authorized unbound operator.

All examples below are templates with placeholders only. Replace values through
your approved credential path; keep tokens out of source control, logs and shell
history. No browser cookies are needed. Do not execute the POST templates against
production as a documentation check.

## Read a source and its ownership

```bash
curl --fail-with-body --get 'https://<console-host>/api/work/v1/issues/source' \
  -H 'Authorization: Bearer <work-api-jwt>' \
  --data-urlencode 'tracker=linear' \
  --data-urlencode 'issue=<linear-issue-uuid-or-display-identifier>'

curl --fail-with-body --get 'https://<console-host>/api/work/v1/issues/source' \
  -H 'Authorization: Bearer <work-api-jwt>' \
  --data-urlencode 'tracker=github' \
  --data-urlencode 'repo=<owner>/<repo>' \
  --data-urlencode 'issue=<positive-issue-number>'

curl --fail-with-body --get 'https://<console-host>/api/work/v1/issues/owner' \
  -H 'Authorization: Bearer <work-api-jwt>' \
  --data-urlencode 'tracker=linear' \
  --data-urlencode 'issue=<linear-issue-uuid-or-display-identifier>'
```

For GitHub ownership use the same `tracker`, `repo` and `issue` query as the
GitHub source read. Both operations are read-only and do not manufacture a Work
binding. Source responses contain `issue`, `observedAt`, and optional `repo` and
`workId`. Ownership returns `verdict` (`fleet-run`, `interactive-session` or
`none`), `complete` and `warnings` with any available task/session evidence.
An unrouted issue returns incomplete ownership with a warning; `none` with
`complete: false` does not prove that work is free.

Linear display identifiers are useful for lookup, but dispatch requires the
full typed `issue.reference` returned by the read: `tracker: "linear"` plus
`organizationId` and `issueId` UUIDs. Do not put a display identifier into
`issueId`. GitHub dispatch uses `tracker: "github"`, `repo`, and an integer
`issue`; a display URL or `owner/repo#number` string is not that object.

## List a bounded page

```bash
curl --fail-with-body --get 'https://<console-host>/api/work/v1/issues' \
  -H 'Authorization: Bearer <work-api-jwt>' \
  --data-urlencode 'tracker=linear' \
  --data-urlencode 'repo=<owner>/<repo>' \
  --data-urlencode 'limit=25'

# Only when the preceding response supplied nextCursor:
curl --fail-with-body --get 'https://<console-host>/api/work/v1/issues' \
  -H 'Authorization: Bearer <work-api-jwt>' \
  --data-urlencode 'tracker=linear' \
  --data-urlencode 'repo=<owner>/<repo>' \
  --data-urlencode 'limit=25' \
  --data-urlencode 'cursor=<nextCursor-from-list>'
```

Use `tracker=github` for GitHub projections. `limit` defaults to 50 and accepts
1–200. The response is `{ "issues": [...], "nextCursor": "..." }`, with the
cursor omitted at the end. Listing reads stored projections, not a live tracker
crawl. Filtering and authorization occur after the bounded storage page, so an
empty `issues` array can still have `nextCursor`. Set a client page/request
budget and follow the returned cursor within that budget. Treat cursors as
opaque and retain the same tracker and filters; do not reuse list cursors for
refresh.

## Refresh metadata for one page

```bash
curl --fail-with-body 'https://<console-host>/api/work/v1/issues/refresh' \
  -H 'Authorization: Bearer <operator-work-api-jwt>' \
  -H 'Content-Type: application/json' \
  --data '{"tracker":"linear","teamId":"<configured-team-uuid>"}'
```

The response contains `refreshed` and optional `nextCursor`. A later request
can pass that cursor in the JSON `cursor` field with the same tracker/team.
Select a configured Linear team explicitly; omission works only when there is
one distinct team among configured dispatch routes. Each request reads one
provider page (up to 50 issues). For GitHub, send `{"tracker":"github"}` to
refresh one page of existing open GitHub projections (up to 50); there is no
`repo` or `limit` body field. Refresh and list have different cursor formats.

Refresh updates source metadata, including never-dispatched Linear issues. It
does not start Work or create a run, and it does not rewrite a Run's already
admitted source snapshot. Source reads, lists and ownership are also distinct
from dispatch.

## Explicitly dispatch or continue an issue

Persist one `requestId` (1–128 characters) for the intended action before sending
it, then reuse it on transport retries. Choose `pipeline` explicitly from
`claude`, `codex` or `opencode`; include the selected checkout repository as `repo`.

```bash
curl --fail-with-body 'https://<console-host>/api/work/v1/issues/dispatch' \
  -H 'Authorization: Bearer <operator-work-api-jwt>' \
  -H 'Content-Type: application/json' \
  --data '{
    "issue": {
      "tracker": "linear",
      "organizationId": "<organization-uuid-from-source-reference>",
      "issueId": "<issue-uuid-from-source-reference>"
    },
    "repo": "<owner>/<repo>",
    "pipeline": "codex",
    "requestId": "<persisted-action-retry-key>"
  }'
```

For GitHub replace `issue` with the following template, replacing the unquoted
number placeholder with a positive JSON integer. Keep the top-level `repo`
identical to the reference's `repo`:

```text
{"tracker":"github","repo":"<owner>/<repo>","issue":<positive-issue-number>}
```

A successful HTTP 200 returns `runId`, `location`, and optional `workId`.
Follow `location` for history; admission is not proof of execution or protected
delivery. Dispatch creates initial work or requests a continuation of existing
work through the shared reply path; it cannot retarget existing Work.

The retry key is scoped to the authenticated principal and typed issue source.
Reusing it with the same provider returns the existing receipt; reusing it with
a different provider produces HTTP 409 (`request-id already used with a
different provider`). Keep the reference, repository and provider unchanged on
retries. A new intentional action uses a new key; it is not a retry and may
request another run. Closed issues, conflicting routes/targets and busy work
can also conflict; inspect the error rather than generating keys until accepted.

Source closure is not a general execution-cancellation API. Closing, archiving,
deleting, canceling or marking a source duplicate cancels an unstarted
implementation; running work and explicit reply/review turns retain ownership.
Use explicit Work cancellation to stop execution. Later source edits do not undo
that cancellation.

Authentication/scope failures return HTTP 401; repository or pipeline denials
return 403, invalid input/cursors 400, unavailable sources 404, and source/Work
conflicts 409. A failed bearer never falls back to a browser session. Preserve
error details without logging credentials; do not broaden grants to retry a
request outside your authority.
