# Linear issue tracker

Linear is an issue source alongside GitHub. Its organization/issue UUIDs identify
the source; a separate repository binding selects where agents work. Current
metadata is synchronized onto Work, while each Run retains the source snapshot
admitted for its own brief. Execution, ownership, replies, queueing, triage,
Inbox decisions and protected delivery use the shared LCARS machinery.

No import or migration is required. Enabling Linear leaves existing trackers
and their issues in place.

## Enable the integration

1. Create a Linear personal API key with access to the intended workspace and
   teams, with **Read**, **Write** and **Create comments** permissions. Write is
   required for configured workflow states and triage labels. Store it as
   the runtime secret `AGENT_LCARS_LINEAR_API_KEY`. This adapter uses personal
   API-key authentication, not OAuth or Linear Agent Sessions.
2. In Linear's API settings, create an **Issues and Comments** webhook targeting
   `https://<console-host>/api/control-plane/linear/webhook`. Store its signing
   secret as `AGENT_LCARS_LINEAR_WEBHOOK_SECRET`. Use one webhook for the
   configured workspace, including the teams you intend to route.
3. Add a dedicated grant to `AGENT_LCARS_WORK_GRANTS`, preserving existing
   entries. Grant only the pipelines the integration needs:

   ```json
   {
     "principal": "svc:linear",
     "subjects": ["linear-webhook-adapter"],
     "pipelines": ["codex"],
     "scopes": ["work.operator"],
     "channel": "linear"
   }
   ```

   The subject is an adapter identifier, not a bearer credential. The webhook
   authenticates by its HMAC; its payload cannot choose a principal, pipeline
   or repository. People able to apply a dispatch label on a configured team
   can request work under this grant.

4. Set `AGENT_LCARS_LINEAR` to a JSON object using the actual organization,
   team and label UUIDs from Linear. The repository must already belong to
   `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` and `AGENT_LCARS_WATCHED_REPOS`.

   ```json
   {
     "organizationId": "11111111-1111-4111-8111-111111111111",
     "operatorIds": ["55555555-5555-4555-8555-555555555555"],
     "teams": [
       {
         "teamId": "22222222-2222-4222-8222-222222222222",
         "name": "Engineering",
         "repositories": [
           {
             "repo": "jlapenna/agent-lcars",
             "labelId": "66666666-6666-4666-8666-666666666666"
           }
         ]
       }
     ],
     "routes": [
       {
         "teamId": "22222222-2222-4222-8222-222222222222",
         "labelId": "33333333-3333-4333-8333-333333333333",
         "repo": "jlapenna/agent-lcars",
         "pipeline": "codex",
         "principal": "svc:linear"
       }
     ]
   }
   ```

5. Supply these settings and secrets through the console's normal runtime
   configuration/deployment path (see [deployment boundary](deployment-boundary.md)).
   An absent or blank `AGENT_LCARS_LINEAR` disables intake with HTTP 503;
   enabled but invalid configuration fails startup. This repository's deployment
   routes the Supersprinkles Tech team's `LCARS: Codex (agent-lcars)`,
   `LCARS: Claude (agent-lcars)` and `LCARS: OpenCode (agent-lcars)` labels
   to `jlapenna/agent-lcars`. `Repository: agent-lcars` selects metadata/triage
   without dispatching coding work; unrelated Tech issues remain unrouted. Terraform declares the two secret
   containers and their secret-scoped App Hosting grants; their values are
   supplied separately in Secret Manager.
6. Apply exactly one configured dispatch label to an active issue. A signed
   create/update event admits it. Follow the returned `itemId` at `/work/<id>`.
   Select a useful real issue for live verification; avoid a no-op dispatch.

## Rotate integration credentials

These are operator steps for an authorized rotation; examples use placeholders
only. Keep secret values out of Git, Terraform, command arguments and logs.
Rotate the API key and webhook signing secret separately so failures can be
attributed to one change.

### API key

1. Create a replacement Linear personal API key in the same workspace. Preserve
   the existing **Tech-only** team access and exactly **Read**, **Write** and **Create
   comments** permissions; do not broaden access for rotation. Leave the old
   key valid during the rollout.
2. Add an enabled version to the existing GCP Secret Manager secret
   `AGENT_LCARS_LINEAR_API_KEY` in `<gcp-project>`, using the secure operator
   secret-entry path (for example, the Secret Manager console). Record only
   the new version number, `<replacement-version>`, in the rotation evidence.
   Terraform owns the container and grants, never the key value.
3. Deploy through the normal [console deployment workflow](../.github/workflows/deploy-console.yml)
   and [deployment boundary](deployment-boundary.md). The runtime reference in
   `apps/console/apphosting.yaml` is unversioned; App Hosting resolves it for
   the new rollout. Adding a Secret Manager version does not update an already
   running revision. Verify that the serving rollout uses the replacement
   version before testing or revoking anything.
4. Verify the replacement against the intended workspace and a Tech issue:
   confirm issue/comment reads, then use a useful real Linear-backed Work
   outcome to confirm the deployed adapter creates its result comment on the
   correct issue with the Work link and result URL when present. Check the
   outcome outbox for delivery errors. A successful rollout or webhook HTTP
   200 alone does not prove the API key can create comments.
5. Only after that verification and retirement of revisions using the old key,
   revoke the old key in Linear and disable its old Secret Manager version.
   If verification fails, retain the old key, restore its value as a new enabled
   Secret Manager version through the secure entry path, redeploy through the
   same workflow, and verify recovery. Keep a working key available while any
   previously admitted Linear outcomes are pending, even if intake is disabled.

### Webhook signing secret

The deployed webhook verifier accepts one `AGENT_LCARS_LINEAR_WEBHOOK_SECRET`,
with no overlap of old and new signatures. Coordinate the Linear webhook's
signing-secret replacement and the console rollout in a planned intake pause;
changing only one side causes HTTP 401 and does not admit work.

1. Pause webhook delivery in Linear for the configured endpoint and record any
   affected useful issues for reconciliation. Keep the API key and existing
   Work/outcome processing enabled. If Linear requires recreating the webhook,
   preserve its Issues and Comments subscriptions, workspace/team scope and endpoint URL
   `https://<console-host>/api/control-plane/linear/webhook`; leave the old
   webhook disabled during the switch.
2. Obtain the replacement signing secret from Linear and securely add an enabled
   version to `AGENT_LCARS_LINEAR_WEBHOOK_SECRET` in `<gcp-project>`. Deploy
   through the same normal console workflow. Confirm the serving runtime uses
   that version and that no old-secret revision can receive webhook traffic
   before enabling delivery signed with the replacement secret.
3. Resume delivery and verify a fresh, Linear-signed event for useful work:
   expect HTTP 200 and the intended native Work item (or the existing item for
   an already admitted issue), then verify its result comment. Review webhook
   delivery failures and reconcile events missed during the pause. Use fresh
   issue updates for missed intake: an old payload can fail the one-minute
   timestamp check even when its signature is valid. Reconciliation must not
   redispatch issues that already have Work solely to test rotation.
4. Retire the old webhook, if replaced, and disable the old Secret Manager
   version only after verification. On failure, keep delivery paused and
   restore a matching Linear webhook/runtime secret pair through the same
   version-and-rollout procedure before resuming; reverting only the runtime
   cannot repair a changed Linear signing secret.

## Browse and operate issues

Open **Work → Issue sources** (`/work/issues`) and select Linear. Refresh reads
one bounded page at a time, including issues that have never been dispatched;
it never creates Work. Select a configured repository and agent to run an issue,
or open its existing Work history. Current title, status, labels and assignee
remain linked to the original issue. Edit source text in Linear.

The CLI exposes the same source and ownership operations:

```bash
lcars work issues refresh --tracker linear --team <team-uuid>
lcars work issues --tracker linear
lcars work issue linear:SPR-84
lcars work owner linear:SPR-84
lcars work dispatch linear:SPR-84 --repo jlapenna/agent-lcars --pipeline codex --request-id <retry-key>
```

Refresh and list return `nextCursor` when another page exists; pass it as
`--cursor`. A read or ownership lookup never creates a source-to-Work mapping.
An unrouted issue reports unknown ownership until a repository is selected.
Repository-bound callers cannot read another repository's Work through a moved
issue. Old Work history retains its original target.

Inside an authenticated worker, `lcars work source` reads the current issue and
one page of comments using only that run's token. Follow `nextCursor` with
`lcars work source --cursor <cursor>`. `admittedIssue` is the immutable Run
snapshot; `issue` is current source state. No Linear API key reaches the worker.

## Routing, replies and source lifecycle

A team can serve multiple repositories. Optional `teams[].repositories` maps
repository labels to checkout targets independently of provider dispatch labels.
An optional `teams[].repo` is an explicit default for a team dedicated to one
repository. Leave it absent for a shared team. Conflicting routing labels do
not dispatch. Each team/dispatch label pair selects one authorized repository,
pipeline and integration principal through the common Work grant policy.

Exactly one configured dispatch label on an open issue starts its first Work.
Ordinary edits refresh current metadata without changing an admitted brief or
creating another run. One organization/issue pair owns one durable Work item.
Moving its team or repository cannot retarget existing Work.

Comments from `operatorIds` can explicitly request the shared reply commands:
`@claude` (alias `@agent`), `/codex`, `/oc` (alias `/opencode`), when that
pipeline has a route for the issue's repository. Current comment body and author
are verified against Linear. Ordinary prose, code, quotes and LCARS output are
inert. Reapplying a dispatch label is an explicit follow-up only when the signed
event proves an authorized operator newly added it. Stable source-event receipts
prevent duplicate runs even when delivery retries after the first run settles.
Replies use the existing session-resume and provider-switch behavior; a busy run
retains its execution ownership.

Closing, archiving, deleting, canceling or marking a source duplicate cancels
only an unstarted implementation. A final fresh source read fences queued work
before its token reaches a worker. Unknown source state defers the claim for a
later poll. Running work and explicit reply/review turns retain their ownership;
use Work cancellation to stop execution. Explicit Work cancellation remains
authoritative and is not undone by later source edits.

## Durable webhook processing

The public route verifies HMAC-SHA256 over the original bytes and rejects a
signed `webhookTimestamp` outside one minute of the console clock, following
[Linear's webhook contract](https://linear.app/developers/webhooks). It returns
HTTP 200 after the existing Cloud Tasks queue owns the original signed envelope;
no provider read or worker startup delays the acknowledgment. Malformed events
return 400, invalid/stale signatures 401 and queue failures 500. Responses use
`Cache-Control: no-store`.

The internal `/api/control-plane/linear/process` route requires Google's verified
OIDC identity for `AGENT_LCARS_WEBHOOK_TASK_SERVICE_ACCOUNT` and the exact route
audience, then rechecks the original HMAC. Only this authenticated path accepts
delayed queue delivery. Cloud Tasks retries transient failures. The shared hosted
webhook policy bounds attempts, schedules delayed repair successors and stops
exhausted repairs with a visible error; an explicit metadata refresh or a fresh
source event can reconcile the source afterward. Terraform grants the runtime
permission to attach only its configured task identity.

## Workflow states and protected delivery

Optional `teams[].states` maps `started`, `parked`, `failed`, `canceled` and
`completed` to actual Linear workflow-state UUIDs. Every write validates the
state's team/category. Configure a nonterminal state for parked/failed work;
use a canceled-category state for cancellation and a completed-category state
for protected delivery.

The first authenticated provider heartbeat records the durable started effect.
Execution settlement and protected-delivery completion remain distinct comments.
A successful execution or an open PR never marks the issue Done: completed
status requires the bound PR's protected merge evidence. Retries reuse the
existing outbox, including when the comment already exists but its state update
failed. Older generations, source routing conflicts and observed human closure
fence status writes. Source-managed report/triage work does not project coding
workflow states.

Stable caller-supplied comment UUIDs identify each outcome event. Read-back
verifies the workspace and issue, including archived comments, so a lost write
response does not duplicate output. API/GraphQL errors and missing credentials
remain retryable under the existing outbox policy. Keep credentials available
while old Linear outcomes are pending. No
`AGENT_LCARS_OUTCOME_WEBHOOKS.linear` setting is needed.

## Event-driven triage and Inbox

Optional `teams[].triage` contains `bugLabelIds`, `readyLabelId`, `pipeline` and
`principal`. It uses the repository's existing watched-repository opt-in and
shared triage publisher. `readyLabelId` selects the ready coding provider; each repository binding must
have exactly one dispatch route for that same provider. Readiness adds the label
for the issue’s repository, never another repository’s label;
the analysis pipeline/principal must have the corresponding Work grant.
Repository labels or a dedicated-team default identify an undispatched bug's
target. Unrouted issues never become guessed repository work.

Fresh issue text, comments, ownership, assignment, linked PRs and control labels
fence each report. Metadata proposals are restricted to existing non-triggering
`type:*`, `component:*` and `app:*` labels. The publisher retains its source
revision, lease, comment and dispatch receipts. An observed ready label that a
human later removes is never automatically re-added. A previous coding dispatch
prevents automatic redispatch.

Linear `needs-owner` and `needs-evidence` reports appear in the existing Inbox,
linked to their source and Work history. Respond on the Linear issue; its next
source event refreshes triage. Internal report Work does not accept a coding
reply. Ready reports use the configured route through normal issue admission.

Local regression tests use the real in-memory orchestrator and simulated provider
transport. Live acceptance additionally verifies the exact GraphQL queries,
team-scoped permissions, signed webhook processing, source browsing, a useful
real worker conversation and protected-delivery/status publication.
