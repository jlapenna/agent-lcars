# Native Work screenshot evidence production smoke runbook

This is a manual production smoke test for screenshot evidence attached through
the console's native **New work** flow. Run it only when a maintainer has
approved dispatching and later canceling a disposable Work item. The test
creates a real native Work item and a real evidence object.

The signed-in GitHub user must have a configured `work.operator` grant for the
selected pipeline. The repository must be in the watched-repository allowlist.
Do not use the E2E session header, a copied cookie, or a debug bypass.

## Safety rules

- Use a disposable description and select the pipeline deliberately: submission
  can dispatch a real worker immediately.
- Use a locally-created, non-sensitive PNG, JPEG, or WebP. The normalized image
  is stored outside GitHub access controls and its URL is a bearer capability.
- Keep the work ID, request ID, evidence ID, evidence URL, and downloaded bytes
  in a private temporary directory. Never publish them in issues, PRs, chat, or
  committed files.
- Stop on an unexpected authorization result, binding mismatch, storage error,
  or ambiguous submission result. Reconcile uncertain evidence before retrying.

## Contract under test

| Operation                                                   | Surface                                      | Authorization                                                                       | Expected result                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Create native Work with screenshot                          | Console **New work** modal                   | Signed-in principal with `work.operator`, selected pipeline, and watched repository | Work receipt links to `/work/<id>`; evidence is bound to the same request and referenced in the Work description |
| Create without a Work grant                                 | Console header and native create action      | Signed-in principal without `work.operator`                                         | Trigger withheld; direct action is rejected and creates no Work or evidence                                      |
| Retrieve existing evidence                                  | `GET /api/quick-task-evidence/v1/<uuid-v4>`  | Bearer URL; no session required                                                     | 200 normalized `image/webp`                                                                                      |
| Inspect existing evidence                                   | `HEAD /api/quick-task-evidence/v1/<uuid-v4>` | No session required                                                                 | 200 with the same headers and no body                                                                            |
| Retrieve malformed, absent, revoked, or unreadable evidence | GET or HEAD on the same route                | No session required                                                                 | Identical opaque 404                                                                                             |

The historical `/api/quick-task/v1` issue-creation endpoint is retired. Native
creation uses the Work server action and canonical Work router. The existing
evidence read URL remains stable so workers and historical tasks can retrieve
previously attached screenshots.

The server resolves the selected repository against the watched allowlist,
looks up its immutable GitHub repository ID and visibility, normalizes the
image to static lossless WebP, stores its immutable request binding, and then
creates the Work item. A definitive create rejection removes the newly written
generation. A live-run-cap response retains it for automatic retry with the
same Work, request, and evidence identifiers.

## 1. Prepare private test material

Create a private temporary directory and a plainly synthetic PNG, JPEG, or
WebP outside the checkout:

```
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT
BASE_URL='https://lcars.jlapenna.net'
BUCKET='agent-lcars-quick-task-evidence'
```

Open the console with an authorized session, choose **New work**, select a
watched repository and granted pipeline, enter a disposable description, add
the synthetic screenshot, and choose **Create work item** once.

Expect a success notification linking to `work:<id>`. Open that native Work
item and confirm its description contains the server-composed Screenshot link
and sanitized source context. Capture the Work ID and evidence ID privately.
The evidence object's request binding contains the request ID needed for the
revocation audit; obtain it through the approved private storage metadata
inspection in section 4. Record the selected repository owner and name as
well. Do not infer or invent any identifier.

## 2. Check submission authorization

Use a real signed-in test principal that intentionally lacks `work.operator`.
Confirm **New work** is absent. If testing the server action directly through a
local or staging harness, expect `UNAUTHORIZED` with `work.operator scope
required`, and confirm no Work item or evidence object was created. Do not
probe production by fabricating action payloads or session material.

## 3. Retrieve the evidence without a session

Use the evidence UUID already captured in the private shell from the
server-composed Work description. Do not paste the link or UUID into GitHub comments
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

- Cancel the disposable native Work item through the supported Work control. Do not publish the evidence URL, evidence ID, request ID, screenshot, token, or raw test output.
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

The smoke is green only when authorized native creation, the no-grant guard, unauthenticated bearer retrieval, the HEAD contract, the dry-run binding audit, and tombstone-plus-generation-matched revocation all pass.

## Source evidence

- `apps/console/src/app/quick-task-button.tsx` and
  `apps/console/src/app/work/actions.ts` define the single native creation flow,
  stable retry identifiers, and evidence lifecycle integration.
- `apps/console/src/lib/work-router.ts` enforces the `work.operator`, pipeline,
  and repository capabilities for canonical creation.
- `apps/console/src/app/api/quick-task-evidence/v1/[evidenceId]/route.ts` and its
  tests define stable public GET/HEAD behavior for current and historical
  evidence.
- `apps/console/src/lib/quick-task-evidence-contract.ts` defines evidence limits,
  object/tombstone prefixes, and response headers.
- `tools/quick-task-evidence-revoke.mjs` and its test define the binding audit,
  permanent tombstone, and generation-matched deletion order.
