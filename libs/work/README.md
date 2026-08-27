# @agent-lcars/work

Native work items: the spec schemas (`spec.ts`), the derived item state
and view (`derive.ts`), and the oRPC 2 contract for `/api/work/v1/items`
(`contract.ts`) with its OpenAPI document generator (`openapi.ts`).

Dependency-light on purpose: the `lcars` CLI bundles this library to get a
typed client from the contract, so nothing here may import `server-only`,
Firestore, or Next. The console implements the contract in
`apps/console/src/lib/work-router.ts`.

## Entry points

The library exports two separate entry points: `@agent-lcars/work` provides
the spec, contract, and OpenAPI generator (imports only zod, @orpc/*, and
dispatch-contracts, so the CLI bundle stays slim), while
`@agent-lcars/work/derive` provides derived item state and the item view
(imports the orchestrator, console-only). The `lcars work` CLI command uses
the contract to interact with the work API, configured via environment
variables: `LCARS_URL`, and either `LCARS_TOKEN` or the combination of
`LCARS_SERVICE_ACCOUNT` and `LCARS_AUDIENCE`.

Regenerate `docs/api/work-v1.openapi.json` with `pnpm work:openapi`; CI
fails when it is stale. Design:
`docs/superpowers/specs/2026-08-23-native-work-items-design.md`.

## Creating items from GitHub Actions

`.github/workflows/work-create.yml` is a `workflow_dispatch` surface for
maintainers without a browser session or a personal service account. It mints
a Google ID token for the Codex agent service account through the
repository-bounded GitHub WIF pool (the same impersonation the codex lane
uses) and `PUT`s the item; that service account carries the
`workflow:work-create` grant in `apps/console/apphosting.yaml`.

```bash
gh workflow run work-create.yml \
  -f title='Add healthz' \
  -f description='Expose GET /healthz. Open a PR; do not merge.' \
  -f repo=jlapenna/agent-lcars -f pipeline=claude
```

The run's step summary links the item's console page and names its first run.
