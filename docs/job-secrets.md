# LCARS runtime secrets and job credentials

Google Secret Manager is the approved storage backend for both LCARS service
credentials and job credentials. Access follows the consuming process and its
required permissions. Repository ownership and credential purpose do not require
separate stores or Google projects.

The current job-credential implementation uses a dedicated Google Secret Manager
project, independent of homegit and Homelab's secret stores. Broader service-secret
migration is planned; the administration and delivery procedures below describe
the implemented job path. Never import a host's credential environment or its
personal `gh` authentication into a job.

The application keeps secret metadata, immutable credential-set revisions,
per-job grants and access records in its existing dispatch Firestore database.
Secret values exist only in Secret Manager and the authorized runtime. Terraform
provisions projects, secret containers and IAM; it never handles secret values.

## Runtime secret storage and access decision

Shared storage does not imply shared access. Classify each credential by its
actual consumers and capabilities:

| Consumer           | Examples                                                        | Access boundary                                                                             |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| LCARS service      | GitHub App private key, webhook secret, service API credentials | Its service identity receives access to the individual secrets it needs.                    |
| Repository job     | Selected GitHub identity, Garage credential, task API key       | The job receives only its granted credential-set bindings and pinned versions.              |
| Deployment tooling | Credentials needed to deploy or start services                  | The deployment identity receives its required access; sharing storage adds no job bindings. |

An API credential can have several legitimate consumers. Grant each consumer
explicit access; where their issuer permissions or rotation requirements differ,
issue separate credentials. A repository name or a service label is descriptive
metadata, not an access grant. Repository GitHub App checkout and centrally
granted job credentials retain their existing authorization paths.

Services use their established Google authentication and startup paths. Jobs
continue to use LCARS's authorized delivery path and receive no Google Secret
Manager identity. Storing a service or deployment credential alongside job
credentials must not automatically register it in the job registry or expose it
through credential sets, job administration or runtime delivery. A job that
legitimately needs the same credential requires a separately reviewed explicit
binding, the existing container eligibility checks and an exact job grant.

Google project placement is a deployment choice for administration, billing and
lifecycle. It does not require one project per repository or credential category.
Keep the populated job-secret project and its selectors in place while planning
further migrations. The current implementation still requires
`AGENT_LCARS_JOB_SECRETS_PROJECT` to differ from `PROJECT_ID`; accepting another
layout requires an explicit implementation and deployment change.

Before migrating another runtime secret:

1. Inventory its current storage, consumers, issuer permissions, rotation and
   revocation requirements, and owning deployment path. Record references and
   metadata only.
2. Review its individual-secret IAM and consumer delivery configuration. Preserve
   startup authentication without depending on LCARS's job-secret API.
3. Transfer the value through a protected input path, deploy the owning consumer,
   and verify its intended operation and existing observability. A migration
   alone grants no job access to the value and authorizes no paid or
   outward-facing actions solely as health tests.
4. Retire the previous delivery path only after its consumers have moved and its
   owning workflow verifies the change. Do not bulk-import homegit or Homelab
   secrets, alter other owners' credentials, or remove shared values to resolve
   storage duplication.

## Administration

Open **Jobs → Credentials** (`/jobs/credentials`). Administration requires the
explicit `secrets.admin` Work scope, independently of `work.operator`, executor
authority and repository membership. Browser mutations retain the Work API's
same-origin check. Repository-bound GitHub Actions identities cannot administer
credentials even if a grant is misconfigured with this scope.

The page lists type, expected identity, promoted version, expiry and last access,
and shows credential-set consumers. It supports registration, protected version
uploads, validation/promotion, disabling delivery, immutable set publication and
grant/revocation. Secret values are not returned by metadata endpoints.

The CLI provides the same operations under `lcars work secrets`. Set
`LCARS_SERVICE_ACCOUNT` to the Terraform `job_secrets_operator` output for the
dedicated operator identity. This account has no Google resource roles; its
Google ID token authenticates to LCARS. The maintainer can impersonate it through
the reviewed IAM declaration. Ordinary `work-reader` credentials cannot manage
secrets.

```bash
lcars work secrets secrets
lcars work secrets sets
lcars work secrets grants
lcars work secrets register < secret-metadata.json
lcars work secrets publish < credential-set.json
lcars work secrets grant < job-grant.json
lcars work secrets promote github-jlapenna --version 1
lcars work secrets disable github-jlapenna
lcars work secrets enable github-jlapenna
```

The JSON input files above contain metadata and references only. Upload secret
values directly on protected stdin. For a value the operator holds, use
`secret-pass` with the CLI as its consumer, without writing into the age store:

```bash
secret-pass take lcars-github-jlapenna -- lcars work secrets upload github-jlapenna
# In the operator's terminal on the same host:
secret-pass give lcars-github-jlapenna
```

The upload command accepts no value argument, does not echo stdin, and prints
only the created version number. A GitHub value is a JSON record containing
`token` and its actual `expiresAt` ISO timestamp, or explicit `null` for an
issuer credential without expiry. The expected login is independent metadata.
Opaque secrets contain the actual UTF-8 value, preserving newlines. Values are
bounded to 16 KiB and cannot contain NUL.

## Provision and register

`infra/terraform/job_secrets.tf` declares the dedicated project, Data Access
auditing, operator and uploader identities, protected secret containers, and
individual-secret IAM. Add each new logical name to `job_secret_names` and
apply through the owning reviewed infrastructure workflow before registering it.
The default container is `github-jlapenna`; it contains no initial value.

The runtime reader has secret-level read/metadata access. The separate uploader
has `secretVersionAdder`, and the Console can impersonate it only for uploads.
Neither application identity can delete containers or destroy versions. Secret
containers have deletion protection and 30-day delayed version destruction.

Deployment configuration:

| Variable                          | Meaning                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `AGENT_LCARS_JOB_SECRETS_PROJECT` | Dedicated Secret Manager project, distinct from `PROJECT_ID` |
| `AGENT_LCARS_JOB_SECRETS_WRITER`  | Dedicated uploader service-account email                     |

Both variables must be present together. Omitting both disables the feature;
ordinary GitHub App jobs continue to work. No Secret Manager credential or
resource selector reaches a worker. The backend constructs every resource in
the configured project and accepts only concrete numeric versions. Registration
also checks the infrastructure-owned `application=lcars-job-secrets` label.

Example registration metadata:

```json
{ "name": "github-jlapenna", "kind": "github", "login": "jlapenna" }
```

Upload validates structure, expiry and GitHub identity before adding a version.
Promotion revalidates the selected version before changing the registry pointer.
Uploaded versions do not become available merely because they are newest.

## Credential sets and job grants

Publish a set revision through the UI or `work secrets publish`:

```json
{
  "name": "dev-maintenance",
  "revision": 1,
  "github": "github-jlapenna",
  "environment": {},
  "files": {}
}
```

Add a centrally managed execution profile to `AGENT_LCARS_JOB_PROFILES` using
the existing allocation, principal and exact-input authorization contract:

```yaml
name: dev-maintenance
repositories: [jlapenna/dev]
principals: [user:jlapenna]
credentialSet: { name: dev-maintenance, revision: 1 }
allocation: { cpu: 2, memory: 6Gi, storage: 24Gi }
inputSets: [{}] # Replace with the job's actual approved fixed inputs.
```

Publish the exact job grant through the UI or `work secrets grant`:

```json
{
  "repository": "jlapenna/dev",
  "job": "external-pr-sweep",
  "profile": "dev-maintenance",
  "credentialSet": { "name": "dev-maintenance", "revision": 1 },
  "principals": ["user:jlapenna"],
  "allowScheduled": true,
  "enabled": true
}
```

Finally select `execution.profile: dev-maintenance` in the repository's job
manifest. Scheduled executions inherit that profile and the durable grant; no
browser session is required. Manual invocation can select the profile through
Run now or `lcars work job invoke --profile dev-maintenance`, without changing
the manifest's schedule. All existing Work and profile checks still apply.

A set revision cannot be overwritten. Expanding membership requires publishing
a new revision and explicitly changing the profile and grant. Editing a manifest
or recipe alone cannot grant access. Granting access still trusts the job's
reviewed code and the repository that supplies it; credentials must not be
granted to untrusted PR revisions.

Use `environment` to map allowed environment names to opaque secret names, and
`files` to map simple logical filenames to opaque secret names. GitHub secrets
cannot be delivered as arbitrary environment or file values. Sets contain at
most 16 bindings. Runtime bootstrap, Git/GitHub, authentication, provider and
loader environment overrides are rejected. Credential sets cannot be combined
with `crossRepo`; sets without a GitHub binding retain repository App checkout.

## Delivery, rotation and revocation

Before minting Work, LCARS pins the promoted concrete versions in the occurrence.
Replays and retries retain that snapshot; later occurrences use subsequent
promotions. Snapshot persistence contains names and version numbers, not values.

Both checkout-token delivery and `GET /runs/{runId}/job-secrets` verify the live
run token, occurrence/repository binding, current profile, set revision, current
job grant and enabled secret records. Missing, revoked, expired or wrong-identity
credentials fail visibly. There is no personal-to-bot fallback. Git and `gh`
share the selected GitHub identity; `gitIdentity` independently controls commit
authorship.

The Goose runtime receives only its selected environment values and files.
Files are created under a private `/dev/shm` directory with directory mode 0700
and file mode 0600, removed on exit. `LCARS_JOB_SECRET_FILES_DIR` identifies that
directory to job tools. Secret bindings never enter job parameters, Git config,
artifacts or LCARS metadata responses. Authorized job code can still read and
emit its own credentials; redaction is not a security boundary.

Backend Data Access logs and LCARS access records identify reads. LCARS records
the principal, occurrence, logical secret and concrete version without payloads.
The resolver and administration routes sanitize authenticated errors.

For routine rotation: upload, validate/promote, allow existing occurrences to
finish, then retire the issuer's old credential. Static versions remain pinned
throughout an occurrence. GitHub delivery rechecks validity during the existing
five-minute refresh cadence, without extending the issuer's actual expiry.
OAuth issuer refresh-token exchange is not provided by the generic store; use
the existing renewable App-token path or explicitly rotate stored user tokens.

To revoke a job, submit the same grant with `enabled:false`. To block a secret
for all jobs, disable its registry record. Disabled secrets can still receive
admin uploads and promotions; enabling delivery validates the promoted version. These stop subsequent delivery; they
cannot erase a value already copied into a worker. Emergency containment also
requires cancelling affected Work and revoking/rotating the credential at its
issuer. Two sets referencing the same broad token have the same issuer-side
permissions.

## API

All administration paths below are under `/api/work/v1/credentials`, require
`secrets.admin`, and return metadata only. All Work responses use `no-store`.

| Method/path                        | Operation                                             |
| ---------------------------------- | ----------------------------------------------------- |
| `GET /secrets`, `/sets`, `/grants` | List bounded metadata                                 |
| `POST /secrets`                    | Register a provisioned container's name/type/login    |
| `POST /secrets/{name}/versions`    | Upload `{"value":"..."}` and return `{"version":"N"}` |
| `POST /secrets/{name}/promote`     | Validate/promote `{"version":"N"}`                    |
| `POST /secrets/{name}/disable`     | Stop further delivery; body `{}`                      |
| `POST /sets`                       | Create an immutable set revision                      |
| `POST /grants`                     | Create/update/revoke an exact job grant               |

The separate runtime delivery route uses the existing run-token contract,
documented in the generated Work OpenAPI. No runtime route lists the store.

## Legacy occurrence compatibility

Stored occurrences containing the former `profile.credentials.github` field
remain decodable for historical metadata and terminal Work reconciliation. New
profile configuration still rejects that field, and live recipe/credential
routes refuse legacy delivery, including fallback to App credentials. Historical
reads require the current repository's Goose operator grant rather than an
execution profile that may have been retired. No secret-store access is granted
by a historical read.

Interrupted legacy reservations with no Work are never minted again. They release
the active slot as unsuccessful after the existing worker retirement backstop,
with a visible legacy-admission failure. This preserves history without leaving
recurring jobs permanently occupied during migration.

## Observability

The existing five-minute control-plane maintenance tick produces an aggregate
credential observation. The queue executor caches this reply and exports
`lcars_job_credentials_*` through its existing metrics endpoint; scraping never
fetches a secret, invokes GitHub or runs inference. One rotating enabled secret
container gets a bounded metadata check per observation. This establishes only
that sampled container's metadata access, not every secret's value permission or
the continued validity of a GitHub token. Actual admission and delivery refusals
provide that operational evidence when a job uses its credential set.

Successful delivery materializations, their measured server duration and refused
operations use durable Firestore counters. Admission refusals are recorded before
an occurrence is reserved, so a denied scheduled job remains visible without a
Work record. The last refusal clock also detects an error that precedes the first
metrics sample. These are API operations, including retries, not successful jobs
or Git operations. Runtime job outcomes retain the normal Work lifecycle owner.
Aggregate and last-access clocks use Firestore commit time so concurrent writers
and instance clock skew cannot move them backwards. Private audit events retain
their original event clock and a server `recordedAt` clock for correlation with
alerts. Refusal events include repository, job, profile and trigger metadata so
operators can identify a denied job even before an occurrence exists; this
context never enters metric labels or aggregate observations.

The observation reports ready, disabled, unpromoted, expired and unknown metadata
separately; expiring is the ready subset whose GitHub expiry is within 24 hours.
Disabled and unpromoted records do not trigger expiry failures. An empty/disabled
registry is idle; it does not establish backend readiness. Missing or invalid
observations retain the previous sample's completion time and mark the read
unavailable. A job's old last-delivery time is never treated as a stalled worker.

Homelab's existing **Runner fleet (ARC)** dashboard owns the **LCARS job
credentials** row, its actual Prometheus queries and relevant queue-executor Loki
logs. Its existing scrape-loss and delivery alerts remain the infrastructure
owners; credential alerts cover lost observations, metadata/dependency failures,
expiry and refused operations. Dependent alerts require a fresh successful scrape.
No secret names, principal identities, job identifiers or values are metric labels.

Live acceptance requires a deployed producer revision, fresh observations, the
provisioned dashboard queries, Loki stream and loaded/evaluating alert rules.
Fixture and source checks do not establish live delivery. Value access and GitHub
identity are qualified by actual authorized job use, without a synthetic job or
health-only secret access.
