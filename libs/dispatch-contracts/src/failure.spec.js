import { describe, expect, it } from 'vitest';

import {
  classifyFailure,
  FAILURE_PHASES,
  FAILURE_REASONS,
  formatFailure,
  isAutomaticallyRetryable,
  needsMaintainer,
  OWNING_SYSTEMS,
  PHASE_OWNERS,
  RETRY_DISPOSITIONS,
} from './failure.js';

describe('the vocabulary', () => {
  it('assigns every phase an owning system', () => {
    for (const phase of FAILURE_PHASES) {
      expect(OWNING_SYSTEMS).toContain(PHASE_OWNERS[phase]);
    }
  });

  it('covers all five systems', () => {
    expect(new Set(Object.values(PHASE_OWNERS))).toEqual(
      new Set(OWNING_SYSTEMS),
    );
  });

  it('keeps reason codes unique', () => {
    // These are joined on by dashboards and alerts. A duplicate would mean
    // two meanings behind one code, which is the failure this vocabulary is
    // meant to end.
    expect(new Set(FAILURE_REASONS).size).toBe(FAILURE_REASONS.length);
  });
});

describe('classifyFailure', () => {
  it('derives the owning system from the phase', () => {
    // The point of the derivation: whoever caught the exception does not get
    // to decide whose failure it is.
    expect(
      classifyFailure({
        phase: 'provider_execution',
        reason: 'provider_graph_allocation_failed',
        retryDisposition: 'backoff',
      }).owningSystem,
    ).toBe('worker');
  });

  it.each(
    /** @type {const} */ ([
      ['launch', 'controller'],
      ['runner_allocation', 'runner'],
      ['bootstrap', 'worker'],
      ['validation', 'finalizer'],
      ['reporting', 'projector'],
    ]),
  )('maps the %s phase to %s', (phase, owner) => {
    expect(
      classifyFailure({
        phase,
        reason: 'internal_error',
        retryDisposition: 'never',
      }).owningSystem,
    ).toBe(owner);
  });

  it('lets a caller override the derived owner', () => {
    expect(
      classifyFailure({
        phase: 'telemetry',
        reason: 'telemetry_upload_failed',
        retryDisposition: 'backoff',
        owningSystem: 'worker',
      }).owningSystem,
    ).toBe('worker');
  });

  it('refuses to guess an owner for a reconciliation failure', () => {
    // Every system reconciles the state it owns, so the phase alone cannot
    // name the owner — guessing here would misattribute by construction.
    expect(() =>
      classifyFailure({
        phase: 'reconciliation',
        reason: 'signal_evicted',
        retryDisposition: 'immediate',
      }),
    ).toThrowError(/must name their owning system/u);

    expect(
      classifyFailure({
        phase: 'reconciliation',
        reason: 'signal_evicted',
        retryDisposition: 'immediate',
        owningSystem: 'controller',
      }).owningSystem,
    ).toBe('controller');
  });

  it.each([
    [
      'an unknown phase',
      { phase: 'vibes', reason: 'internal_error', retryDisposition: 'never' },
    ],
    [
      'an unknown reason',
      { phase: 'launch', reason: 'it_broke', retryDisposition: 'never' },
    ],
    [
      'an unknown disposition',
      { phase: 'launch', reason: 'internal_error', retryDisposition: 'maybe' },
    ],
    [
      'an unknown system',
      {
        phase: 'launch',
        reason: 'internal_error',
        retryDisposition: 'never',
        owningSystem: 'database',
      },
    ],
    [
      'a negative budget',
      {
        phase: 'launch',
        reason: 'internal_error',
        retryDisposition: 'backoff',
        retryBudget: -1,
      },
    ],
  ])('rejects %s', (_label, input) => {
    // A typo'd code that reaches a dashboard is worse than no code: it reads
    // as a real category nobody is alerting on. The cast is the point of the
    // test: these inputs are invalid by construction, so the compiler would
    // refuse them -- what is being asserted is the runtime guard that catches
    // the same mistake arriving from JSON, where no compiler was involved.
    expect(() =>
      classifyFailure(
        /** @type {Parameters<typeof classifyFailure>[0]} */ (input),
      ),
    ).toThrowError();
  });

  it('omits optional fields rather than emitting undefined', () => {
    expect(
      classifyFailure({
        phase: 'launch',
        reason: 'launch_rejected',
        retryDisposition: 'never',
      }),
    ).toEqual({
      owningSystem: 'controller',
      phase: 'launch',
      reason: 'launch_rejected',
      retryDisposition: 'never',
    });
  });

  it('carries the evidence that makes a retry safe', () => {
    const failure = classifyFailure({
      phase: 'launch',
      reason: 'launch_response_lost',
      retryDisposition: 'backoff',
      retryBudget: 3,
      evidence: 'no run bound to this attempt marker after two listings',
    });
    expect(failure.evidence).toMatch(/no run bound/u);
    expect(failure.retryBudget).toBe(3);
  });
});

describe('isAutomaticallyRetryable', () => {
  it('permits only the two transient dispositions', () => {
    for (const retryDisposition of RETRY_DISPOSITIONS) {
      const failure = classifyFailure({
        phase: 'launch',
        reason: 'internal_error',
        retryDisposition,
      });
      expect(isAutomaticallyRetryable(failure)).toBe(
        retryDisposition === 'immediate' || retryDisposition === 'backoff',
      );
    }
  });

  it('stops when the budget is spent even if the disposition allows retry', () => {
    const spent = classifyFailure({
      phase: 'provider_admission',
      reason: 'provider_admission_denied',
      retryDisposition: 'backoff',
      retryBudget: 0,
    });
    expect(isAutomaticallyRetryable(spent)).toBe(false);
  });

  it('never retries a failure blocked on a health or config change', () => {
    // The distinction that keeps a retry loop from spinning against a
    // condition it cannot affect.
    for (const retryDisposition of /** @type {const} */ ([
      'after_health_change',
      'after_configuration_change',
    ])) {
      expect(
        isAutomaticallyRetryable(
          classifyFailure({
            phase: 'runner_allocation',
            reason: 'runner_allocation_timeout',
            retryDisposition,
            retryBudget: 99,
          }),
        ),
      ).toBe(false);
    }
  });
});

describe('needsMaintainer', () => {
  it('does not hand a retryable infrastructure incident to a human', () => {
    // #645: mapping every infrastructure failure to needs-human is a
    // projector anti-pattern. A retryable runner incident stays owned by the
    // runner platform.
    expect(
      needsMaintainer(
        classifyFailure({
          phase: 'runner_allocation',
          reason: 'runner_lost',
          retryDisposition: 'backoff',
          retryBudget: 2,
        }),
      ),
    ).toBe(false);
  });

  it('hands over anything needing a decision or a config change', () => {
    for (const retryDisposition of /** @type {const} */ ([
      'manual',
      'after_configuration_change',
    ])) {
      expect(
        needsMaintainer(
          classifyFailure({
            phase: 'bootstrap',
            reason: 'work_token_mint_failed',
            retryDisposition,
          }),
        ),
      ).toBe(true);
    }
  });

  it('does not page a human for an intent that was simply superseded', () => {
    // `never` usually means a human must look, but a superseded intent is
    // the ordinary outcome of relabelling twice — not an incident.
    expect(
      needsMaintainer(
        classifyFailure({
          phase: 'intent',
          reason: 'intent_superseded',
          retryDisposition: 'never',
        }),
      ),
    ).toBe(false);
  });
});

describe('formatFailure', () => {
  it('renders a greppable single line', () => {
    expect(
      formatFailure(
        classifyFailure({
          phase: 'validation',
          reason: 'deliverable_absent',
          retryDisposition: 'never',
        }),
      ),
    ).toBe('[finalizer/validation] deliverable_absent retry=never');
  });

  it('includes the budget when one is set', () => {
    expect(
      formatFailure(
        classifyFailure({
          phase: 'provider_execution',
          reason: 'provider_unavailable',
          retryDisposition: 'backoff',
          retryBudget: 2,
        }),
      ),
    ).toBe(
      '[worker/provider_execution] provider_unavailable retry=backoff budget=2',
    );
  });
});

describe('the audited failures from #645 all have a classification', () => {
  // One row per line of the issue's "Mapping the audited failures" table.
  // If this vocabulary cannot express the failures that motivated it, it is
  // the wrong vocabulary.
  it.each(
    /** @type {const} */ ([
      [
        'Quick Task digest mismatch',
        'intent',
        'quick_task_digest_mismatch',
        'controller',
      ],
      ['Queue-evicted label event', 'signal', 'signal_evicted', 'controller'],
      [
        'Concurrency-group listing unreliable',
        'signal',
        'concurrency_group_unverifiable',
        'controller',
      ],
      [
        'Self-hosted runner wait or loss',
        'runner_allocation',
        'runner_lost',
        'runner',
      ],
      [
        'Work-token mint failure',
        'bootstrap',
        'work_token_mint_failed',
        'worker',
      ],
      [
        'OpenCode graph allocation',
        'provider_admission',
        'provider_graph_allocation_failed',
        'worker',
      ],
      [
        'Clean CLI exit with no artifact',
        'validation',
        'deliverable_absent',
        'finalizer',
      ],
      [
        'Failure comment unavailable',
        'reporting',
        'github_write_failed',
        'projector',
      ],
      [
        'WIF transcript/archive failure',
        'telemetry',
        'telemetry_upload_failed',
        'projector',
      ],
    ]),
  )('%s', (_label, phase, reason, owner) => {
    expect(
      classifyFailure({ phase, reason, retryDisposition: 'manual' })
        .owningSystem,
    ).toBe(owner);
  });
});
