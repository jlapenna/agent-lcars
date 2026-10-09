# Agent LCARS product spec, part 1: the console

- **Status:** Product specification of record for the console. Originally written
  from `main` at `608500a`; E2E coverage and mute behavior were
  reviewed against `e4b1baa` (2026-10-09). Part 2 is
  [fleet management and orchestration](fleet-orchestration-product-spec.md).
- **Authority:** Code, configuration, and generated contracts define current
  behavior. When this spec and the code disagree, the code wins and this spec
  should be corrected. The visual rules are owned by
  [`console-design-system.md`](../console-design-system.md). The Work API
  contract is owned by [`libs/work`](../../libs/work) and
  [`work-v1.openapi.json`](../api/work-v1.openapi.json).
- **How to read it:** each requirement has an ID (`FE-…`) and is marked
  **[Shipped]**, **[Partial]**, or **[Proposed]**. Shipped and partial items
  describe what exists today. Proposed items are the recommended backlog in
  [§10](#10-gaps-and-roadmap).

---

## 1. Product summary

The Agent LCARS console (`apps/console`, served at `lcars.jlapenna.net`) is the
human control surface for a fleet of headless coding agents (Claude Code,
Codex, OpenCode). Those agents work GitHub issues, pull requests, and native
work items across a set of onboarded repositories.

The console answers four questions, in this order:

1. **What needs me?** The decision queue (Bridge and Inbox).
2. **What is the fleet doing right now?** Agents and Shuttlebay.
3. **What did I ask for, and where is it?** Work, Schedules, and task detail.
4. **What happened, and what did it cost?** Sessions and Costs.

It is a Next.js App Router application that uses Mantine UI and an
LCARS-inspired visual system. It reads durable state from Firestore (the
orchestrator store and the telemetry store) and from the GitHub API. It writes
only through server actions and the authenticated Work API, never directly to
GitHub from the browser.

## 2. Users and jobs to be done

| Persona                       | Today                                                                                                                                                                                   | Primary jobs                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maintainer (admin)**        | Logins in the sign-in allowlist `AGENT_LCARS_ADMIN_GITHUB_LOGINS` (currently `jlapenna` and `lizsprinkles`)                                                                             | Clear decisions such as merging, replying, or retriggering. Dispatch new work. Notice stuck or failed agents. Audit sessions and spend. Do all of this from a phone. |
| **Production verifier**       | Login `agent-lcars-production-verifier`. It is not on the allowlist; its admin session JWT is minted directly with `AUTH_SECRET`, and it holds the Work grant `svc:production-verifier` | Run authenticated live-UI verification and Work API operations within an approved task                                                                               |
| **Work operator (non-admin)** | Modeled by Work grants, but blocked in practice because sign-in is limited to admins                                                                                                    | Issue and follow native work without access to the decision queue                                                                                                    |
| **Machine callers**           | Agents, the `lcars` CLI, CI workflows, the Slack bot                                                                                                                                    | Call the Work API. They are not console UI users, but `/work` must render what they create                                                                           |

**Design center:** a small set of expert maintainers supervising many concurrent agents,
often from a phone. Every screen is optimized to get to a decision fast and to
show trustworthy freshness, not to give a general project-management view.

## 3. Goals and non-goals

**Goals**

- G1. A single prioritized queue of everything that needs a human, with the
  primary action available on the card itself.
- G2. Honest, authoritative status. What the console shows comes from the
  orchestrator store and webhooks, not from inference over GitHub alone, and
  the console says when the data is stale or degraded.
- G3. Every agent outcome can be traced from the queue to its task, run,
  session, transcript, and deliverable (PR or comment).
- G4. Full functionality from 320px to desktop widths.
- G5. One coherent visual system that cannot drift route by route.

**Non-goals**

- A general issue tracker or project board. GitHub remains the system of
  record for issues and PRs.
- Multi-tenant SaaS. The console serves one fleet, its allowlisted
  maintainers, and its onboarded repositories.
- Editing infrastructure, credentials, grants, or runner capacity from the UI.
  Those changes go through reviewed configuration and Homelab.

## 4. Information architecture

Navigation comes from a single registry, `CONSOLE_DESTINATIONS` in
`apps/console/src/app/console-navigation.ts`. That registry drives the desktop
rail, the mobile overflow menu, and the per-destination accent.

| Destination | Route         | Accent     | Purpose                                                         | Access                   |
| ----------- | ------------- | ---------- | --------------------------------------------------------------- | ------------------------ |
| Bridge      | `/`           | amber      | Operational overview: decisions summary, stopped work, live ops | admin                    |
| Inbox       | `/inbox`      | blue       | Decision queue with per-item actions                            | admin                    |
| Agents      | `/agents`     | periwinkle | Live runs, CLI sessions, claimed-but-idle, recent outcomes      | admin                    |
| Shuttlebay  | `/shuttlebay` | blue       | Runner fleet and queue-executor capacity, live                  | admin                    |
| Work        | `/work`       | violet     | Native work items, with Schedules as a sub-route                | any session + Work grant |
| Sessions    | `/sessions`   | teal       | Session archive: CLI and dispatched agents, with transcripts    | admin                    |
| Costs       | `/costs`      | gold       | Cost ledger by issue and by week                                | admin                    |

Secondary routes: `/work/[id]`, `/work/schedules`, `/sessions/[id]`,
`/task/[owner]/[repo]/[issue]`, `/login`, and the error, not-found, and loading
message states.

Shared URL state:

- `?repo=owner/name` scopes Bridge, Inbox, and Agents and survives navigation
  between them.
- `?sel=` (Bridge) and `?item=owner/name#N` (Inbox) make the selection
  addressable by URL.

## 5. Cross-cutting requirements

### 5.1 Authentication and authorization

- **FE-AUTH-1 [Shipped]** Sign-in uses Auth.js with GitHub OAuth (scopes
  `repo read:user user:email`). The session is a JWT cookie encrypted with
  `AUTH_SECRET`. The `signIn` callback rejects any login not in
  `AGENT_LCARS_ADMIN_GITHUB_LOGINS`. A rejected login is sent to
  `/login?error=AccessDenied` with an explanatory message. Sessions minted
  outside OAuth, such as the production verifier's, skip this check.
- **FE-AUTH-2 [Shipped]** `proxy.ts` gates every path behind a session cookie.
  The exceptions are `/login`, `/api/logs/error`, the webhook routes, and the
  bearer- or capability-authenticated prefixes `/api/work/v1/`,
  `/api/quick-task-evidence/v1/`, and `/api/e2e/` (the last only in E2E mode).
- **FE-AUTH-3 [Shipped]** Admin pages call `assertAdmin`. Two kinds of
  server action exist:
  - Queue actions (`app/actions.ts`) check admin status and return
    `{ok:true, note?} | {ok:false, message}`. The admin check runs before the
    action body, so an unauthorized call throws `Unauthorized`.
  - Work and schedule actions (`app/work/**/actions.ts`) are oRPC procedures
    authorized by the caller's Work grant, not by admin status. They return
    `[error, data]` tuples.
- **FE-AUTH-4 [Shipped]** Work API authorization is separate from admin
  status. The session's `github:<login>` is mapped to a principal and scopes
  through `AGENT_LCARS_WORK_GRANTS`. On `/work*` the UI offers creation
  controls only when the principal holds `work.operator`, and shows "Your
  GitHub login has no work grant" when it holds none. Admin destinations
  always show New work in the header, and the server rejects the request
  when no grant applies.
- **FE-AUTH-5 [Shipped]** The user's GitHub OAuth token stays server-side. It is
  used so that the human, not the bot, is recorded as the author where
  authorship matters, such as evidence-backed work.
- **FE-AUTH-6 [Proposed]** Allow non-admin sign-in for logins that hold a Work
  grant. Restrict them to `/work*` and hide admin destinations from their
  navigation. See [§10](#10-gaps-and-roadmap) R5.

### 5.2 Freshness and live data

- **FE-LIVE-1 [Shipped]** Dashboard reads use the Next `'use cache'` directive
  with a 30s stale and revalidate window. Webhook processing invalidates the
  authoritative-queue tag, and server actions invalidate the dashboard after
  any mutation.
- **FE-LIVE-2 [Shipped]** Bridge, Inbox, Agents, Sessions, and Costs show
  `DataFreshness` ("Updated Xs ago", with a 30s tick) and `DataWarnings` when a source is degraded, such as
  a failed GitHub read. The header Refresh control forces revalidation.
- **FE-LIVE-3 [Shipped]** Shuttlebay streams runner status over SSE
  (`/api/runner-status/stream`, backed by a Firestore `onSnapshot`). The client
  reconnects with exponential backoff. Status older than 180s is labeled stale.
- **FE-LIVE-4 [Proposed]** Push queue and agent changes to Bridge, Inbox, and
  Agents using the same SSE pattern. Today those pages update only on
  navigation or Refresh.

### 5.3 Visual system

These rules are owned by [`console-design-system.md`](../console-design-system.md)
and enforced by `design-system-contract.test.ts`. They are summarized here as
product requirements.

- **FE-DS-1 [Shipped] One ground.** The whole console uses `--lcars-surface`.
  Regions are separated by hairlines or gutters, never by a second black.
- **FE-DS-2 [Shipped] One accent per destination**, declared once in the accent
  table. Status color (`--lcars-warning`) and the focus ring do not follow the
  route accent.
- **FE-DS-3 [Shipped] Flat controls.** There is one primary (full accent) action
  per context, and secondary actions use a 52% mix. No bevels, gradients, or
  shadows.
- **FE-DS-4 [Shipped]** There is one LCARS elbow per page, in the header.
  Panels use square spines, and card radius is 0.
- **FE-DS-5 [Shipped] One frame.** Every destination and sub-route renders
  inside `ConsoleWorkspace`. Every empty, error, and access state renders
  through `ConsoleMessage`.
- **FE-DS-6 [Shipped]** Dark mode is the default and light mode is available.
  The choice persists in the `mantine-color-scheme` cookie. Typography is
  Antonio for display, IBM Plex Sans for body text, and a monospace face.

### 5.4 Responsive behavior and accessibility

- **FE-RESP-1 [Shipped]** Breakpoints:
  - 22em: small phones.
  - 48em (768px): the header splits into two rows, a title/action row and a
    destination rail. Below 48em, navigation moves into the overflow menu.
  - 64em (1024px): Bridge and Inbox become two-pane layouts. Below 64em they
    swap from list to detail.
- **FE-RESP-2 [Shipped]** Layout is verified at 320, 390, 768, 1024, and
  1280px. The page never scrolls horizontally, and header actions never
  overflow.
- **FE-A11Y-1 [Partial]** WCAG AA text contrast in both color schemes is
  enforced by E2E on Bridge, Inbox, Agents, and Costs. The one-ground check
  covers all seven destinations. **Proposed:** extend the contrast check to
  Shuttlebay, Work, and Sessions.
- **FE-A11Y-2 [Shipped]** Every menu and icon action has an aria-label. The
  Inbox can be worked entirely from the keyboard, Tab order across the rail is
  correct, and `prefers-reduced-motion` is honored.

## 6. Destination requirements

### 6.1 Bridge (`/`)

**Purpose:** the landing page, showing in one glance the decisions waiting,
the work that has stopped, and the work in flight.

- **FE-BR-1 [Shipped]** `DeckInboxSummary` shows "No decisions waiting" or
  "Open N decisions" and links to `/inbox`.
- **FE-BR-2 [Shipped]** `ParkedWorkPanel`, titled "Stopped work (N)", lists
  native and GitHub-anchored tasks whose latest run is parked or failed.
  Native rows offer **Cancel** and **Redispatch**. GitHub-anchored rows link
  out instead: "Redispatch on GitHub (remove and re-add its agent:\* label)".
  The panel needs `work.operator`,
  reads up to 200 tasks, and shows a "more" indicator past that.
- **FE-BR-3 [Shipped]** `AgentActivityPanel` ("Operations") shows:
  - In-flight runs, each with time and turn budget gauges (120 min and 200
    turns; anything at 95% or more of the budget is flagged as a likely
    timeout).
  - Recent outcomes.
  - Active CLI sessions.
  - A fleet chip. It is vestigial: it counts runners from the retired
    scale-set status documents, so it renders nothing in production unless
    the status read fails ("Runner status unavailable"). See R12.
- **FE-BR-4 [Shipped]** The "Waiting on Deploy" (`post-deploy-action`) and
  "Blocked" (`blocked`) sections hold waiting items. These are intentionally
  kept out of the decision queue.
- **FE-BR-5 [Shipped]** Selecting a row opens `BridgeDetail` in the right pane
  on desktop, and navigates to it on mobile.

### 6.2 Decision Inbox (`/inbox`)

**Purpose:** work the queue to zero.

- **FE-IN-1 [Shipped] Queue composition.** Items are sorted by the priority
  tier of their reason. The table is `ACTION_PRIORITY` in
  `lib/action-items.ts`.

  | Tier | Reason               | Label            | Meaning                                                |
  | ---- | -------------------- | ---------------- | ------------------------------------------------------ |
  | 0    | `needs-human`        | Human needed     | An agent parked with a question (`status:needs-human`) |
  | 0    | `review-requested`   | Review requested | A PR is awaiting the maintainer's review               |
  | 0    | `merge-blocked`      | Merge blocked    | A PR is ready in principle but cannot merge            |
  | 1    | `ready-for-agent`    | Ready for agent  | Labeled `status:ready-for-agent` but not dispatched    |
  | 1    | `run-failed`         | Run failed       | The agent run failed                                   |
  | 1    | `silent-error`       | Silent error     | The run ended "successfully" without evidence          |
  | 2    | `post-deploy-action` | Awaiting deploy  | Wait reason, shown on the Bridge only                  |
  | 2    | `blocked`            | Blocked          | Wait reason, shown on the Bridge only                  |

  Tier-2 wait reasons are excluded from the Inbox and its filter.

- **FE-IN-2 [Shipped] Primary action** (`lib/primary-action.ts`). Each card
  shows at most one primary action chosen from its state: **Approve & Merge**,
  **Approve & Rebase**, **Reply**, or **Open failing check ↗**. The last
  appears only on a `run-failed` item that has a failing check.
- **FE-IN-3 [Shipped] Reply and hand-off.** "Reply…" opens a text field and a
  segmented control. On an unassigned issue with no `agent:*` label the
  choices are _Comment only_ plus each pipeline's reply trigger (`@claude`,
  `/codex`, `/oc`). Choosing a trigger posts the comment as a reply command,
  which dispatches that pipeline, and the button then reads "Reply &
  dispatch".
- **FE-IN-4 [Shipped] Secondary actions:**
  - **Retrigger**, for issues that already have a pipeline assignment, with
    an optional steering note. It goes through server-owned Work admission
    with request ID `console-retry:<uuid>`.
  - **Unstick**, for `run-failed` PRs.
  - **Work locally**, which copies a takeover prompt for a local agent and
    posts nothing.
- **FE-IN-5 [Shipped] Overflow menu:**
  - Edit issue (title and body)
  - Approve & Merge, Approve & Rebase, or Rebase onto base
  - Assign to {pipeline}
  - Clear needs-human
  - Mute or Unmute
  - Close issue (destructive, with confirmation)
- **FE-IN-6 [Shipped]** A filter by reason, the `?repo=` scope, and the
  addressable `?item=` selection. On mobile, a command deck provides "Back to
  Inbox list".
- **FE-IN-7 [Partial]** Mute is stored per browser in localStorage
  (`agent-lcars:muted-queue-items`). It is not shared across devices.
  New mutes expire when the signature of `updatedAt`, sorted `actionTypes`,
  or `ciRunning` changes; migrated legacy mutes retain no-expiry behavior.
  The owner is [`use-muted-items.ts`](../../apps/console/src/app/use-muted-items.ts),
  with regression coverage in `use-muted-items.test.ts`.
  **Proposed:** a server-side snooze with a time-based expiry shared across
  devices.

### 6.3 Agents (`/agents`)

**Purpose:** a live operational view of every agent and claim.

- **FE-AG-1 [Shipped]** `FleetSnapshotBar` shows, per pipeline, live runs,
  active CLI sessions, the (vestigial) fleet chip, and activity metrics.
- **FE-AG-2 [Shipped]** **Active Agents** shows runs classified as `running`,
  `succeeded`, `failed`, `timeout`, `cancelled`, or `silent-error`, each with a
  diagnosis string.
- **FE-AG-3 [Shipped]** **Claimed but Idle (N)** lists claimed anchors with
  no live run. An anchor counts as claimed when it is assigned to
  `agent-lcars-bot` or has an orchestrator task record. Each row carries a
  reason: `never-dispatched`, `finished`, `parked`, `failed`, `lost`,
  `canceled`, or `observing`. The `observing` reason ("Observing until …")
  comes from an `<!-- agent-lcars:observe-until <ISO> -->` marker. Claims are
  suppressed when the anchor has a human assignee or a `status:needs-human`,
  `status:blocked`, `status:ledger`, or `bot:renovate` label.
- **FE-AG-4 [Shipped]** **Recent Outcomes** links each outcome to its task,
  session, and deliverable.
- **FE-AG-5 [Shipped]** The logical work state comes from the authoritative
  orchestrator store. It is one of `dispatching`, `active`, `human-needed`,
  `completed`, `anomaly`, `unknown`, or `unavailable`, with a provenance of
  `authoritative`, `no-history`, or `unavailable`.

### 6.4 Shuttlebay (`/shuttlebay`)

**Purpose:** answer "is there capacity, and is the executor healthy?"

- **FE-SB-1 [Shipped]** The queue executor shows a `ready` or `not ready`
  badge, a `draining` badge, and its active and maximum Job counts.
- **FE-SB-2 [Shipped]** Each ARC lane (status documents published by the
  executor) shows pending, running, idle, registered, desired, and maximum
  runners. A legacy scale-set row (queued, busy, idle, max, draining, and a
  runner list) still renders the retired v1 documents, which are no longer
  published.
- **FE-SB-3 [Shipped]** The data is live over SSE, and a staleness banner
  appears after 180s.
- **FE-SB-4 [Proposed]** Show claim throughput and provider cooldowns:
  pipeline X is cooling down until T after a `provider-limit` failure.
  Operators currently have to infer this from failures.

### 6.5 Work (`/work`, `/work/[id]`, `/work/schedules`)

**Purpose:** issue and follow native work items that are independent of
GitHub issues, and manage recurring work.

- **FE-WK-1 [Shipped]** The list is a table with columns Title, State,
  Pipeline, Repo, Principal, and Updated, showing up to 200 rows. State is one
  of `running`, `parked`, `done`, `failed`, or `canceled`. It is derived and
  never stored.
- **FE-WK-2 [Shipped] Create work** ("New work" in the header; see FE-AUTH-4
  for when it is shown):
  - Fields: Repo, Agent, Description, and an optional screenshot (paste or
    attach).
  - The work ID is a ULID minted on the client, so retries are idempotent.
  - The chosen agent is remembered in localStorage.
  - Screenshots are normalized to WebP and stored in the evidence bucket, with
    a 10 MiB limit. They are served at `/api/quick-task-evidence/v1/<id>`
    under a revocable capability ID.
  - When opened from a session, run, or task detail page, the source identity
    is attached to the item.
- **FE-WK-3 [Shipped] Item detail:**
  - A state badge (parked yellow, failed red, running blue, done green,
    canceled gray), with repo and pipeline.
  - Editable title and description, hidden while the item is running.
  - The **Conversation**: for each round, the human turn (with its principal
    and channel) and the agent's final message.
  - A runs table with Run, State, Executor (claimed by), Result, Summary, and
    Ref. The Ref link is guarded by `safeHttpUrl`.
  - Linked sessions, with a "pinned" badge while the item is still active.
- **FE-WK-4 [Shipped] Item actions:**
  - **Reply** when the item is parked, failed, or done. The reply resumes the
    prior provider session when a resumable transcript exists, and otherwise
    says that a fresh session was started.
  - **Redispatch** when parked or failed.
  - **Cancel** unless the item is done or canceled.
- **FE-WK-5 [Shipped] Schedules:**
  - The create form takes Title, Description, Repository, Pipeline, Cron (5
    fields, UTC, default `0 * * * *`, validated on the client), and Enabled.
    The server also rejects a cron expression that never fires within a
    year.
  - The list has columns Title, Cron, Pipeline, Repo, Enabled, and Last item,
    and supports enable and disable.
  - The API and store record a `disabledReason` (`grant-revoked`, `operator`,
    or `invalid`), but the list does not show it.
- **FE-WK-6 [Partial]** The UI has no paging past 200 items and no filters,
  although the Work API already supports a cursor and state, principal, and
  repo filters. Schedules have no edit or delete in the UI or the API (a
  `PUT` accepts only a new or identical schedule), and no time zone other
  than UTC. See R3 and R8.

### 6.6 Task detail (`/task/[owner]/[repo]/[issue]`)

- **FE-TK-1 [Shipped]** "Task #N" shows the GitHub-anchored logical work card
  (state, provenance, actions) and the orchestrator's run history for that
  anchor.
- **FE-TK-2 [Proposed]** Unify this page with `/work/[id]` so that both anchor
  kinds share one item view: conversation, runs, sessions, and actions. The
  orchestrator already stores them as the same `Task` type.

### 6.7 Sessions (`/sessions`, `/sessions/[id]`)

**Purpose:** the durable audit record of every agent session, both interactive
CLI sessions and dispatched runs.

- **FE-SE-1 [Shipped]** Filters:
  - `days`: default 14, maximum 90.
  - `source`: `cli` or `issue-agent`.
  - `issue` and `repo`.
  - `view`: `by-issue` (the default, grouped, with older groups behind a
    disclosure on phones) or `flat`.
- **FE-SE-2 [Shipped]** The flat table shows Source, Session, Issue, PRs,
  Host/Run, Requested model/route, Resolved backend, Turns, Cost-weighted
  tokens, Cost, Started, Duration, and Status.
- **FE-SE-3 [Shipped]** Session detail shows badges for source, liveness
  (`live`, `idle`, `ended`, `stale`), and agent. Below them it shows the
  model, route, and resolved backend; permission mode; turns, tokens, and
  cost; timing; host, cwd, worktree, and branch; run and issue; deliverables;
  and resume notes.
- **FE-SE-4 [Partial]** Transcripts render (`TranscriptTimelineView`, from GCS)
  for dispatched `issue-agent` sessions whose agent is in
  `RENDERABLE_TRANSCRIPT_AGENTS`, currently Claude Code and Codex. OpenCode
  sessions show "Session archive stored ({agent} format) — not yet
  renderable", and CLI sessions have no transcript view. **Proposed:** render
  OpenCode transcripts and CLI sessions through the existing
  `libs/telemetry` adapters.
- **FE-SE-5 [Shipped]** A session's title is the transcript's own title
  (Claude Code's `aiTitle`) unless `lcars session title` sets an override, and
  `lcars session status` adds a status line. A session that drifts from its
  opening prompt can therefore say what it has become.

### 6.8 Costs (`/costs`)

- **FE-CO-1 [Shipped]** Two ledgers, by issue and by ISO week. Each shows
  sessions, turns, cost-weighted tokens, and cost. The window and source
  filters are shared with Sessions. When a provider reports no `costUSD`, cost
  is estimated from `MODEL_RATES`.
- **FE-CO-2 [Proposed]** Add breakdowns by pipeline and by model, budget
  thresholds with alerting, and a cost-per-merged-deliverable metric.

## 7. Server surface owned by the console

| Route                                       | Auth                                               | Role                                                                     |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| `/api/auth/[...nextauth]`                   | public                                             | Auth.js                                                                  |
| `/api/work/v1/*`                            | bearer (Google ID token or GitHub OIDC) or session | Work API: items, dispatches, schedules, runs, maintenance. See part 2 §6 |
| `/api/control-plane/webhook` and `/process` | HMAC plus Cloud Tasks                              | GitHub App intake. See part 2 §4                                         |
| `/api/runner-status` and `/stream`          | admin session                                      | Shuttlebay JSON and SSE                                                  |
| `/api/quick-task-evidence/v1/[id]`          | capability ID                                      | Screenshot evidence bytes; revocable                                     |
| `/api/logs/error`                           | public                                             | Browser error reporting                                                  |
| `/api/e2e/*`                                | `E2E_TESTING` only                                 | Seeding and fake GitHub for hermetic E2E                                 |

Boot invariants (`lib/startup-configuration.ts`): the console refuses to
start with a blank required variable, a malformed App key, a missing
deployment identity, invalid Work grants or outcome webhooks, or
`AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` that differs from
`AGENT_LCARS_WATCHED_REPOS`. The error names the variable but
never prints the secret.

## 8. Companion CLI (`lcars`)

The CLI is packaged with `apps/telemetry-watcher`. It is the terminal
counterpart of the Work destination.

- `lcars work create --repo --pipeline --title (--description | --description-file)`
- `lcars work status <id> [--watch]`, `list [--state] [--repo]`,
  `cancel <id>`, and `redispatch <id>`
- `lcars session title "<text>" | --clear` and `lcars session status "<text>" | --clear`

`status --watch` polls every 15 seconds while the item is `running`, including
lost runs awaiting automatic retry. It stops on `done`, `parked`, `failed`, or
`canceled` without another sleep or request. `status` prints the final state and
exits 1 for `failed` work, with or without `--watch`; other item states exit 0.
`list --state` accepts `running`, `done`, `parked`, `failed`, and `canceled`.

The CLI authenticates with `LCARS_TOKEN`, or with `LCARS_SERVICE_ACCOUNT` and
`LCARS_AUDIENCE` through impersonation. A bearer token that fails never falls
back to cookies. **Proposed:** add `lcars work reply` for parity with the
console Reply action.

## 9. Non-functional requirements

| ID      | Requirement                                                                                                                                    | Status   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FE-NF-1 | Every page streams: a `Suspense` boundary with a `NavPageLoading` header renders before data arrives                                           | Shipped  |
| FE-NF-2 | No secret (App key, `AUTH_SECRET`, OAuth token, cookies) ever reaches the client or the logs                                                   | Shipped  |
| FE-NF-3 | External links that come from agent output pass through `safeHttpUrl`                                                                          | Shipped  |
| FE-NF-4 | Hermetic E2E (Playwright against the standalone build, the Firestore emulator, and fake GitHub) covers each journey                            | Partial  |
| FE-NF-5 | The production build is a standalone bundle and has a smoke test from an isolated copy; Google Cloud clients are kept out of the server bundle | Shipped  |
| FE-NF-6 | Deploys happen only through `deploy-console.yml`, triggered by green CI on `main`                                                              | Shipped  |
| FE-NF-7 | P95 time to interactive on the Inbox under 2s on a mid-range phone                                                                             | Proposed |

**E2E journeys covered today:**

- Every Inbox reason and its detail.
- Retrigger through Work admission.
- Edit issue.
- URL-addressed selection and repo scope.
- Keyboard Inbox.
- The phone list-to-detail flow, including Inbox reply input visibility and
  reply control touch-target size in
  [`populated-dashboard.spec.ts`](../../apps/console-e2e/src/populated-dashboard.spec.ts).
  This is partial reply coverage, not a submitted reply or dispatch journey.
- Agents and Sessions at every viewport.
- The Costs ledger.
- Shuttlebay page structure (heading and copy only; the stream is not
  exercised).
- Creating native work through the New work modal.
- Interaction states.
- One ground on every destination, and contrast on Bridge, Inbox, Agents,
  and Costs.
- Header bounds at phone, tablet, and desktop widths.

**Not covered:**

- `/work` list content, and `/work/[id]` reply, redispatch, cancel, and
  edit.
- `/work/schedules`: create, enable, and disable.
- `/task/...` beyond the "Open task" navigation.
- Inbox reply submission, trigger selection, and dispatch hand-off.
- Merge and rebase end to end.
- Unstick.
- Shuttlebay live updates and SSE reconnect.

## 10. Gaps and roadmap

Priorities assume the single-maintainer design center.

| #   | Item                                                                                                                                  | Why                                                                        | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| R1  | Live updates on Bridge, Inbox, and Agents over SSE, as Shuttlebay already does (FE-LIVE-4)                                            | The queue is the product, and a stale queue costs decisions                | P0       |
| R2  | E2E coverage for the Work list and detail actions, schedules, task detail, Inbox reply submission/dispatch, merge/rebase, and Unstick | Reply layout has partial coverage; these mutating journeys remain unproven | P0       |
| R3  | Paging and filters for `/work` and stopped work beyond 200 items, and a repo picker to replace the URL-only `?repo=`                  | The lists silently truncate                                                | P1       |
| R4  | One item view for GitHub-anchored and native tasks (FE-TK-2)                                                                          | One `Task` model, so one UI; removes duplicated surfaces                   | P1       |
| R5  | Non-admin operator sign-in limited to `/work*` (FE-AUTH-6)                                                                            | Grants already model this; sign-in blocks it                               | P1       |
| R6  | Render transcripts for OpenCode and CLI sessions (FE-SE-4)                                                                            | One pipeline and all interactive sessions cannot be audited in the UI      | P1       |
| R7  | Provider cooldowns and claim throughput on Shuttlebay (FE-SB-4)                                                                       | Makes "why isn't my run starting?" answerable                              | P2       |
| R8  | Schedule edit and delete, and a time-zone display                                                                                     | Schedules can currently only be toggled                                    | P2       |
| R9  | Server-side snooze to replace localStorage mute (FE-IN-7)                                                                             | Mute should follow the maintainer across devices                           | P2       |
| R10 | Cost breakdowns by pipeline and model, budget alerts, and cost per deliverable (FE-CO-2)                                              | Turns spend data into decisions                                            | P2       |
| R11 | Notifications: web push or digest for new `needs-human` items                                                                         | The phone-first maintainer should not have to poll                         | P3       |
| R12 | Re-point the fleet chip at the queue-executor and ARC lane documents, or remove it, and drop the legacy scale-set row from Shuttlebay | Both read status documents that are no longer published                    | P2       |

## 11. Success metrics

- **Time to decision:** the median time from an item entering the queue (such
  as a `needs-human` park) to the maintainer's action.
- **Queue health:** open decisions by reason, and the age of the oldest
  decision.
- **Trust:** the share of page loads that show a `DataWarnings` degradation,
  and incidents where the console showed a wrong state.
- **Reach:** the share of decisions taken on a phone-width viewport.
- **Traceability:** the share of finished runs whose session, transcript, and
  deliverable can all be reached from the UI.

## 12. Open questions

1. Should the Inbox include native-work parks alongside GitHub `needs-human`
   items, so there is one queue? Today native parks appear only on the Bridge
   "Stopped work" panel.
2. Will non-admin human operators ever exist, or is the Work grant model
   only for maintainers and machines?
3. Is a light theme a supported product mode, or a convenience? This decides
   whether visual baselines must hold in both schemes.
