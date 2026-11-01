# Inbox notifications

The R11 implementation supports explicit opt-in open-tab notifications and
background Web Push. Background production qualification remains pending. It reuses the existing durable Inbox decisions,
including native parks the current Work principal may answer. Web Push uses the existing authenticated schedule tick and browser push service;
it does not send Slack, email or SMS.

## Activate and unsubscribe

Open **Settings** from the console menu (⋮), or go to `/settings`, and under
**Inbox notifications** select **Enable notifications** (accessible name
"Enable Inbox notifications"), then grant the browser's permission prompt.
Delivery runs only while an Inbox tab is open; an opted-in Inbox shows the
live delivery state in its toolbar ("Inbox notification status"), and the
Settings page says delivery waits for an Inbox. No permission prompt
or worker registration runs merely by visiting a page. The choice belongs to that signed-in user in that browser.
All watched repositories participate regardless of the current Inbox filter.
The initial decision set is a quiet baseline, not a backlog notification.

Select **Disable notifications** on Settings to unsubscribe and close that user's
current notifications. Browser site settings separately control the browser's
permission; revoking it pauses delivery. Async activation and unsubscribe are
fenced by account and lifecycle, so an earlier account cannot complete opt-in
into a later account’s screen. Private storage, unavailable Web Locks,
unsupported notification APIs, and registration or authorization errors are
shown as unavailable. Disabling remains possible if Web Locks later disappear.
On phones, browser or installed-web-app notification restrictions may prevent
activation; permission alone is not proof of display.

## Delivery contract

An opted-in Inbox checks an authenticated, private no-store GET snapshot every
30 seconds independently of rendered Inbox props or a manual refresh. Disabled
notifications and revoked browser permission make no snapshot reads. Browser
fetch and server response waits have five-second deadlines;
optional polling does not enter the Server Action mutation queue used by Work
replies. Aborting or timing out cannot cancel an underlying read-store call,
which has no side effects. The
server rechecks admin identity and current Work grants and uses the same queue
classification as the rendered Inbox. Only explicit GitHub `needs-human`
handoffs and grant-eligible native parks notify. Metadata edits and failed
checks alone do not. An observed disappearance followed by reappearance is a
new decision; a new native parked run is a new generation. A disappearance that
was never observed cannot be reconstructed from a current snapshot.

Snapshots retain separate queue/activity fetch times and the native read start.
A snapshot cannot replace history if any source regresses, or if all source
watermarks are equal. The oldest source time bounds freshness; it is not a
combined revision. Current authorized id/generation eligibility independently
fences every pending display candidate. Partial,
future or 60-second-old evidence pauses notification accounting; uncertainty
never becomes an empty queue or a fabricated reopening. Existing short server
caches can delay observation. An interrupted session resumes with a quiet
baseline when its prior observation is stale; no closed-tab backlog is promised.

An exclusive browser lock and a per-user versioned storage ledger deduplicate
across Inbox tabs. At most one OS display request is issued per minute across
those tabs and across disable/re-enable. New decisions during that interval are
coalesced; decisions that resolve before the next request are removed. These
are browser-local limits, not a cross-device subscription or global rate limit.
Storage holds only identifiers, generations, preferences and timestamps.

The ledger consumes an attempt before calling `showNotification`. A timeout or
error cannot cause a duplicate automatic retry of that ambiguous request; it is
shown as unavailable. A successful call means **notification requested**, since
browser or OS settings may still suppress display. Initial and subsequent
snapshots are bounded at 1,000 decisions; exceeding that bound pauses delivery
instead of pretending to account for a truncated prefix.

Every OS preview is generic: no issue/work title, question, body, repository,
transcript, credential, or principal name. One decision links to its encoded
Inbox selection; a coalesced notice opens the Inbox. The worker restricts clicks
to the same-origin `/inbox`, strips unrelated query parameters, and relies on
the normal route's authentication and current permission checks. Its push handler rechecks authenticated subscription, current grants and snoozes
before requesting a preview. It caches no authenticated responses and receives
no issue content.

## Delivery and operational handoff

Normal Console delivery must publish `/inbox-notifications-sw.js` with the
reviewed app revision. On the target browser, verify explicit opt-in, current
identity/grants, new and reopened decisions, rate coalescing, generic previews,
click selection, unsubscribe, permission revocation and unavailable states.
The hermetic tests use fake notification delivery and do not establish physical
phone/OS delivery or production behavior.

## Background Web Push

On Settings, select **Enable background notifications** and grant browser
permission. This disables open-tab delivery in that browser to avoid duplicate
previews. The new subscription starts with a quiet baseline, lasts 30 days, and
can be disabled on Settings; re-enable after expiry to renew consent. A valid
signed-in admin cookie is still required when the worker wakes. Unsupported
browsers, denied permissions, stale/unavailable sources or expired sign-in stay
quiet; neither provider acceptance nor `showNotification` proves OS display.

The application stores at most five browser subscriptions per user in the
existing dispatch database (`console-inbox-push`), with provider endpoints,
public encryption keys, expiry and identifier-only delivery state. Endpoints
are delivery capabilities and never enter URLs or logs. Supported providers
are Chrome/FCM, Mozilla and Apple; arbitrary endpoints are rejected.

The existing authenticated schedule tick (currently every five minutes) re-resolves admin authority and Work
grants, reads the same Inbox classification and server snoozes, and coalesces
eligible new decisions. Native reports, resolved items and snoozed signatures
are excluded. Each browser has a one-minute limit. Firestore transactions
consume send attempts before calling the provider; ambiguous sends are not
retried. Provider 404/410 removes only the matching subscription revision.
Expired/revoked subscriptions are removed on a later tick. Delivery reads at
most 20 user records and stops starting further browser sends after 20 seconds;
each provider request has a five-second socket timeout. Source reads retain
their existing datastore deadlines. This is best-effort delivery, not an SLA.

Push has a 60-second TTL and carries only the user identifier and an attempt
timestamp. Candidate identifiers/generations stay in the bounded server ledger
until the authenticated receiver retrieves them. Before display, the worker POSTs to the same-origin,
private `/api/inbox-push` endpoint with its current browser endpoint. That route
rechecks cookie identity, current consent, grants, snoozes and fresh decisions;
a transaction consumes the receive attempt once, so duplicate provider delivery
cannot request another display. The route judges attempt and snapshot freshness
on the server clock; the worker never compares server timestamps with the
device clock, so ordinary clock skew cannot silently drop a push. Account
changes, expired messages and missing subscriptions suppress previews. Clicks retain the authenticated Inbox link.

### Rollout and qualification

Terraform owns the `AGENT_LCARS_PUSH_VAPID` secret container; its JSON value is
`{publicKey, privateKey, subject}` using standard `web-push` VAPID keys and an
operator contact URL. Provision the value through Secret Manager, never a
Terraform variable or source file. The reviewed Console deployment reads it;
only the public key is exposed to authenticated browser activation. Keep keys
stable: rotation requires browser unsubscribe/re-subscribe. No browser is
subscribed by deployment. The existing schedule tick is the sender; no new
cron or daemon is needed.

Verify on a real opted-in browser: close every Inbox tab, create a real eligible
human decision, observe a generic OS notice, and follow its selection link.
Also verify snooze, resolution-before-delivery, revoked consent/permission,
account change, expired sign-in, duplicate ticks and provider failure. Tests
use fake transports and do not establish physical OS delivery. Until this
qualification and key provisioning complete, R11 remains partial.

Browser API references: [service-worker display](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification),
[explicit permission](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API),
and [exclusive Web Locks](https://www.w3.org/TR/web-locks/).
