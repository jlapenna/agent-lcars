# Linear issue integration

Linear issues can enter LCARS as native Work items. The issue's description
becomes the immutable worker brief; an explicit team and dispatch-label route
selects the repository and coding pipeline. The ordinary queue, delivery
verification, parked-work UI and outbox handle execution. Outcomes are posted
as comments on the same Linear issue, with the Work link and any result URL.

## Enable the integration

1. Create a Linear personal API key with access to the intended workspace and
   teams, permission to read issues/comments and create comments. Store it as
   the runtime secret `AGENT_LCARS_LINEAR_API_KEY`. This adapter uses personal
   API-key authentication, not OAuth or Linear Agent Sessions.
2. In Linear's API settings, create an **Issues** webhook targeting
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
   routes the Supersprinkles Tech team's `LCARS: Codex (agent-lcars)` label to
   `jlapenna/agent-lcars` through Codex. Terraform declares the two secret
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
   the existing **Tech-only** team access and exactly **Read** and **Create
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
   preserve its Issues subscription, workspace/team scope and endpoint URL
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

## Intake and retry behavior

The route verifies HMAC-SHA256 against the raw request bytes and rejects a
signed `webhookTimestamp` more than one minute in either direction from the
console clock, following [Linear's webhook contract](https://linear.app/developers/webhooks).
Wrong organizations, unmatched teams/labels, ambiguous dispatch labels,
non-issue events, removed issues and archived/completed/canceled/trashed issues
start no work. Repository/pipeline authorization uses the common Work policy.

The durable source key is organization UUID plus issue UUID. Retries,
concurrent deliveries, edits, team moves and label removal/re-addition cannot
create a second Work item for the same issue. The admitted brief is immutable;
later edits are not synchronized. Use the Work UI/API to reply to parked work
or redispatch an existing item. Linear comments are outbound results in this
version; they do not start follow-up runs. Closing or deleting an issue in
Linear does not cancel already admitted Work; cancel it through LCARS.

Admission is committed before the response. The outbox drains after the
response, and ordinary maintenance retries durable pending dispatches after
process interruption. Transient admission failures return HTTP 500 for Linear
to retry. Successful admission and valid ignored events return HTTP 200, as required by Linear. Malformed events return 400;
invalid signatures or stale timestamps return 401. All responses use no-store.

## Result comments

The existing native outcome outbox sends execution settlements, parked
questions, failures, cancellations and protected-delivery completion to
Linear's [GraphQL API](https://linear.app/developers/graphql). Execution success
and delivery completion are separate comments; an opened PR is not described
as a completed delivery. Linear issue state is not changed automatically.

A stable caller-supplied comment UUID identifies each run/outbox event. Before
creating a comment, the adapter looks for that UUID and verifies the API key's
workspace and the comment's issue. Retries after an interrupted response find
the existing comment. API/GraphQL errors, missing credentials and mismatched
workspaces remain outbox failures under its existing backoff and retirement
policy. Keep the API key configured while previously admitted Linear outcomes
remain pending, even if intake is disabled. No
`AGENT_LCARS_OUTCOME_WEBHOOKS.linear` entry is needed.

Local adapter tests exercise admission and delivery boundaries with the real
in-memory Work state machine and a simulated Linear API. Live acceptance
additionally requires the workspace settings/credentials above and evidence
from a real Linear issue through execution and result delivery.
