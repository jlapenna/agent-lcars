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

| Credential                | Consumed by                               | Canonical home                                                       | Mintable by                        |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | claude lane (`agent-lane-claude.yml`)     | repo Actions secret, per repo                                        | maintainer only (browser OAuth)    |
| Codex `auth.json` lineage | codex lane (`agent-lane-codex.yml`)       | GCP Secret Manager, one secret **per repo**                          | maintainer only (`codex login`)    |
| `OPENCODE_LLM_API_KEY`    | opencode lane (`agent-lane-opencode.yml`) | age store + repo Actions secret                                      | anyone with the LiteLLM master key |
| `AGENT_LCARS_PRIVATE_KEY` | all three lanes' token mint; console      | Secret Manager `AGENT_LCARS_APP_PRIVATE_KEY` (project `agent-lcars`) | maintainer (App settings UI)       |
| Autoscaler App key        | runner registration (homelab autoscaler)  | homelab vault `github_autoscaler_lcars_app_private_key`              | maintainer (App settings UI)       |

Two GitHub Apps exist and are easy to confuse:

- **Fleet App** (`agent-lcars`, client `Iv23liO6X8pLJLcTFzyv`): what the
  lanes and console authenticate as — claims, PRs, comments as
  `agent-lcars[bot]`. Installations:
  [jlapenna 150568943](https://github.com/settings/installations/150568943),
  [supersprinklesracing 150568991](https://github.com/organizations/supersprinklesracing/settings/installations/150568991).
- **Autoscaler App** (`agent-lcars-autoscaler`, client `Iv23lir3t9e2k4RAkWxw`):
  what runner scale-set listeners register with (Administration R/W).
  Installations `154210710` (jlapenna) / `154210731` (supersprinklesracing).

Both use "Only select repositories" — a new repo must be added to the right
installation(s) in the GitHub UI (the REST endpoint for this only accepts a
GitHub-App _user_ token, so `gh` cannot do it).

## `CLAUDE_CODE_OAUTH_TOKEN` (claude lane)

A long-lived OAuth token for the maintainer's Claude subscription. Not
self-rotating: unlike the Codex lineage below, **one token may be shared
across repos** safely.

1. Run `claude setup-token`. It prints an authorization URL and waits.
   Open that URL in the maintainer's signed-in browser (an agent with
   browser tooling can do this — navigate, click **Authorize**, and copy
   the resulting code back into the waiting prompt if one is shown). The
   command then prints the long-lived token exactly once.
2. Store it on each repo without it ever touching a shell history or chat:

   ```bash
   read -rs TOKEN   # paste the token, press Enter (nothing echoes)
   for r in supersprinklesracing/www supersprinklesracing/girosf \
            jlapenna/nx-cache-server jlapenna/sync-padd; do
     printf %s "$TOKEN" | gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$r"
   done; unset TOKEN
   ```

3. Verify: label an issue `agent:claude`; the lane's "Run Claude Code"
   step is the consumer. An empty token fails exactly there.

## Codex `auth.json` lineage (codex lane)

The codex lane restores `~/.codex/auth.json` from GCP Secret Manager, and
Codex **rotates the credential on every run** — the lane's "Persist
refreshed subscription authentication" step writes the rotated blob back as
a new secret version. That makes each repo's secret a _lineage_, not a
value:

> **Never copy the blob from another repo's secret.** Two repos sharing one
> lineage invalidate each other on every run (the lane's own comment block
> documents this). Mint an independent login per repo — same ChatGPT
> subscription, separate rotating token.

Per new repo:

1. On a workstation with no live Codex session you care about, run
   `codex login`. Like the Claude mint, it prints an authorization URL and
   waits — complete it in the maintainer's signed-in browser (an agent
   with browser tooling: navigate, approve). Result: a fresh
   `~/.codex/auth.json`.
2. Upload it as that repo's own secret, then remove the local copy so no
   competing lineage exists. Pick the project deliberately: precedent is
   the owning org's project (`supersprinklesracing` for that org's repos);
   for `jlapenna`-account repos no convention exists yet — that is a
   maintainer decision to make once and record here. Do **not** discard
   errors on the create — a permission failure must stop the run;
   "already exists" is the only acceptable one:

   ```bash
   proj=<project>
   name=SYNC_PADD_CODEX_AUTH_JSON # <REPO>_CODEX_AUTH_JSON
   gcloud secrets describe "$name" --project="$proj" >/dev/null 2>&1 ||
     gcloud secrets create "$name" --project="$proj"
   gcloud secrets versions add "$name" --project="$proj" \
     --data-file="$HOME/.codex/auth.json"
   rm "$HOME/.codex/auth.json" # the lineage lives in Secret Manager now
   ```

3. Wire the WIF plumbing the lane's restore/persist steps authenticate
   with. The live sprinkles provider is the template — pool
   `claude-agent-pool`, provider `claude-agent-github`, project
   `supersprinklesracing` — and its attribute condition has this shape:

   ```text
   assertion.repository=='<owner>/<repo>' &&
     (assertion.job_workflow_ref.startsWith('<owner>/<repo>/.github/workflows/codex.yml')
      || assertion.job_workflow_ref.startsWith('jlapenna/agent-lcars/.github/workflows/agent-lane-codex.yml'))
   ```

   To admit a new repo where the pool already exists, read the current
   condition first
   (`gcloud iam workload-identity-pools providers describe
claude-agent-github --location=global
--workload-identity-pool=claude-agent-pool --project=<proj>
--format='value(attributeCondition)'`), extend it, and write it back
   with `... providers update-oidc ... --attribute-condition='<full new
condition>'` — the flag **replaces** the condition, so always start
   from the read. For a `jlapenna`-account repo there is no pool at all
   yet: creating one (`workload-identity-pools create` + `create-oidc`
   against issuer `https://token.actions.githubusercontent.com`) is a
   maintainer infrastructure decision, not something to improvise
   mid-onboarding. The service account needs
   `roles/secretmanager.secretAccessor` **and** version-add on that one
   secret (the rotate-writeback), plus `roles/iam.workloadIdentityUser`
   for `principalSet://…/attribute.repository/<owner>/<repo>`.

4. Set the repo side: caller inputs `codex-auth-secret-name` /
   `gcp-project-id` in `codex.yml`; the four 2026-08 onboarded repos read
   vars instead — `gh variable set GCP_WIF_PROVIDER` /
   `GCP_CODEX_AGENT_SA`.
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
