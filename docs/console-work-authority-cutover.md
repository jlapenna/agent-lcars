# Console work-authority cutover

This is a two-phase, no-empty-console cutover. Phase 1 adds the control
plane's webhook-backed GitHub anchor projection while Bridge, Inbox, and
Agents continue using their existing queue source. Phase 2 switches those
surfaces to the fully populated projection together with Work, Task, and Run
records, then deletes the former aggregation. It does not add a fallback: the
old and new authorities are never selected dynamically at render time.

The canonical `/task/<owner>/<repo>/<issue>` route is intentionally separate:
it makes one bounded GitHub lookup for that exact, already-addressed anchor so
closed or merged history remains reachable. It is not queue discovery, is not
used by Bridge, Inbox, or Agents, and does not add an aggregate warning or
fallback path; Task and Run lifecycle on that detail page still comes from the
control plane.

Before the Phase 2 console switch, the operator must backfill every currently
open GitHub anchor through the supported, OIDC-protected control plane. This
is a one-time cutover prerequisite, not a console runtime path and not a
Firestore write.

Before deploying, verify the Agent LCARS GitHub App registration still has
`Checks: read`, then add subscriptions for `check_run` and
`pull_request_review` and `pull_request_review_thread` alongside its existing
issue/PR events. Run
`configure-github-app-webhook` from protected `main` to verify the exact
subscription before the backfill; it deliberately fails closed when an event
is absent. This is an operator-owned GitHub App settings change, not a
render-time compatibility path.

1. After the Phase 1 control-plane revision is deployed, manually dispatch
   `Console Anchor Projection Backfill` from the protected default branch.
   Its OIDC identity is pinned to that exact workflow and it calls
   `/api/control-plane/projections/reconcile`.
2. The endpoint uses the GitHub App to read up to 1,000 open anchors per
   configured control-plane repository, validates each current GitHub shape,
   and writes it through a generation-fenced exact refresh: it first claims
   `beginGithubAnchorProjectionRefresh`, reads the current GitHub anchor,
   then applies only the matching generation with
   `applyGithubAnchorProjectionRefresh`. A missing anchor is an explicit
   fenced tombstone, so an older in-flight read cannot restore it.
   It returns HTTP 409 rather than claiming success if any repository exceeds
   that bounded limit. This read is available only through the explicit
   cutover endpoint; queue rendering never imports it.
3. The endpoint reports `anchors` for every open anchor it ingested, which is
   intentionally larger than the actionable queue. Use its `comparison`
   result instead: `matches` must be true after it compares the current
   GitHub-derived queue keys and title/URL/author/assignee fields with the
   selected stored projections. A comparison warning or mismatch returns 409;
   fix the projection input and repeat the controlled job. If the endpoint
   returned 409 for the page bound, raise the reviewed bound and repeat; do
   not re-enable a GitHub-list compatibility path. Then verify `/`, `/inbox`,
   and `/agents` show the expected queue without an aggregate data-warning
   banner.
4. Open the Phase 2 protected PR only after that production result is
   recorded. It switches Bridge, Inbox, and Agents to the stored projection,
   deletes GitHub queue aggregation, and deletes the one-shot workflow,
   endpoint, and their temporary proxy allowlist. Normal webhook deliveries
   continue maintaining the projection.

Each invalidation increments a per-anchor refresh generation before its exact
GitHub read. Only the current generation may apply, so a late delivery or
older in-flight read cannot undo a newer label, assignee, title, or close
event.
