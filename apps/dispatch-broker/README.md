# @agent-lcars/dispatch-broker

## Status (2026-08-15, #1015 Wave 4)

The primary production admission/completion/reconciliation path moved to
`libs/orchestrator` + `apps/console`'s control-plane routes (verified live
end-to-end in #1178). This app is **not** the production event queue
anymore and its own CI-facing composite action, `.github/actions/dispatch-broker`,
was deleted along with `.github/actions/deliverable-watchdog` (both fully
provably dead — see `docs/lifecycle-systems.md`'s Wave 4 callout for the
survey evidence).

This app is kept, wholesale, for two remaining live reasons:

1. **Library dependency.** `apps/console/src/lib/hosted-controller.ts` (and
   `hosted-controller-command.ts`/`backend-actions.ts` above it) still import
   `main.ts`, `normalize.ts`, `storage/firestore-port.ts`, and
   `services/hosted-admission.ts` directly via the
   `@agent-lcars/dispatch-controller/*` path alias. That backs the console
   UI's Retry button, Reassign-pipeline menu item, and the post-mutation
   reconcile ping — real, user-facing commands, not the automated dispatch
   decision loop. Migrating those three commands onto the orchestrator is
   tracked as a follow-up, not done in this slice.
2. **Published bundle source.** `build-rerun-infra-killed-runs` still
   produces `.github/actions/rerun-infra-killed-runs/dist/main.mjs`, which
   `jlapenna/homelab` and `supersprinklesracing/sprinkles` consume directly
   as `jlapenna/agent-lcars/.github/actions/rerun-infra-killed-runs@main`
   (see `docs/published-actions.md`). This repo's own local scheduled use of
   that action (`.github/workflows/rerun-infra-killed-runs.yml`) was deleted
   in favor of the orchestrator's lease sweep, but the action itself is a
   published external contract this app still has to build.

`main.ts`'s CLI operation routing (`runOperation`: `preflight`,
`completion-callback`, `classify-claude-readiness`, `claude-readiness`) is
now unreachable dead code — nothing invokes `main.mjs` as a CLI anymore now
that `.github/actions/dispatch-broker` is gone. It was left in place rather
than untangled from `controller-core.ts`'s still-live library exports; that
untangling is a separate, riskier follow-up, not part of this deletion.

`apps/dispatch-broker/src/deliverable-watchdog/` and
`apps/dispatch-broker/src/storage/recovery-{port,firestore-port}.ts` were
removed in this same slice: both were standalone, zero-consumer subtrees
once their respective actions/routes were deleted.
