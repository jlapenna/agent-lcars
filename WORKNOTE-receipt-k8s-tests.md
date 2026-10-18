# Working note: receipt Kubernetes integration fence tests

Dispatch anchor: `work:01M561YMK3MPTZDVCVSZAF35EQ`, attempt
`g1:work:01M561YMK3MPTZDVCVSZAF35EQ/r1`.

## Acceptance criteria (from dispatch)

- One opt-in build-tagged (`kubernetes_integration`) Go test file in
  `apps/runner-autoscaler`: real `client-go` against an explicitly configured
  disposable namespace; fail closed when the configuration is incomplete.
- Two families: write fences (accepted create/update with lost response, late
  create vs inert tombstone, real UID/RV replacement and CAS preservation,
  resume refusal) and restored-Codex retirement (real bounded Pod, refusal
  while live, natural termination, `/exit` refusal or loss must not release,
  release carries the actual barrier UID/RV).
- Production behavior unchanged; ordinary `go test` unaffected; DRAFT PR with
  the attempt-claim marker; no arm/ready; no production namespace/context.

## Verified paths

- `apps/runner-autoscaler/queue_capacity_kubernetes.go:21` definitive-error set,
  `:79` `launchReceipt`, `:139` `resumeReceipt`, `:194` `reconcileReceipts`,
  `:407` `installAbsentBarrier`, `:430` `verifyRetiredBarrier`, `:541`
  `physicalReceiptWorkersEnded`, `:603` `retireReceipt`, `:692`
  `settleReceiptClaim`.
- `apps/runner-autoscaler/queue_capacity.go:307` `write` retains operation debt
  on non-definitive errors.
- `apps/runner-autoscaler/queue_kubernetes.go:628` `q.job` (codex needs no
  provider key; mounts `config.CredentialsSecret` `telemetry-writer.json`).
- Fixtures: `queue_capacity_test.go:23` `receiptFixture`,
  `queue_kubernetes_test.go:26` `kubeQueueFixture`,
  `queue_receipt_terminal_test.go` loopback Work API shape.

## Decisions

- Env-gated, no defaults for namespace/UID/labels/image digest/SA/dummy secret.
- Fixture Job keeps the production name/labels/receipt annotations but swaps the
  container command for a reviewed `sleep`/`exit` shell and tiny resources, so a
  real bounded Pod exists without running the direct runner.
- Faults injected with `rest.Config.WrapTransport` so the actual authenticated
  request is forwarded and its real response drained.

## Checks

- `gofmt -l`, `go vet -tags kubernetes_integration ./apps/runner-autoscaler`,
  `go test -tags=kubernetes_integration -run '^$' -c`, ordinary package tests.
