# The IAM contract: the model this repo owns

`docs/fleet-credentials.md` describes the fleet's identity model in prose.
Nothing verified it, and that cost real time: the App-location table sent the
maintainer to two empty settings pages, the private-key lineage was documented
two contradictory ways until a live JWT mint settled it, and the #1368 outage
was spent testing IAM hypotheses one CI run at a time.

`tools/iam-contract/model.json` is the part a machine can check (#1376).

## Where the halves live

**This repo owns the model.** Comparing the model to live GitHub and GCP is
_drift detection_ — that is monitoring, not a test, and this fleet has exactly
one place for monitoring. A GitHub Actions workflow polling live IAM would make
the production identity plane depend on Actions, and would report through a
channel nobody watches.

| Half                     | Where                                                                                        | What                                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model                | here — `tools/iam-contract/model.json`                                                       | Fleet repositories, both GitHub Apps and their installations, every WIF pool/provider with its byte-exact condition, the per-project user-managed-key allowlist, and `CLAUDE_CODE_OAUTH_TOKEN`'s binding set.                                                                                               |
| Offline self-consistency | here — `tools/contract-tests/iam-contract-model.test.ts`, in `pnpm check:contracts`          | The model must agree with Terraform's `local.github_repositories`, the modelled shared-pool condition must equal the string Terraform generates, and every exemption must carry a reason. No credentials, so it runs on every PR.                                                                           |
| Live drift detection     | [jlapenna/homelab](https://github.com/jlapenna/homelab) — `bin/emit-iam-contract-metrics.py` | A scheduled collector on the homelab controller (which already holds `gcloud` and `gh` credentials) reads this file from `main`, diffs it against live state, and publishes `node_homelab_iam_contract_*` through node-exporter. Alerts live in `observability/prometheus/rules.yml`, group `iam-contract`. |

The collector reads the model from `main`, so **this repo's change lands
first** and the collector picks it up on its next cycle — no pinning, no copy
to keep in sync.

## What the collector asserts

| Surface               | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Apps           | Per App: slug, client id, owner login **and type** (both Apps are owned by the `agent-lcars` _user_, not an org — the fact that produced the two empty settings pages), and the exact permission set. Per installation: the exact set of ids, each one's account, its `repository_selection`, and the exact repository list it covers. Then: every fleet repository is covered by some installation, unless `fleetCoverageExceptions` names it with a reason. |
| Trusted workflow refs | Every `owner/repo/.github/workflows/x.yml` appearing in a modelled provider condition still exists on that repository. A dead `deploy.yml` clause survived exactly this way.                                                                                                                                                                                                                                                                                  |
| WIF                   | The exact set of pools per project, each pool's state, the exact set of providers, and per provider its state, issuer URI, attribute mapping and **byte-exact** attribute condition.                                                                                                                                                                                                                                                                          |
| Service account keys  | No service account in either project holds a user-managed key, except the allowlisted ones. The allowlist is a ratchet: an allowlisted account that no longer holds a key is **also** drift, so a retired exemption cannot be inherited by the next key.                                                                                                                                                                                                      |
| Secret bindings       | `CLAUDE_CODE_OAUTH_TOKEN` carries exactly one binding — `secretAccessor` for `claude-token-reader`. Two speculative grants were added while chasing #1368 and pruned the same night; nothing else stops the next ones from persisting.                                                                                                                                                                                                                        |

Every drift series carries `resource`, `expected` and `actual` labels, and the
alert annotation prints them — so the next incident starts with an answer
rather than a hypothesis.

## Changing the model

Drift has exactly two causes, and the alert says which to look for: either the
world drifted (fix the world) or the model is out of date. When it is the
model, edit `tools/iam-contract/model.json` **and** `docs/fleet-credentials.md`
in the same change — the prose and the model going out of step is the original
failure this exists to prevent.

To see live state in the model's own shape, run the homelab collector's dump
mode from a machine with `gcloud` and `gh` credentials:

```bash
bin/emit-iam-contract-metrics.py --dump
```

## Known gaps

None. Both were closed the day they were found, and the check is what closed
them — each is published as a `node_homelab_iam_contract_unasserted` series
while it lasts, so a gap cannot quietly become permanent.

- **`supersprinklesracing/www` was not covered by the fleet App installation**
  (#1380). The shared `github` WIF pool trusted it and Terraform provisioned
  its codex lineage (#1354), but installation `150568991` covered only
  `sprinkles` and `girosf`. Now installed. The exception entry that recorded it
  was itself reported as drift once the repository appeared, which is how the
  model got updated rather than left behind.
- **The autoscaler App was believed unassertable**, on the grounds that its
  private key existed only in homelab's ansible vault. That was wrong: the key
  is deployed on the controller for the runner scale-set listeners and the
  collector reads it there in place, so both Apps are now asserted
  (jlapenna/homelab#768).

## Installation scope and repository onboarding

The autoscaler App holds `administration: write`, so an installation's scope is
authority over every repository it covers. Its modelled contract is asymmetric:

| Installation | Account              | Selection  | Repos           |
| ------------ | -------------------- | ---------- | --------------- |
| `154210710`  | jlapenna             | `selected` | 6               |
| `154210731`  | supersprinklesracing | `all`      | 7 (4 non-fleet) |

The jlapenna installation was narrowed from `all` (23 repositories) once this
check measured it. #1381 is the execution record for narrowing the other one to
`sprinkles`, `www` and `girosf` — the evidence is there too: none of
`design`, `ghost-theme-supersprinkles`, `pos` or `preem-machine` holds a self-hosted
runner, and no workflow in any of them targets a fleet runner label.

The existing organization-side `154210731` baseline remains unchanged here.
When its separately owned narrowing lands, update `repositorySelection` to
`selected` and retain the three required repositories, together with the
credential documentation and genuine consumer verification.

Onboarding `jlapenna/messages-control` (#2436) adds one explicit membership to
fleet App `150568943` and autoscaler App `154210710`, not an `all` selection.
The latter also serves the Homelab Actions exporter. Fleet App `150568991`
continues to require selected access to `girosf`, `sprinkles` and `www`.
Preserve the other modelled repository grants and leave the separate
`jlaorg` installation unchanged.

A merged model is not evidence of live installation scope. An unexpected
`all` selection remains drift until the genuine collector observes the exact
contract and required consumers still work. Membership here does not widen
the Terraform-owned WIF `fleetRepositories` list or its provider condition;
that is a separate authorization boundary.

`jlapenna/homegit` is covered by `154210710` but has no `registrations:` entry
in homelab's `orchestrator.yml`: covered-but-unregistered, modelled as such
rather than treated as drift. Its one runner is registered with a manual
`RUNNER_TOKEN`, not by this App.

## The key file is part of the contract

The autoscaler App's private key is deployed on the controller and read there
in place. Its **mode and owner are modelled facts** (`600`, `homelab:homelab`),
asserted with `stat()` — which needs no read permission, so a key the collector
cannot open still produces a finding naming the mode rather than only an
unexplained blind section. This is not hypothetical: the mode went `600` → `000`
and back inside one evening.
