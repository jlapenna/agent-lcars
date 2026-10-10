# Inbox notifications

The selected R11 path is an opt-in browser notification while an authenticated
admin keeps an Inbox tab open. It reuses the existing durable Inbox decisions,
including native parks the current Work principal may answer. It does not
provision a delivery service or send Slack, email or SMS.

## Activate and unsubscribe

On an HTTPS Inbox, select **Enable Inbox notifications** and grant the browser's
permission prompt. No permission prompt or worker registration runs merely by
visiting the page. The choice belongs to that signed-in user in that browser.
All watched repositories participate regardless of the current Inbox filter.
The initial decision set is a quiet baseline, not a backlog notification.

Select **Disable Inbox notifications** to unsubscribe and close that user's
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
30 seconds. Browser fetch and server response waits have five-second deadlines;
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
the normal route's authentication and current permission checks. It has no
fetch/cache or push handler, receives no issue content, and performs no mutation.

## Delivery and operational handoff

Normal Console delivery must publish `/inbox-notifications-sw.js` with the
reviewed app revision. On the target browser, verify explicit opt-in, current
identity/grants, new and reopened decisions, rate coalescing, generic previews,
click selection, unsubscribe, permission revocation and unavailable states.
The hermetic tests use fake notification delivery and do not establish physical
phone/OS delivery or production behavior.

Closed-tab/background web push and server digests remain unavailable. Adding
one requires a separate concrete plan for per-user authenticated subscriptions,
endpoint/key lifecycle, deduplication, delivery retries, privacy, unsubscribe,
and the Homelab-owned delivery/configuration path. No subscription, push key,
infrastructure or unsolicited message is created by this implementation.

Browser API references: [service-worker display](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification),
[explicit permission](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API),
and [exclusive Web Locks](https://www.w3.org/TR/web-locks/).
