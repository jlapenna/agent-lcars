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
single click. `Contents: Read` already covers this fleet's current event
set (`push` included), so this has not come up yet in practice.

## Enabling the subscription is necessary, not sufficient

A checked event box only changes what GitHub _sends_. Whether the console
_does_ anything with it is separate, ordinary code:

- `ADMITTED_EVENTS` in
  `apps/console/src/app/api/control-plane/webhook/route.ts` must include the
  event name, or the delivery is dropped at the door with a 202
  `"unsupported event"`.
- Repository admission is a second, independent gate — `push` specifically is
  scoped by `AGENT_LCARS_PUSH_WATCHED_REPOS`
  (`apps/console/src/lib/push-watch.ts`), deliberately separate from
  `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES`/`AGENT_LCARS_WATCHED_REPOS` so
  subscribing a repo to push notifications never makes its issues/PRs
  eligible for full dispatch. Other event types may use a different gate;
  check the specific handler.

So landing the consumer code and flipping the settings checkbox are both
required, in either order — neither alone delivers anything.
