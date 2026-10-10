# Delivery transport recovery

Use this reference when Git publication or queue-only auto-merge fails.
[pr.md](pr.md) owns exact-head review/queueing and merge qualification;
[stacked-prs.md](stacked-prs.md) owns permitted unique-commit replay. Shared
delivery tools remain owned by `@jlapenna/repo-tools`; do not copy them here.

## Git: observe, then reconcile publication

1. Record the owned worktree/branch, reviewed local SHA, expected remote SHA,
   start time, live tool handle and eventual exit status. Confirm repository
   identity without printing a credential-bearing remote URL. For this
   repository's HTTPS origin:

   ```bash
   test "$(git remote get-url --push origin)" = \
     'https://github.com/jlapenna/agent-lcars.git'
   branch="$(git branch --show-current)"
   reviewed_head="$(git rev-parse HEAD)"
   gh api "repos/jlapenna/agent-lcars/git/ref/heads/$branch" --jq .object.sha
   ```

   A different remote or failed readback requires reconciliation. Record a
   missing branch only from authoritative not-found evidence, never a timeout.

2. After 30 seconds without progress, inspect the original handle and only
   its owned subprocesses. Record elapsed time and observed phase: connection
   setup, pre-push hooks, upload/response, or unknown. An owned transport's
   SYN-SENT socket supports connection-setup diagnosis; quiet output alone
   does not. Use process names rather than credential-bearing command lines.
   Keep hook failures separate and preserve their true status/diagnostics.

   One unauthenticated connectivity probe is bounded to 5 seconds for
   connection setup and 10 seconds overall:

   ```bash
   curl --silent --show-error --output /dev/null \
     --connect-timeout 5 --max-time 10 \
     --write-out 'status=%{http_code} connect=%{time_connect} total=%{time_total}\n' \
     https://github.com/
   ```

   Capture its exit status/timings separately. It probes a new connection;
   success neither proves recovery of the original connection nor identifies
   its network/backend cause. The bounds apply to this diagnostic, not to the
   push or legitimate hooks. Observe the original live handle in waits of at
   most 60 seconds. Do not restart on observation timeout, kill another process
   or enable credential/body tracing.

3. Once the original operation is authoritatively terminal, re-read local HEAD
   and the exact remote branch:

   | Remote state                 | Action                                                                                   |
   | ---------------------------- | ---------------------------------------------------------------------------------------- |
   | Reviewed local SHA           | Already published, possibly with a lost response. Inspect PR/checks; no new push.        |
   | Captured expected remote SHA | If local HEAD is unchanged and failure was transport-only, one normal retry is eligible. |
   | Different SHA                | Stop and reconcile concurrent ownership/source; no overwrite.                            |
   | Failed or ambiguous read     | Publication remains unknown; no retry or delivered claim.                                |

   A successful original exit also requires remote readback. Publishing an
   ancestor is not proof of the reviewed tip. A hook rejection requires its
   owning fix, not a transport retry. If the captured branch was absent,
   unchanged authoritative absence permits the original normal branch push.

4. Before an eligible retry, confirm exclusive worktree ownership and unchanged
   reviewed HEAD. Repeat the same normal push once with ordinary hooks. Do
   not introduce force pushing, bypass hooks or change global Git/network
   configuration. An already-authorized stacked replay retains its captured
   exact remote lease from [stacked-prs.md](stacked-prs.md); never replace it
   with a fresh lease that could overwrite another writer. Read back the
   branch/PR afterward. A second failure returns to recorded diagnosis, not
   a retry loop.

## API: classify the failure and read back queueing

Use the same identity as the failed request. Record stage (PR preflight or
mutation), UTC time, exit status, credential-free error category and GitHub
request identity when supplied. A failure before response headers has no
known request identity; do not substitute a later probe's identity. Do not
record tokens, authorization/cookie headers, debug traces or arbitrary bodies.

Before recovery, follow [pr.md](pr.md) to re-read the exact PR node, OPEN/ready
state, reviewed/pushed SHA, unresolved threads and current checks. A non-null
SQUASH request at that same head is already armed even if the prior response
was lost. A changed head, draft, closed PR, unaddressed finding or known failed
check needs its owning correction. Pending checks remain pending; arming
does not bypass them.

Query the same login's visible quota independently:

```bash
gh api graphql -f query='query {
  viewer { login }
  rateLimit { limit remaining used resetAt }
}'
```

Zero remaining supports visible quota exhaustion; wait for its reported reset
and re-read before retry. Nonzero quota does not exclude another backend or
secondary restriction. Keep attribution unknown when the error disagrees
with visible quota, as in #2329. Honor explicit Retry-After/reset guidance;
elapsed time alone does not establish recovery.

If state still proves an approved exact-head request is needed, allow at most
one queue-only recovery. Prepare the same mutation/variables from [pr.md](pr.md)
in a private JSON request file, including `expectedHeadOid`. This invocation
retains allowed metadata/categories without printing arbitrary response data:

```bash
queue_request="<PRIVATE_QUEUE_REQUEST_JSON>"
set -o pipefail
if env -u GH_DEBUG gh api graphql --include --input "$queue_request" |
  python3 -c '
import json, re, sys
text = sys.stdin.read().replace("\r\n", "\n")
headers, separator, body = text.partition("\n\n")
numeric = {"x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-used",
           "x-ratelimit-reset", "retry-after"}
metadata = {}
for line in headers.splitlines():
    if re.fullmatch(r"HTTP/[^ ]+ [0-9]{3}(?: .*)?", line):
        metadata["status"] = line.split(" ", 2)[:2]
    key, colon, value = line.partition(":")
    key, value = key.lower(), value.strip()
    if colon and key in numeric:
        metadata[key] = value if value.isascii() and value.isdigit() else "unparsed"
    if colon and key == "x-github-request-id":
        metadata[key] = value if re.fullmatch(r"[0-9A-Fa-f:]+", value) else "unparsed"
categories = []
try:
    response = json.loads(body) if separator else {}
    for error in response.get("errors", []):
        message = str(error.get("message", "")).lower()
        categories.append("rate-limit" if "rate limit" in message else
                          "head-mismatch" if "head" in message and
                          ("match" in message or "changed" in message) else "unknown")
except (ValueError, TypeError, AttributeError):
    categories.append("unparseable-response")
print(json.dumps({"metadata": metadata, "errorCategories": categories}))
'
then
  request_statuses=("${PIPESTATUS[@]}")
else
  request_statuses=("${PIPESTATUS[@]}")
fi
printf 'request_exit=%s filter_exit=%s\n' "${request_statuses[0]}" "${request_statuses[1]}"
```

Keep the bounded receipt outside Git with private permissions. An empty
receipt or failed filter is missing evidence, not success. `unparsed`
Retry-After is not permission to retry; obtain its actual guidance safely
before recovery. For an error supplied only on stderr, record its
credential-free category manually; do not redirect debug traces into evidence.

After success or failure, re-read the exact PR/head and auto-merge state.
Require the same ready head and non-null SQUASH request; otherwise retain the
blocker without blind retries. If it merged during recovery, audit the exact
merge/rules suite as [pr.md](pr.md) requires. Direct/admin merge, policy edits,
deployment and CI reruns are not fallbacks for transport errors.

## Qualify the procedure at its actual boundary

Record observed, inferred and unknown facts separately. #2339's SYN-SENT and
terminal connect error located the proximal blockage; a simultaneous fresh
successful probe did not establish its network cause. #2329's API error with
nonzero visible quota did not establish token exhaustion.

Exercise terminal transport failure/unchanged-head recovery, lost-response
already-published/armed state, changed heads, failed reads, hook rejection and
response-header filtering. Use owned local Git repositories and sanitized
response fixtures; do not manufacture production dispatches, disable controls
or change host policy. A fresh independent operator trajectory can demonstrate
usability; fixtures do not prove a GitHub backend cause or deployed product.

Command references: [GitHub CLI API](https://cli.github.com/manual/gh_api) and
[curl time limits](https://curl.se/docs/manpage.html).
