# Quick Task screenshot evidence contract

This document freezes the interface for the optional screenshot picker in
Quick Tasks. It is a contract-only change: it does not enable uploads, create
storage, or alter the existing issue marker and claim protocol.

## Submission and binding

The authenticated route will accept one `multipart/form-data` request with
exactly two fields: `intent` (JSON) and optional `evidence` (a file). The
intent contains the existing Quick Task request UUID, a separate evidence UUID
when a file is present, repository owner/name, pipeline, description, and
captured source context. Duplicate or unknown fields are rejected.

The server validates the selected watched repository, resolves its immutable
numeric GitHub repository ID and current visibility, and binds the normalized
object to that numeric ID, request UUID, evidence UUID, normalized SHA-256,
object generation, schema version, and upload-time visibility. Owner/name is
for routing and display only; a rename or transfer preserves the binding.
Reusing an ID with any mismatched binding fails closed with `409` without
disclosing the existing binding.

Input is static PNG, JPEG, or WebP only: at most 10 MiB encoded, 25 million
pixels, 10,000 pixels in either dimension, and 16 MiB normalized output. The
normalizer applies orientation, strips source metadata, and emits static
lossless WebP. SVG, GIF/animation, empty, corrupt, polyglot, and decoder-bomb
inputs are rejected before issue creation.

## URL and read behavior

The server alone creates this Markdown, using an HTTPS origin from trusted
deployment configuration rather than the request Host header:

```md
![Screenshot](https://lcars.example.net/api/quick-task-evidence/v1/<uuid-v4>)
```

The public `GET` and `HEAD` route accepts only the opaque UUID and reads only
`objects/v1/<uuid>.webp`; it never lists storage. Valid reads return fixed
`image/webp`, inline disposition, `nosniff`, and `no-cache, max-age=0`
headers. Malformed, missing, revoked, and unreadable IDs all receive the same
`404` response and no repository, visibility, request, hash, generation, or
storage metadata. `GET` and `HEAD` share this status/header contract; `HEAD`
returns no response body.

The URL is a bearer capability. The picker must display this warning for every
repository:

> This screenshot is stored outside GitHub repository access controls. Anyone
> who obtains the LCARS or GitHub-proxy image link can view and forward it,
> even after losing repository access. If this repository is or becomes public,
> the screenshot is public. GitHub and other readers may cache copies. Do not
> upload secrets or sensitive data.

## Lifecycle and operations

The evidence lifecycle hook runs only after the existing Quick Task claim wins
and immediately before `issues.create`. Existing-issue reconciliation and
claim-loss paths do not upload. A definitive GitHub create failure deletes only
the exact generation created by that attempt and releases the claim. Ambiguous
GitHub outcomes retain the evidence and claim for marker reconciliation.
Pre-create evidence failures reconcile storage as needed, then release the
claim because no issue can exist.

Revocation is terminal: write `revocations/v1/<uuid>` with a create-only
precondition before generation-matched byte deletion. Tombstones have no TTL;
the public read route checks them first so stale retries cannot restore access.
The audit tool is read-only and reports `unknown`, never deletion eligibility,
for partial, unreadable, removed, or unresolved repositories. It uses numeric
repository ID and the Quick Task marker, and it never prints full private
evidence URLs or IDs in ordinary output.

Public routes use opaque errors with only these statuses: `400`, `401`, `404`,
`409`, `413`, `415`, `422`, and `503`. Evidence IDs and URLs must not enter
application logs, traces, metric labels, analytics, user-facing errors, or
public verification notes.

## Deployment boundary

The bucket is private with uniform bucket-level access and public-access
prevention. Runtime access is bucket-scoped object create/get/delete only; no
listing, update, bucket administration, IAM mutation, signing, or public
principal is permitted. One deployment and bucket span all watched
repositories, so mutually distrustful tenants need separate deployment,
storage, and runtime-identity boundaries.

Infrastructure and runtime activation remain separately approved work. E2E is
currently deferred by maintainer direction; this contract is covered by pure
unit tests only.
