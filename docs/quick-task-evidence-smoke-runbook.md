# Quick Task screenshot evidence production smoke runbook

This is a manual, admin-only production smoke test for the Quick Task
screenshot-evidence path. Run it only when a maintainer has approved creating
and then closing a disposable Quick Task in a watched repository. The test
creates a real GitHub issue and a real evidence object; it is not a dry-run of
the submission route.

The production session must use one of the allowlisted GitHub logins
(`AGENT_LCARS_ADMIN_GITHUB_LOGINS`). Do not use the E2E session header, a test
fixture, a copied session cookie, or a deployment/debug bypass. E2E is
intentionally disabled for this validation.

## Safety rules

- Use a disposable description and a repository where closing the resulting
  issue is acceptable. Do not use a real customer task.
- A successful submission applies both the intake:quick-task label and the
  selected agent:* label. That can dispatch a real worker. Choose the pipeline
  deliberately and get maintainer approval for that possible dispatch before
  submitting.
- Use a locally-created, non-sensitive PNG, JPEG, or WebP. The file may be
  normalized and stored outside GitHub access controls, and the resulting
  Markdown link is a bearer capability.
- Keep the request ID, evidence ID, evidence URL, session cookie, response
  body, and downloaded bytes in a private temporary directory only. Never put
  them in an issue comment, PR, chat message, terminal transcript, or commit.
- Do not paste the screenshot into GitHub, and do not add a comment containing
  its URL. The Quick Task issue body is server-composed and will contain the
  evidence link when a file is submitted.
- Stop on any unexpected status, binding mismatch, storage error, or auth
  result. Do not retry with the same evidence ID after an ambiguous failure;
  reconcile it with the revocation tool first.

## Contract under test

| Operation                                                   | Route and method                           | Authorization                                          | Expected result                                             |
| ----------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| Submit with screenshot                                      | POST /api/quick-task/v1                    | Administrator session required                         | 201; JSON Quick Task receipt                                |
| Submit without an admin session                             | POST /api/quick-task/v1                    | No session or non-admin session                        | 401 {"error":"Unauthorized"}; no issue or object is created |
| Retrieve existing evidence                                  | GET /api/quick-task-evidence/v1/<uuid-v4>  | No session is required; the URL is a bearer capability | 200, normalized image/webp bytes                            |
| Inspect existing evidence                                   | HEAD /api/quick-task-evidence/v1/<uuid-v4> | No session is required                                 | 200, the same success headers, and no body                  |
| Retrieve malformed, absent, revoked, or unreadable evidence | GET or HEAD on the same route              | No session is required                                 | Identical opaque 404; no body or response headers           |

The submission body is multipart/form-data with exactly one intent field and,
only for the screenshot variant, one evidence file field. The JSON intent
contains requestId, optional evidenceId, repository (owner and name), pipeline,
description, and source (route, identities, and capturedAt, with optional
deployment). The browser must set the multipart boundary; do not hand-write a
Content-Type boundary.

The server resolves the repository against the watched-repository allowlist,
looks up its immutable numeric GitHub repository ID and visibility, normalizes
the image to static lossless WebP, and composes the issue body and evidence
URL. The client does not supply the Markdown URL. Supported input is PNG,
JPEG, or WebP, at most 10 MiB encoded; the image normalizer also enforces the
pixel, dimension, and normalized-output limits.

## 1. Prepare private test material

Use a temporary directory outside the checkout. For example, create one with
your normal local image tool, and put a plainly synthetic image there. Let the
Quick Task UI generate fresh UUIDs for each request. Do not put the values in
shell history if your workstation records it.

```
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT
BASE_URL='https://lcars.jlapenna.net'
BUCKET='agent-lcars-quick-task-evidence'
```

Use the console’s Quick Task dialog for the normal admin path. Select the
watched repository and pipeline, enter a disposable description such as
[smoke] Quick Task screenshot evidence — close after validation, select the
synthetic image in the optional Screenshot field, and submit once. The field
accepts PNG, JPEG, or WebP up to 10 MiB before submission.

In browser developer tools, confirm the request is the following before
continuing. Do not copy the request’s Cookie header or full response into a
ticket:

```
POST https://lcars.jlapenna.net/api/quick-task/v1
Content-Type: multipart/form-data; boundary=<browser-generated-boundary>

intent=<JSON object described above>
evidence=<the selected image file>
```

The response must be 201. Its private JSON receipt contains the request ID, the
created repository/issue number, and the GitHub issue URL. Capture the actual
requestId and repository owner/name from that private response (or capture the
request ID from the server marker if the browser does not expose the response).
These repository values must describe the task the server actually created;
do not rely on a remembered UI default or a hard-coded repository. The issue
body must contain a server-composed Screenshot Markdown link; source context
must be sanitized. It must not contain a browser-supplied origin or arbitrary
raw URL. Capture the evidenceId only from that server-composed URL into a local
variable. Keep the issue URL private until cleanup; never add a smoke-test
comment. Do not invent any identity.

Enter the actual values only into the private shell. The request ID and
repository come from the 201 receipt (the request ID may instead come from the
marker); the evidence ID comes from the server URL:

    read -r REQUEST_ID
    read -r EVIDENCE_ID
    read -r REPOSITORY_OWNER
    read -r REPOSITORY_NAME

## 2. Check submission authorization

From a private browser window with no LCARS session, or with a session that is
not the allowlisted administrator, send a harmless request to the submission
route:

```
curl -sS -D "$TMP_DIR/unauth-submit.headers" \
  -o "$TMP_DIR/unauth-submit.body" \
  -X POST "$BASE_URL/api/quick-task/v1"
```

Expect HTTP 401 and the JSON error {"error":"Unauthorized"}. The auth check
runs before form parsing, so this probe must not create an issue, claim,
evidence object, or GitHub write. Do not use a real request or evidence ID in
this probe.

## 3. Retrieve the evidence without a session

Use the evidence UUID already captured in the private shell from the
server-composed issue link. Do not paste the link or UUID into GitHub comments
or shared logs. Use the generation returned by the private storage metadata
check in the next section; do not guess it.

With the authenticated session removed, the valid bearer URL must still work:

```
curl -sS -D "$TMP_DIR/get.headers" -o "$TMP_DIR/evidence.webp" "$BASE_URL/api/quick-task-evidence/v1/$EVIDENCE_ID"
file "$TMP_DIR/evidence.webp"

```

Expect 200, Content-Type: image/webp,
Content-Disposition: inline; filename="screenshot.webp",
X-Content-Type-Options: nosniff, and Cache-Control: no-cache, max-age=0.
The normalized file should be identified as WebP. Do not open it in a shared
screen or upload it elsewhere.

Check HEAD separately; it must not download a body. Redirect the headers to the
private temporary directory; do not leave them in a shared terminal transcript:

```

curl -sS -I "$BASE_URL/api/quick-task-evidence/v1/$EVIDENCE_ID" > "$TMP_DIR/get-head.headers"

```

Expect 200 and the same success headers, with an empty response body. This
route is intentionally public-by-capability: lack of a login is not expected
to produce 401 for a valid evidence URL.

Also check the opaque failure behavior with a locally-generated unknown UUID
and a malformed value. For both GET and HEAD, expect 404, no body, and no
response headers. The same shape is required after revocation.

```

UNKNOWN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
curl -sS -D "$TMP_DIR/missing.headers" -o "$TMP_DIR/missing.body" "$BASE_URL/api/quick-task-evidence/v1/$UNKNOWN_ID"
curl -sS -D "$TMP_DIR/malformed.headers" -o "$TMP_DIR/malformed.body" "$BASE_URL/api/quick-task-evidence/v1/not-a-uuid"
curl -sS -I "$BASE_URL/api/quick-task-evidence/v1/$UNKNOWN_ID" > "$TMP_DIR/missing-head.headers"
curl -sS -I "$BASE_URL/api/quick-task-evidence/v1/not-a-uuid" > "$TMP_DIR/malformed-head.headers"

```

Do not interpret a valid URL working without auth as a defect. Treat the URL
as a secret bearer capability and revoke it whenever this smoke test ends.

## 4. Audit, then revoke the exact object

Revocation is an operator-only storage action; there is no public revocation
HTTP route. The checked-in tool is deliberately dry-run by default. It reads
the object metadata and refuses to proceed unless the schema version, evidence
ID, request ID, numeric repository ID, and object generation all match.

First obtain the repository ID and object generation privately:

```

REPOSITORY_ID="$(gh api "repos/$REPOSITORY_OWNER/$REPOSITORY_NAME" --jq .id)"
GENERATION="$(gcloud storage objects describe "gs://$BUCKET/objects/v1/$EVIDENCE_ID.webp" --format='value(generation)')"

```

Run the audit/dry-run from this checkout, omitting --apply:

```

node tools/quick-task-evidence-revoke.mjs --bucket "$BUCKET" --repository-id "$REPOSITORY_ID" --request-id "$REQUEST_ID" --evidence-id "$EVIDENCE_ID" --generation "$GENERATION" > "$TMP_DIR/revoke-dry-run.json" 2> "$TMP_DIR/revoke-dry-run.err"

```

Expect a dry-run result in the private output file. The result includes the
request ID, repository ID, generation, and action; only the evidence ID is
redacted. Keep both output and error files private in the temporary directory,
and run the command only from a private terminal. A binding or generation
mismatch is a hard stop; do not use --apply or manually delete an object.

After the dry-run passes and the maintainer has approved mutation, run the
same command once with --apply:

```

node tools/quick-task-evidence-revoke.mjs --bucket "$BUCKET" --repository-id "$REPOSITORY_ID" --request-id "$REQUEST_ID" --evidence-id "$EVIDENCE_ID" --generation "$GENERATION" --apply > "$TMP_DIR/revoke-apply.json" 2> "$TMP_DIR/revoke-apply.err"

```

The tool writes the permanent revocations/v1/<evidence-id> tombstone with a
create-only precondition before deleting only the observed
objects/v1/<evidence-id>.webp generation. It is safe against a repeated
tombstone write only when the existing tombstone has the exact binding. Do
not rerun the command after successful deletion; the object is intentionally
gone.

Immediately verify both unauthenticated routes again:

```

curl -sS -D "$TMP_DIR/revoked-get.headers" -o "$TMP_DIR/revoked-get.body" "$BASE_URL/api/quick-task-evidence/v1/$EVIDENCE_ID"
curl -sS -I "$BASE_URL/api/quick-task-evidence/v1/$EVIDENCE_ID" > "$TMP_DIR/revoked-head.headers"

```

Both must now be the same empty 404 response as malformed and missing IDs.
That read-after-revocation check confirms the public route checks the
tombstone before attempting the object read.

## 5. Clean up

- Close the disposable Quick Task issue in GitHub. Do not add a comment with
  the evidence URL, evidence ID, request ID, screenshot, token, or raw test
  output.
- Remove the local temporary directory and any browser downloads. The trap
  above removes the files when the shell exits; verify no evidence image or
  response file remains in the checkout.
- Clear local shell variables and close the authenticated/private browser
  windows. Do not retain the bearer URL in bookmarks or shared clipboard
  history.
- Record only a high-level result (for example, “smoke passed; evidence
  revoked”) in the maintainer’s private operational record. If reporting a
  failure, include statuses and the redacted tool result, never the bearer
  material.

The smoke is green only when the admin-only 201 submission, the
unauthenticated bearer retrieval, the HEAD contract, the 401 submission guard,
the dry-run binding audit, and the tombstone-plus-generation-matched
revocation all pass.

## Source evidence

The route and storage behavior documented here is covered by the current
implementation and tests:

- apps/console/src/app/api/quick-task/v1/route.ts and route.test.ts define
  administrator authorization, the exact multipart fields, 201 receipt, and
  401 behavior.
- apps/console/src/app/api/quick-task-evidence/v1/[evidenceId]/route.ts and
  route.test.ts define public GET/HEAD, fixed success headers, and the
  identical empty 404 response for malformed, absent, revoked, and
  unavailable IDs.
- apps/console/src/lib/quick-task-evidence-contract.ts defines the limits,
  object/tombstone prefixes, and response headers.
- tools/quick-task-evidence-revoke.mjs and its test define the read-only
  audit default, exact-binding checks, permanent tombstone, and
  generation-matched deletion order.
- docs/quick-task-evidence.md is the frozen contract for privacy, lifecycle,
  and deployment boundaries.
