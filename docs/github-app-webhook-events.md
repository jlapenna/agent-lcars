# Subscribing the GitHub App to a new webhook event

`configure-github-app-webhook.yml` and `tools/configure-github-app-webhook.mjs`
own two things about the `agent-lcars` GitHub App's webhook: its **URL** and
its **HMAC secret** (`PATCH /app/hook/config`, see `docs/deployment-boundary.md`
§4 for the full variable/secret map). They deliberately do **not** own, and
cannot grant, the App's **permissions** or **subscribed events** — GitHub has
no self-service API for either. That is a settings-page, human-approved
control, on purpose: an App programmatically escalating its own permission or
event scope with no approval step would let a compromised credential quietly
widen what it can see and do. The webhook URL/secret are different in kind —
low-trust, freely revocable and rotatable — which is exactly why a workflow
is allowed to own them and not the rest.

`configure-github-app-webhook.mjs`'s `REQUIRED_EVENTS` list is the
authoritative source of what the App is _supposed_ to be subscribed to. The
script reads the App's live `events` back from `GET /app` and fails loudly if
anything in `REQUIRED_EVENTS` is missing — it verifies, it does not grant.
Adding a new event to that list (as code review for a feature that needs one)
is necessary but not sufficient: someone with access to the App's settings
still has to flip it by hand, once, before delivery starts.

## Check the current state

No browser needed for this — the same check the script runs:

```sh
gh api /apps/agent-lcars --jq '{permissions, events}'
```

## Grant a new event

1. Confirm the permission the new event needs is already granted. Events are
   grouped by the permission category that exposes them (for example `push`
   needs `Contents: Read`); the checklist below only offers events whose
   permission is already checked. If the permission itself is missing, this
   is not a same-day operation — see below.
2. Sign in as the App owner and open
   `https://github.com/settings/apps/agent-lcars/permissions`.
3. Find the per-permission event checklist (GitHub has relabeled this section
   before, so go by function — the list of webhook events grouped under each
   permission category — rather than a specific heading text) and check the
   box for the new event.
4. Save. GitHub does not require re-confirming unrelated existing permissions
   to add an event under a permission the App already holds.
5. Re-run the verification command above and confirm the event now appears
   in `.events`.

## If the permission itself is also new

Adding a _permission_ the App doesn't already hold (not just a new event
under one it has) requires every installation to individually re-approve the
escalated grant before that installation's deliveries resume — this App is
installed across the whole fleet (`jlapenna/repo-tools`, `jlapenna/homelab`,
`supersprinklesracing/sprinkles`, and more), so budget for a rollout, not a
single click.

## Enabling the subscription is necessary, not sufficient

A checked event box only changes what GitHub _sends_. Whether the console
_does_ anything with it is separate, ordinary code:

- `ADMITTED_EVENTS` in
  `apps/console/src/app/api/control-plane/webhook/route.ts` must include the
  event name, or the delivery is dropped at the door with a 202
  `"unsupported event"`.
- Repository admission is a second, independent gate: the repository must
  belong to `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES`, which matches
  `AGENT_LCARS_WATCHED_REPOS`.

`push` is consumed for agent-event delivery. A branch push schedules a
delayed mergeability read for subscribed PRs targeting that base branch; a
head update schedules the same check for that PR. Unknown mergeability
retries through the durable Cloud Task. These pushes do not admit issue Work.
Agent events do not consume them yet either, which is why `behind` and
`conflict` are not produced (see below).

## Agent events from webhook deliveries

Deliveries for fleet repositories also become `github:pr`, `github:issue` and
`github:run` agent events for sessions subscribed with
`lcars session subscribe` (#3569, step 2 of #3538). This comes after the
existing handling and never changes it:

- The process route (`webhook/process/route.ts`) calls
  `queueGithubAgentEvents` once admission has answered, whatever the answer,
  including when admission fails and will be retried. `workflow_run` and
  `workflow_job` are not queued for admission, so the intake route queues a
  completed run beside its Pub/Sub publish instead. Queuing never throws and
  never changes either route's response; a failed enqueue is logged at error.
- A delivery is queued only when the pure mapping
  (`apps/console/src/lib/github-agent-events.ts`) finds an event in it after
  the actor policy. It goes to the same `dispatch-webhooks` queue as
  admission, as its own task (`github-events-<delivery id>`), targeting
  `/api/control-plane/webhook/events`, which re-verifies the HMAC like
  `/process`. Repeating the enqueue for a delivery is a duplicate.
- The events route reads each affected key's subscriptions once. With no
  matching subscription it stops there. Only when a subscription wants
  `checks-finished` or `threads-resolved` does it make that kind's one GitHub
  read with the App's token: the head's latest check runs, or the pull
  request's review threads. A failed or truncated read produces no event and
  no retry. A routing failure answers 500 and Cloud Tasks retries the
  delivery, up to the same attempt cap as admission.
- Event ids are `github.<X-GitHub-Delivery>.<kind>`, so a redelivery is
  idempotent. `checks-finished` is identified by the head and its newest
  check run instead, so a burst of completions becomes one notice.

The mapping, the actor rule per kind and what is not mapped are documented at
the top of `github-agent-events.ts`. In short: reviews and comments follow
the approval rule (`isTrustedGitHubActor` in `github-actor-trust.ts`: OWNER,
MEMBER, COLLABORATOR or a fleet bot); state changes judge the `sender`,
counting a sender who acts on someone else's pull request or issue as a
COLLABORATOR because GitHub required repository access; check and run
results carry no actor and count only for code in the base repository.
`conflict` and `behind` need a base-branch `push` consumer and are left to a
follow-up.

So landing the consumer code and flipping the settings checkbox are both
required, in either order — neither alone delivers anything.
