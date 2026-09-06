# Resumable Conversations — Plan 5: Slack threads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Slack thread is a work item's conversation. `/lcars` files an item and the bot's reply is the thread root; the agent's question comes back into that thread; a thread reply resumes the agent's session.

**Architecture:** Two halves in two repositories, joined only by HTTP — the sanctioned direction of dependency (consumers depend on `agent-lcars`, never the reverse). This repo gains an optional `origin.thread` address and one new outbox delivery case that POSTs a settled run's outcome to a registered webhook. The sprinkles bot gains a visible root message, a thread listener that calls the existing reply route, and a receiver for that webhook. **No new state in either repo**: the item id is carried in the bot's own root message text, so a thread reply recovers it by reading the thread's parent rather than storing a mapping.

**Tech Stack:** TypeScript, zod 4, Vitest, Next.js route handlers, Google ID tokens (the same audience `/lcars` already mints), Slack Bolt (HTTP mode) in `supersprinklesracing/sprinkles`, Nx.

**Spec:** `docs/superpowers/specs/2026-09-03-resumable-agent-conversations-design.md` — "Surfaces → Slack threads", decision 4.

**Depends on:** Plan 1 (`requestReply`, the reply route) — merged and proven live four times. Independent of plans 2–4.

## Decision 4, taken as recommended

**Outbound delivery is the outbox webhook, not bot-side polling.** Delivery then inherits the outbox's lease, retry, backoff, and dead-letter behavior, and sits beside the GitHub outcome comment as one more case of the same mechanism. Polling would put per-item dedupe state inside the bot — a second source of truth in a repository that should stay a thin consumer.

Recorded as an assumption, reversible: the whole outbound half is one `handleReportOutcome` branch plus one env var.

## Global Constraints

- **No cross-repository source imports or shared build contexts** (`AGENTS.md`). The only coupling is HTTP plus the shared token audience. Do not add a package dependency in either direction.
- **No new persistent state.** The bot's root message carries the item id; a thread reply recovers it from the thread parent. If that proves impossible, stop and raise it rather than inventing a store.
- **The webhook carries only what the console already renders** — item id, run id, state, and `Run.result.message`/`ref`. No transcript content leaves the bucket.
- **Authentication reuses what exists**: the console signs with its runtime identity's Google ID token; the bot verifies the audience and the expected service account. `/lcars` already mints a token to the console this way, so this is the same trust relationship in the other direction, not a new one.
- **Fail soft outbound.** A webhook failure must behave like any other outbox delivery failure — released with backoff, retired after the existing window — never a lost run or a crashed drain.
- **Do not weaken `/lcars`'s existing allow-list.** Thread replies are accepted only from users already authorized for `/lcars`.
- Every new env var must be registered in `libs/env-vars/src/env-vars.ts` first, or the whole monorepo fails typecheck at once.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BHX94T4vWdYy5jCCFyy7TZ
  ```

## File Structure

**This repository (`agent-lcars`):**

| File                                                     | Responsibility                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `libs/work/src/spec.ts` (modify)                         | `workOriginSchema`: `'slack'` channel, optional `thread` address      |
| `libs/work/src/contract.ts` (modify)                     | `create`'s origin accepts the new channel/thread; OpenAPI regenerated |
| `apps/console/src/lib/outcome-webhook.ts` (create)       | Resolve a channel's webhook target; POST the outcome, signed          |
| `apps/console/src/lib/orchestrator-dispatch.ts` (modify) | `handleReportOutcome` gains the thread-bearing delivery case          |
| `libs/env-vars/src/env-vars.ts` (modify)                 | `AGENT_LCARS_OUTCOME_WEBHOOKS`                                        |
| `apps/console/apphosting.yaml` (modify)                  | Declare it — **with a real value or not at all**, never `value: ''`   |

**The bot (`supersprinklesracing/sprinkles`):**

| File                                                     | Responsibility                                                |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/members/bot/src/modules/lcars/work.ts` (modify)    | Send `origin.thread`; expose the item-id marker format        |
| `apps/members/bot/src/modules/lcars/lcars.ts` (modify)   | Visible root message; thread listener calling the reply route |
| `apps/members/bot/src/modules/lcars/outcome.ts` (create) | Verified receiver that posts an outcome into its thread       |

---

### Task 1: An origin can name a thread

**Files:** `libs/work/src/spec.ts`, `libs/work/src/contract.ts`; tests alongside.

- [ ] **Step 1: Write the failing test**

```ts
it('accepts a slack origin carrying a thread address', () => {
  expect(
    workOriginSchema.parse({
      principal: 'svc:sprinkles-lcars-bot',
      channel: 'slack',
      thread: 'T0123/C0456/1788673935.123456',
    }).thread,
  ).toBe('T0123/C0456/1788673935.123456');
});

it('still accepts an origin with no thread', () => {
  expect(
    workOriginSchema.parse({ principal: 'user:jlapenna', channel: 'console' })
      .thread,
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail** — `'slack'` is not in the enum and `thread` is rejected by `z.strictObject`.

- [ ] **Step 3: Extend the schema**

```ts
export const workOriginSchema = z.strictObject({
  principal: z.string(),
  channel: z.enum(['api', 'cron', 'console', 'github', 'slack']),
  /** Opaque channel address the originating adapter uses to deliver this
   *  item's outcomes back to where it came from -- for Slack, the root
   *  message's `team/channel/ts`. Only that adapter interprets it; the
   *  control plane treats it as a string and never parses it. Written once
   *  with the rest of `work`, so `requestRun`'s write-once rule is
   *  unaffected. */
  thread: z.string().max(512).optional(),
});
```

- [ ] **Step 4: Run the tests, regenerate OpenAPI, commit.**

---

### Task 2: A settled run's outcome reaches its thread

**Files:** `apps/console/src/lib/outcome-webhook.ts` (create), `orchestrator-dispatch.ts`, `libs/env-vars/src/env-vars.ts`, `apphosting.yaml`; tests alongside.

**Interfaces:**

```ts
/** `{"slack":{"url":"https://…","audience":"…"}}` — a JSON map from
 *  `origin.channel` to its delivery target. Absent or empty means no
 *  channel has a webhook, and delivery is skipped entirely. */
export function outcomeWebhookFor(
  channel: string,
): { url: string; audience: string } | undefined;

export async function deliverOutcomeWebhook(
  target: { url: string; audience: string },
  payload: OutcomeWebhookPayload,
): Promise<void>; // throws on non-2xx, so the outbox treats it like any delivery failure
```

Payload — deliberately small, and nothing the console does not already render:

```ts
interface OutcomeWebhookPayload {
  itemId: string;
  runId: string;
  state: 'finished' | 'canceled' | 'lost';
  ok: boolean;
  parked: boolean;
  message?: string; // Run.result.message
  ref?: string; // e.g. the PR URL
  thread: string; // origin.thread, echoed back for the adapter to route on
  consoleUrl: string;
}
```

- [ ] **Step 1: Write the failing tests**

- `outcomeWebhookFor` returns the configured target; returns `undefined` for an unconfigured channel and when the variable is absent or malformed (never throws — a bad config must not break the drain).
- `handleReportOutcome` delivers the webhook for a native item whose origin has `channel: 'slack'` and a `thread`, with the payload shape above.
- It delivers **nothing** when the origin has no `thread`, when the channel has no configured target, or for a GitHub anchor (which keeps its outcome comment — regression pin).
- A webhook failure releases the entry for retry rather than settling it `done`, matching the existing GitHub-comment failure path.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement**, registering `AGENT_LCARS_OUTCOME_WEBHOOKS` in `libs/env-vars/src/env-vars.ts` first. Sign with the console's runtime identity ID token for the target's `audience`, the same mechanism `work-auth.ts` verifies on the inbound side.

  In `apphosting.yaml`, declare it **only with a real value**. Off is expressed by omitting the variable — never `value: ''`, which App Hosting rejects and which blocked deploys for five hours (#1776).

- [ ] **Step 4: Run tests, regenerate OpenAPI if the contract moved, commit.**

---

### Task 3 (sprinkles): the thread becomes the conversation

**Repository:** `supersprinklesracing/sprinkles`. Separate PR, separate review. Land Tasks 1–2 first: this half calls the contract they define.

- [ ] **Step 1: Root message carries the item id**

`lcars.ts` currently answers `/lcars` **ephemerally**. Change it to post a visible message in the channel, whose text contains the item id in a stable, greppable form, e.g.:

```
Filed Agent LCARS task `01M12NS…` for `supersprinklesracing/girosf` — replies in this thread go to the agent.
```

Record that message's `team/channel/ts` and send it as `origin.thread` when creating the item (`work.ts`'s `createLcarsWorkItem` gains the field).

**This is what removes the need for a store**: the item id lives in the thread's own root message.

- [ ] **Step 2: Thread replies call the reply route**

Add a `message` listener for `message.channels` (already a subscribed bot event). Act only when **all** hold, and ignore silently otherwise:

- the message has a `thread_ts` and is not itself the root;
- the thread's root message was authored by this bot and matches the item-id marker;
- the sender is in `/lcars`'s existing `ALLOWED_USER_IDS`;
- the message is not from a bot.

Then `POST /api/work/v1/items/{id}/reply` with `{ text }`, using `getServiceAuthHeaders` exactly as `createLcarsWorkItem` already does. Surface a refusal (`CONFLICT` while a run is live) as a short threaded reply so the human knows the agent is still working.

- [ ] **Step 3: Receive outcomes**

Add one authenticated route to the bot's existing HTTP receiver. Verify the Google ID token: correct audience, and issued by the console's expected service account. Reject anything else with 401 — do not post on an unverified call.

On success, `chat.postMessage` into `payload.thread` with the agent's `message`, its `ref` when present, and a link to `consoleUrl`.

- [ ] **Step 4: Tests** in the bot's own style (`lcars.test.ts`, `work.test.ts` are the models): root message shape and id extraction; the four listener gates; the reply call; token verification accept/reject.

---

### Task 4: Land, then prove it

- [ ] **Step 1: Land Tasks 1–2 here**, then Task 3 in sprinkles, in that order — the bot calls a contract that must already exist.

- [ ] **Step 2: Configure.** Set `AGENT_LCARS_OUTCOME_WEBHOOKS` to the bot's receiver. **Maintainer-gated**; do not deploy directly.

- [ ] **Step 3: Real-path proof (spec proof 5)** — maintainer-gated

1. `/lcars girosf <a task that asks a question and parks>`; confirm the visible root message names the item id.
2. Confirm the item's `origin` carries `channel: 'slack'` and the thread address.
3. When the run parks, confirm the agent's question arrives **in that thread**.
4. Reply in the thread; confirm a reply run is minted carrying `resumeSessionId`.
5. Confirm the resumed round continues the same session — **judged on session identity** in `gs://agent-lcars-session-transcripts/runs/<runId>/<adapter>/`, not on a recalled value (see the 2026-09-06 correction in the smoke runbook).
6. Negative cases: a reply from a non-allow-listed user does nothing; an unverified POST to the receiver is rejected 401.
7. Record in `docs/native-work-smoke-runbook.md`.

---

## Self-review

**Spec coverage.** Implements the spec's "Slack threads" paragraph: `origin.thread`, the `slack` channel, the outbox webhook case, and the bot's root message, thread listener, reply call, and receiver.

**Deviations, recorded.**

1. The spec left decision 4 open. This plan takes the recommended outbox webhook and says so, with the reversal named (one branch, one variable).
2. The spec did not say how the bot maps a thread back to an item. This plan carries the item id **in the bot's own root message** rather than adding storage, which is why "no new state" is a global constraint rather than an aspiration. If the bot cannot read its thread's root, the design needs revisiting — flagged as the one assumption that would force a store.
3. The spec's payload sketch is tightened to an explicit interface, and deliberately excludes anything not already rendered by the console.

**The risk worth naming.** This is the first outbound HTTP call the drain makes to a non-GitHub target. Its failure mode is covered by the existing outbox machinery, but a misconfigured or slow webhook now sits in the same retry budget as GitHub delivery. If that proves noisy, the narrow fix is a per-channel failure counter that retires webhook entries sooner than GitHub ones — not a second delivery mechanism.

**Not in scope.** Slack-side rendering beyond a plain threaded message; multiple threads per item; Slack as a _dispatch_ trigger beyond the existing `/lcars`; and any change to `/lcars`'s authorization model.
