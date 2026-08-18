# The IAM contract: one executable check

`docs/fleet-credentials.md` describes the fleet's identity model in prose.
Nothing verified it, and that cost real time: the App-location table sent the
maintainer to two empty settings pages, the private-key lineage was documented
two contradictory ways, and the #1368 outage was spent testing IAM hypotheses
one CI run at a time.

This is the executable half (#1376).

- **`tools/iam-contract/model.json`** — the expected state, machine-readable:
  fleet repositories, the two GitHub Apps and their installations, every WIF
  pool/provider and the exact condition string it carries, the user-managed-key
  allowlist per project, and `CLAUDE_CODE_OAUTH_TOKEN`'s binding set.
- **`tools/iam-contract/check.mjs`** — reads **live** state (`gh`-equivalent
  REST calls for GitHub, `gcloud` for GCP), diffs it against the model, and
  exits non-zero with a message naming the resource and expected-vs-actual.
- **`.github/workflows/iam-contract-audit.yml`** — runs it daily, and on any
  pull request that touches the model or the checker.
- **`tools/contract-tests/iam-contract-model.test.ts`** — the credential-free
  half, in `pnpm check:contracts`: the model must agree with Terraform's
  `local.github_repositories`, every exemption must carry a reason, and every
  section the checker implements must be invoked by the workflow (a section
  wired into no job would look like coverage while asserting nothing).

## Running it

```bash
# Everything (needs gcloud credentials for both projects and the App key).
gcloud secrets versions access latest --secret=AGENT_LCARS_APP_PRIVATE_KEY \
  --project=agent-lcars --out-file=/tmp/app.pem     # umask 077 first
AGENT_LCARS_CLIENT_ID=Iv23liO6X8pLJLcTFzyv \
  node tools/iam-contract/check.mjs --app-private-key-file /tmp/app.pem

# Just the GCP surface, no App key needed.
node tools/iam-contract/check.mjs --sections wif,keys,secrets

# Print live state instead of asserting - how the model is refreshed.
node tools/iam-contract/check.mjs --dump --sections wif,keys
```

Sections: `apps`, `workflow-refs`, `wif`, `keys`, `secrets`.

## What each section asserts

| Section         | Assertion                                                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps`          | App slug, client id, owner login **and type**, the exact set of installation ids, each installation's account and `repository_selection`, and the exact repository list it covers. Then: every fleet repository is covered by some installation, unless `fleetCoverageExceptions` names it with a reason. |
| `workflow-refs` | Every `owner/repo/.github/workflows/x.yml` appearing in a modelled provider condition still exists on that repository. A dead `deploy.yml` clause survived exactly this way.                                                                                                                              |
| `wif`           | The exact set of pools per project, each pool's state, the exact set of providers, and per provider its state, issuer URI, attribute mapping and **byte-exact** attribute condition.                                                                                                                      |
| `keys`          | No service account in either project holds a user-managed key, except the allowlisted ones. The allowlist is a ratchet: an allowlisted account that no longer holds a key is **also** a failure, so a retired exemption cannot be inherited by the next key.                                              |
| `secrets`       | `CLAUDE_CODE_OAUTH_TOKEN` carries exactly one binding — `secretAccessor` for `claude-token-reader`. Two speculative grants were added while chasing #1368 and pruned the same night; nothing else stops the next ones from persisting.                                                                    |

When it fails, the fix is one of two things, and the message says so: either the
world drifted (fix the world) or the model is out of date (fix `model.json` and
`docs/fleet-credentials.md` together).

## Known gaps

Both are printed by the check itself as `[known gap]` lines, so they cannot be
forgotten by being silent.

1. **The autoscaler App is not asserted.** `GET /app` and
   `GET /app/installations` only accept a JWT signed by that App's own private
   key, and `agent-lcars-autoscaler`'s key lives in the homelab vault
   (`github_autoscaler_lcars_app_private_key`), never in this repo. Its
   documented installations (`154210710` jlapenna, `154210731`
   supersprinklesracing) are recorded in the model but taken on faith.
   Asserting them means running this same checker from homelab — jlapenna/homelab#763.
2. **`supersprinklesracing/www` is not covered by the fleet App installation.**
   Found by this check on its first live run. The shared `github` WIF pool
   trusts www and Terraform provisions its codex lineage (#1354), but adding a
   repository to an installation needs a GitHub-App _user_ token, so it is a
   maintainer UI action rather than something `gh` can do.

## Enabling the GCP half in CI

The `github-surface` job runs today with credentials this repo already holds.
The `gcp-surface` job needs a read-only auditor identity that does not exist
yet, and says exactly what it did not assert when it is unconfigured rather
than passing silently.

No identity reachable from this repo is usable for it: the shared `github` pool
admits only `claude-token-reader`, `codex-agent` and `telemetry-writer` — none
of which hold an IAM or WIF read role — and `github-deployer` sits behind a pool
whose condition admits `deploy-console.yml@refs/heads/main` alone.

Enabling it is one Terraform change (maintainer approval required, per
`AGENTS.md`) plus two repository variables:

- a service account, e.g. `iam-auditor@agent-lcars.iam.gserviceaccount.com`,
  impersonable from the shared `github` pool for `jlapenna/agent-lcars` only;
- on project `agent-lcars`: `roles/iam.workloadIdentityPoolViewer`,
  `roles/iam.serviceAccountViewer` (plus `iam.serviceAccountKeys.list`, in
  `roles/iam.serviceAccountKeyAdmin` or a custom role) and
  `roles/secretmanager.viewer` — read-only throughout, never
  `secretAccessor`: the check reads the secret's **policy**, never its value;
- the same read-only set on project `supersprinklesracing` (that project's WIF
  is Terraform-managed by jlapenna/homelab, homelab#750, so the grant belongs
  there);
- repo variables `GCP_IAM_AUDIT_WIF_PROVIDER` and `GCP_IAM_AUDIT_SA`.

Until then, run `--sections wif,keys,secrets` from a workstation with owner
credentials; it is the same code path CI will run.

## Proving it is not vacuous

A green check is worth nothing until you have watched it go red. Both of these
were run against production and reverted (#1376):

```bash
# Drift: an extra accessor grant on the token secret.
gcloud secrets add-iam-policy-binding CLAUDE_CODE_OAUTH_TOKEN --project=agent-lcars \
  --member=serviceAccount:codex-agent@agent-lcars.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
node tools/iam-contract/check.mjs --sections secrets   # exits 1, names codex-agent
gcloud secrets remove-iam-policy-binding CLAUDE_CODE_OAUTH_TOKEN --project=agent-lcars \
  --member=serviceAccount:codex-agent@agent-lcars.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

# Drift: a user-managed key on a WIF-only identity.
gcloud iam service-accounts keys create "$KEYFILE" \
  --iam-account=codex-agent@agent-lcars.iam.gserviceaccount.com --project=agent-lcars
node tools/iam-contract/check.mjs --sections keys      # exits 1, names the key id
gcloud iam service-accounts keys delete <key-id> \
  --iam-account=codex-agent@agent-lcars.iam.gserviceaccount.com --project=agent-lcars
```

Both key and IAM reads are **eventually consistent**: a check run within a few
seconds of the mutation can still see the old state. Give it ~15s before
concluding the check missed something.
