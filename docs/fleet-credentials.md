# Fleet credentials: what each token is and how to mint it

Every credential the agent fleet consumes, who is able to mint it, where the
canonical copy lives, and the exact commands. Written to be executable by an
agent session driving the maintainer's workstation: every step is a concrete
command, and the two OAuth mints are doable by an agent with browser tooling
against the maintainer's already-signed-in browser (they only _require_ a
human when no browser automation is available).

**Preconditions** (verify before starting, don't assume): `gh auth status`
shows the maintainer's login; `gcloud auth list` shows an account with
Secret Manager access to the named projects; `ssh homelab@homelab true`
succeeds. Never echo a secret value into terminal output, chat, or shell
history — move values with pipes, `read -rs`, or files created under
`umask 077`, and delete temporaries when done.

| Credential                | Consumed by                              | Canonical home                                                                      | Mintable by                        |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | claude lane (`agent-lane.yml`, run time) | Secret Manager `CLAUDE_CODE_OAUTH_TOKEN` (project `agent-lcars`)                    | maintainer only (browser OAuth)    |
| Codex `auth.json` lineage | codex lane (`agent-lane.yml`, run time)  | GCS `gs://agent-lcars-codex-auth/<owner>/<repo>/auth.json`, one object **per repo** | maintainer only (`codex login`)    |
| `OPENCODE_LLM_API_KEY`    | opencode lane (`agent-lane.yml`)         | age store + repo Actions secret                                                     | anyone with the LiteLLM master key |
| `AGENT_LCARS_PRIVATE_KEY` | every pipeline's token mint; console     | Secret Manager `AGENT_LCARS_APP_PRIVATE_KEY` (project `agent-lcars`)                | maintainer (App settings UI)       |
| Autoscaler App key        | runner registration (homelab autoscaler) | homelab vault `github_autoscaler_lcars_app_private_key`                             | maintainer (App settings UI)       |

Two GitHub Apps exist and are easy to confuse:

- **Fleet App** (`agent-lcars`, client `Iv23liO6X8pLJLcTFzyv`): what the
  lanes and console authenticate as — claims, PRs, comments as
  `agent-lcars[bot]`. Installations:
  [jlapenna 150568943](https://github.com/settings/installations/150568943),
  [supersprinklesracing 150568991](https://github.com/organizations/supersprinklesracing/settings/installations/150568991).
- **Autoscaler App** (`agent-lcars-autoscaler`, client `Iv23lir3t9e2k4RAkWxw`):
  what runner scale-set listeners register with (Administration R/W). Its
  scope is **asymmetric and measured, not assumed**: the jlapenna installation
  is "Only select repositories" (5), the supersprinklesracing one is still
  "All repositories" (6, three of them non-fleet). Narrowing the second is
  proposed in #1381.
  Installations `154210710` (jlapenna) / `154210731` (supersprinklesracing).

The fleet App's two fleet installations use "Only select repositories" — a new
repo must be added to the right installation(s) in the GitHub UI (the REST
endpoint for this only accepts a GitHub-App _user_ token, so `gh` cannot do
it). It has a third, non-fleet installation on the `jlaorg` org, and that one
is "All repositories".

> Everything above is prose, and prose rots — this file documented the
> private-key lineage two contradictory ways until a live JWT mint settled it.
> The machine-checkable half now lives in `tools/iam-contract/model.json`, and
> homelab's observability layer diffs it against live GitHub and GCP state on a
> schedule: see [docs/iam-contract.md](iam-contract.md) (#1376). Change the two
> together.
> It already earned that: on its first live run it found the fleet App was not
> installed on `supersprinklesracing/www` (#1380, since fixed — and the check
> then reported the now-stale exception, so the model could not be left
> behind), and it measured the autoscaler App's installation scope, which this
> file had described as select-repositories when one installation was not
> (#1381).

## `CLAUDE_CODE_OAUTH_TOKEN` (claude lane)

A long-lived OAuth token for the maintainer's Claude subscription. It does
**not** rotate — `claude setup-token` mints it once and nothing writes it
back — so unlike the Codex lineage below one value is safely shared across
every repo, and it lives in exactly one place (#1350).

No repo carries a copy. `agent-lane.yml` reads it from Secret Manager per
run over WIF, so onboarding a new repo to the claude lane needs no
credential work at all, and an expiry is one command rather than an N-repo
fan-out. Admission is the shared `github` pool in project `agent-lcars`,
conditioned on `assertion.repository` alone
(`infra/terraform/main.tf`), so a new repo joins by being added to
`local.github_repositories` — it needs no pool of its own. The reader
identity is `claude-token-reader@agent-lcars.iam.gserviceaccount.com`: it
holds `secretAccessor` on this one secret and nothing else, and is never
exported as ambient ADC into the agent's shell.

The read itself is a direct Secret Manager REST call authorized by the
`access_token` the auth step returns (`google-github-actions/auth` with
`token_format: access_token`), **not** `get-secretmanager-secrets` or any
client library that rediscovers credentials through ADC. That rediscovery
is what broke every consumer lane after #1351 — auth succeeded, a
credential file existed, and the read still reported "the caller does not
have permission" against demonstrably correct IAM (#1368). #1370 replaced
it; if you are changing this step, keep the explicit access token.

1. Run `claude setup-token`. It prints an authorization URL and waits.
   Open that URL in the maintainer's signed-in browser (an agent with
   browser tooling can do this — navigate, click **Authorize**, and copy
   the resulting code back into the waiting prompt if one is shown). The
   command then prints the long-lived token exactly once.
2. Publish it as a new version of the one canonical secret, without it
   touching shell history or chat. `printf %s`, not `echo`: a trailing
   newline corrupts the credential.

   ```bash
   read -rs TOKEN   # paste the token, press Enter (nothing echoes)
   printf %s "$TOKEN" | gcloud secrets versions add CLAUDE_CODE_OAUTH_TOKEN \
     --project=agent-lcars --data-file=-
   unset TOKEN
   ```

3. Verify, then label an issue `agent:claude`. The lane's "Read the Claude
   subscription token" step is the first consumer and names the secret on
   failure; "Run Claude Code" is the second.

   ```bash
   gcloud secrets versions access latest --secret=CLAUDE_CODE_OAUTH_TOKEN \
     --project=agent-lcars | sha256sum
   ```

## Codex `auth.json` lineage (codex lane)

The codex lane restores `~/.codex/auth.json` from its repository-scoped GCS
object. Codex can refresh the credential during a run; the lane persists a
changed file only with that exact restored object's generation as its
precondition. That makes each repository's object a _lineage_, not a value:

> **Never copy the blob from another repo's object.** Two repos sharing one
> lineage invalidate each other on every run (the lane's own comment block
> documents this). Mint an independent login per repo — same ChatGPT
> subscription, separate rotating token.

Per new repo. **Steps 1-2 are the whole job for a repo Terraform already
covers** — the four 2026-08 additions (`www`, `girosf`, `nx-cache-server`,
`sync-padd`) have their service accounts and prefix-restricted object grants
provisioned (#1354), so only the mint is left.

1. Mint into an **isolated `CODEX_HOME`**, not your real one. `codex login`
   writes `$CODEX_HOME/auth.json`, and `CODEX_HOME` defaults to `~/.codex`
   — so an unisolated mint silently replaces your own live session, once
   per repo. Point it at a temp dir instead and nothing of yours is
   touched:

   ```bash
   export CODEX_HOME=$(mktemp -d) && chmod 700 "$CODEX_HOME"
   codex login          # authorization URL; complete it in a signed-in browser
   codex login status   # prove it authenticates BEFORE it becomes the lineage
   ```

   This is why the old "run it on a workstation with no live Codex session
   you care about" advice is obsolete: run it on your normal machine.

2. Publish it to that repo's own GCS object, then shred the isolated home so
   no competing lineage is left on disk:

   ```bash
   gcloud storage cp "$CODEX_HOME/auth.json" \
     gs://agent-lcars-codex-auth/jlapenna/sync-padd/auth.json \
     --if-generation-match=0
   rm -rf "$CODEX_HOME"; unset CODEX_HOME
   ```

   For the four 2026-08 repos there is a script that does all of this with
   preflight, per-repo isolation, shredding on every exit path (Ctrl-C
   included), and a hash check that the stored bytes match what was
   minted: `~/p/mint-fleet-codex-lineages.sh`, discussed in
   jlapenna/homelab#758 (kept out of this public repo deliberately).

   The object layout is `gs://agent-lcars-codex-auth/<owner>/<repo>/auth.json`.
   **Project `agent-lcars` for every repo**, settled in #1354 including the
   two `supersprinklesracing` ones: the shared `github` pool that admits them
   lives there, and the bucket IAM condition confines each identity to its own
   prefix. The lane reads one exact generation and persists only with that
   generation as `--if-generation-match`; a conflict is terminal and must not
   be retried.

3. Infrastructure, for a repo Terraform does **not** yet cover: add its
   existing runtime service account to `local.codex_auth_runtime_identities`
   in `infra/terraform/main.tf`, then apply. That one map entry yields a
   conditional `storage.objects.get/create/delete` grant restricted to the
   repository's own object prefix; it grants neither object listing nor
   access to another repository's credential.

   Per-repo identities are not ceremony: the codex lane exports ambient ADC
   for its GCS calls, so agent-authored code in that job can reach whatever
   the identity can reach. A shared service account would let one repo's
   agent read and rotate another repo's credential. Versioning keeps a
   seven-day noncurrent recovery window; CAS prevents a stale run from
   overwriting the current object (#1192).

   `sprinkles` is the exception again: it authenticates against pool
   `claude-agent-pool` / provider `claude-agent-github` in project
   `supersprinklesracing`. The provider maps `job_workflow_ref` to a
   `workflow_class` (`ci`, `deploy`, or `agent`) and must name each admitted
   workflow with its immutable `@` ref suffix:

   ```text
   assertion.repository=='<owner>/<repo>' &&
     (assertion.job_workflow_ref.startsWith('<owner>/<repo>/.github/workflows/ci.yml@')
      || assertion.job_workflow_ref.startsWith('<owner>/<repo>/.github/workflows/e2e.yml@')
      || assertion.job_workflow_ref.startsWith('<owner>/<repo>/.github/workflows/deploy.yml@')
      || assertion.job_workflow_ref.startsWith('jlapenna/agent-lcars/.github/workflows/agent-lane-codex.yml@')
      || assertion.job_workflow_ref.startsWith('jlapenna/agent-lcars/.github/workflows/agent-lane.yml@'))
   ```

   That pool and provider are no longer hand-managed: `jlapenna/homelab`'s
   root Terraform adopted them in homelab#750
   (`terraform/gcp_sprinkles_wif.tf`), so extend the condition **there**
   and apply, rather than with `gcloud ... update-oidc`, whose
   `--attribute-condition` **replaces** rather than appends and whose
   result that root's scheduled drift check would report. The shared
   `github` pool needs none of this: it matches on
   `assertion.repository` alone.

4. Set the repo side: callers need only `gcp-project-id` plus their existing
   WIF provider and service-account values. The object path derives from
   `github.repository`; there is no per-repository secret-name input.
5. Verify: `codex login status` inside the lane's restore step log.

## `OPENCODE_LLM_API_KEY` (opencode lane)

A **LiteLLM virtual key** (`sk-…`) for the homelab LiteLLM proxy
(`llm.jlapenna.net`) that `opencode.json` points every repo at. Mint a
scoped key rather than reusing the master key:

```bash
# The master key lives only on the homelab host; read it without echoing:
LITELLM_MASTER_KEY=$(ssh homelab@homelab \
  "grep '^LITELLM_MASTER_KEY=' /home/homelab/p/homelab/litellm/.env" | cut -d= -f2-)
curl -sS https://llm.jlapenna.net/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"key_alias": "opencode-fleet-2026-08", "duration": null}'
unset LITELLM_MASTER_KEY
```

Copy the **`key` field** (`sk-…`) of the response — _not_ `token`, which is
the sha256 hash LiteLLM stores; shipping the hash is the exact mistake
behind the 2026-08 Prometheus-scrape incident (homelab
`docs/incidents.md`). Store it in the age store
(`secrets-add "OPENCODE_LLM_API_KEY=sk-…"`) and per repo with
`gh secret set OPENCODE_LLM_API_KEY -R <repo>`.

## `AGENT_LCARS_PRIVATE_KEY` (fleet App key)

The fleet App's RSA private key. Canonical copy: Secret Manager secret
`AGENT_LCARS_APP_PRIVATE_KEY` in project `agent-lcars` (the console reads
it there directly; repos carry fan-out copies as Actions secrets).

**One App, one lineage** (#1340 D3, settling a contradiction two documents
carried): the Secret Manager secret and the seven `AGENT_LCARS_PRIVATE_KEY`
repo Actions secrets are the same credential of the same App — verified by
minting an App JWT from the Secret Manager value and calling `GET /app`,
which returns `agent-lcars` (App id `4457090`, client
`Iv23liO6X8pLJLcTFzyv`), the same client id every repo's
`AGENT_LCARS_CLIENT_ID` var and the console's `AGENT_LCARS_APP_CLIENT_ID`
name. `infra/terraform/main.tf`'s #1204 comment used to describe the two as
deliberately separate lineages; that was the pre-population intent, not what
shipped, and the comment has been corrected. Treat Secret Manager as the
only place a new key is ever written first, and always run the fan-out below
afterwards: a repo left on a previous version keeps working only for as long
as the older key stays registered on the App, which is exactly the kind of
silent expiry this doc exists to prevent.

Rotation / (re)provisioning:

1. GitHub → Settings → Developer settings → GitHub Apps → _agent-lcars_ →
   "Generate a private key" (downloads a `.pem`).
2. Canonical copy first, then fan out:

   ```bash
   gcloud secrets versions add AGENT_LCARS_APP_PRIVATE_KEY \
     --project=agent-lcars --data-file=key.pem
   for r in jlapenna/agent-lcars jlapenna/homelab \
            supersprinklesracing/sprinkles supersprinklesracing/www \
            supersprinklesracing/girosf jlapenna/nx-cache-server \
            jlapenna/sync-padd; do
     gcloud secrets versions access latest \
       --secret=AGENT_LCARS_APP_PRIVATE_KEY --project=agent-lcars |
       gh secret set AGENT_LCARS_PRIVATE_KEY -R "$r"
   done
   rm key.pem
   ```

3. Verify: any lane run's `mint-agent-token` step; the console's
   `/api/health` covers the App-auth path in production.

## Autoscaler App key (runner registration)

The autoscaler App's private key backs every scale-set listener. It is
vaulted in homelab as `github_autoscaler_lcars_app_private_key` and
deployed to the controller as `/secrets/lcars-app-private-key.pem` by
`deploy_secrets.yml`. Rotate by generating a new key in that App's
settings, updating the vault value, and redeploying — see homelab's
`github-runner-autoscaler/README.md` ("GitHub App setup") for the
provisioning walkthrough and installation IDs.

## Repo vars that ride along

Every fleet repo also carries non-secret vars the lanes read:
`AGENT_LCARS_CLIENT_ID` (fleet App client id), `AGENT_FLEET_LOGIN`
(`agent-lcars-bot`), `AGENT_BOT_LOGINS`, `MAINTAINER_LOGIN`, and
`AGENT_RUNNER_LABEL` (`<repo>-default` per the homelab scale-set naming).
These are plain `gh variable set` calls and safe to provision from any
session — the 2026-08 onboarding left all four new repos at 5/5 vars and
2/2 automatable secrets, with only the maintainer-mintable tokens above
outstanding.
