import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  const signal = vi.fn(async () => ({ operation: 'signal' }));
  const admission = vi.fn(async () => ({ operation: 'admission' }));
  const launch = vi.fn(async () => ({ operation: 'launch' }));
  const runBinding = vi.fn(async () => ({ operation: 'run-binding' }));
  const cancellation = vi.fn(async () => ({ operation: 'cancellation' }));
  const recordTerminal = vi.fn(async () => ({ operation: 'record-terminal' }));
  const recordClaim = vi.fn(async () => ({ operation: 'record-claim' }));
  const beginValidation = vi.fn(async () => ({
    operation: 'begin-validation',
  }));
  const resolveClaim = vi.fn(async () => ({ operation: 'resolve-claim' }));
  const finalize = vi.fn(async () => ({ operation: 'finalize' }));
  const presentation = vi.fn(async () => ({ operation: 'presentation' }));
  const grant = vi.fn(async () => ({ operation: 'grant' }));

  return {
    handlers: {
      signal,
      admission,
      launch,
      runBinding,
      cancellation,
      recordTerminal,
      recordClaim,
      beginValidation,
      resolveClaim,
      finalize,
      presentation,
      grant,
    },
    constructors: {
      signal: vi.fn(function () {
        return { handleWebhook: signal };
      }),
      admission: vi.fn(function () {
        return { reconcile: admission };
      }),
      launch: vi.fn(function () {
        return { reconcile: launch };
      }),
      runBinding: vi.fn(function () {
        return { ingest: runBinding };
      }),
      cancellation: vi.fn(function () {
        return { reconcile: cancellation };
      }),
      finalization: vi.fn(function () {
        return {
          recordTerminal,
          recordClaim,
          beginValidation,
          resolveClaim,
          finalize,
        };
      }),
      presentation: vi.fn(function () {
        return { deliver: presentation };
      }),
      grant: vi.fn(function () {
        return { handle: grant };
      }),
    },
  };
});

vi.mock('@agent-lcars/lifecycle-control-plane', async () => {
  const actual = await vi.importActual<
    typeof import('@agent-lcars/lifecycle-control-plane')
  >('@agent-lcars/lifecycle-control-plane');
  return {
    ...actual,
    SignalTaskComposition: mocked.constructors.signal,
    TaskAdmissionEffectComposition: mocked.constructors.admission,
    LaunchOutboxComposition: mocked.constructors.launch,
    RunBindingIngressComposition: mocked.constructors.runBinding,
    CancellationTaskEffectComposition: mocked.constructors.cancellation,
    AttemptFinalizationComposition: mocked.constructors.finalization,
    PresentationDeliveryComposition: mocked.constructors.presentation,
    createCredentialGrantComposition: mocked.constructors.grant,
  };
});

import type { HostedLifecycleRuntimeDependencies } from './hosted-runtime';
import { createHostedLifecycleRuntime } from './hosted-runtime';

function runtimeDependencies(): HostedLifecycleRuntimeDependencies {
  return {
    storage: {},
    leases: {},
    clock: {},
    signals: {},
    admissionEffects: { plans: {} },
    launchOutbox: { responses: {} },
    runBinding: { verifier: {} },
    finalization: { verifier: {}, resolver: {} },
    presentation: { receiver: {} },
    credentialGrant: {},
  } as HostedLifecycleRuntimeDependencies;
}

describe('hosted lifecycle runtime operation routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates every facade operation exactly once and freezes cloned receipts', async () => {
    const runtime = createHostedLifecycleRuntime(runtimeDependencies());
    const input = {} as never;

    const receipts = await Promise.all([
      runtime.signals.handleWebhook(input),
      runtime.admissionEffects.reconcile(input),
      runtime.launchOutbox.reconcile(input),
      runtime.runBinding.ingest(input),
      runtime.cancellationEffects.reconcile(input),
      runtime.finalization.recordTerminal(input),
      runtime.finalization.recordClaim(input),
      runtime.finalization.beginValidation(input),
      runtime.finalization.resolveClaim(input),
      runtime.finalization.finalize(input),
      runtime.presentation.deliver(input),
      runtime.credentialGrant.handle(input),
    ]);

    for (const receipt of receipts) {
      expect(Object.isFrozen(receipt)).toBe(true);
    }
    expect(receipts.map((receipt) => receipt.operation)).toEqual([
      'signal',
      'admission',
      'launch',
      'run-binding',
      'cancellation',
      'record-terminal',
      'record-claim',
      'begin-validation',
      'resolve-claim',
      'finalize',
      'presentation',
      'grant',
    ]);
    for (const handler of Object.values(mocked.handlers)) {
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(input);
    }
    for (const constructor of Object.values(mocked.constructors)) {
      expect(constructor).toHaveBeenCalledTimes(1);
    }
  });

  it('propagates the exact composition error without retrying or routing elsewhere', async () => {
    const runtime = createHostedLifecycleRuntime(runtimeDependencies());
    const error = new Error('resolver unavailable');
    mocked.handlers.resolveClaim.mockRejectedValueOnce(error);

    await expect(runtime.finalization.resolveClaim({} as never)).rejects.toBe(
      error,
    );
    expect(mocked.handlers.resolveClaim).toHaveBeenCalledTimes(1);
    const otherHandlers = Object.entries(mocked.handlers).filter(
      ([name]) => name !== 'resolveClaim',
    );
    for (const [, handler] of otherHandlers) {
      expect(handler).not.toHaveBeenCalled();
    }
  });
});
