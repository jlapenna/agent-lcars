import { describe, expect, it } from 'vitest';

import {
  defaultDispatchRequestId,
  HostedRouteRequestError,
  parseHostedCompletionRequestBody,
  parseHostedDispatchRequestBody,
} from './control-plane-request';

const REPO = 'jlapenna/agent-lcars';

describe('parseHostedDispatchRequestBody (#1215)', () => {
  it('accepts a minimal body: just issue and pipeline', () => {
    expect(
      parseHostedDispatchRequestBody({ issue: 42, pipeline: 'claude' }),
    ).toEqual({ issue: 42, pipeline: 'claude' });
  });

  it('accepts the full body: mode, reply, runbook, context, requestId', () => {
    const body = {
      issue: 42,
      pipeline: 'codex',
      mode: 'implement',
      reply: 'thanks',
      runbook: 'pr-heal',
      context: 'nightly sweep',
      requestId: 'caller-key',
    };
    expect(parseHostedDispatchRequestBody(body)).toEqual(body);
  });

  it.each(['claude', 'codex', 'opencode'])(
    'accepts pipeline %s',
    (pipeline) => {
      expect(
        parseHostedDispatchRequestBody({ issue: 1, pipeline }),
      ).toMatchObject({ pipeline });
    },
  );

  it.each([
    [{ issue: 0, pipeline: 'claude' }, 'non-positive issue'],
    [{ issue: -1, pipeline: 'claude' }, 'negative issue'],
    [{ issue: 1.5, pipeline: 'claude' }, 'non-integer issue'],
    [{ issue: 1, pipeline: 'gpt5' }, 'unsupported pipeline'],
    [{ issue: 1 }, 'missing pipeline'],
    [{ pipeline: 'claude' }, 'missing issue'],
    [{ issue: 1, pipeline: 'claude', mode: '' }, 'empty mode'],
    [{ issue: 1, pipeline: 'claude', runbook: '' }, 'empty runbook'],
    [
      { issue: 1, pipeline: 'claude', reply: 'x'.repeat(8_193) },
      'reply over the length bound',
    ],
    [
      { issue: 1, pipeline: 'claude', context: 'x'.repeat(4_097) },
      'context over the length bound',
    ],
    [
      { issue: 1, pipeline: 'claude', requestId: '' },
      'empty explicit requestId',
    ],
    [
      { issue: 1, pipeline: 'claude', extra: 'unexpected' },
      'an unrecognized field (strict schema)',
    ],
  ])('rejects %j (%s)', (body) => {
    expect(() => parseHostedDispatchRequestBody(body)).toThrow(
      HostedRouteRequestError,
    );
  });
});

describe('parseHostedCompletionRequestBody', () => {
  it('accepts a completion body without issue when intentId is present', () => {
    expect(() =>
      parseHostedCompletionRequestBody({
        workflow: 'claude.yml',
        intentId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      }),
    ).not.toThrow();
  });
});

describe('defaultDispatchRequestId (#1215)', () => {
  it('is deterministic for the same (repository, issue, runbook, caller run id)', () => {
    const input = {
      repository: REPO,
      issue: 42,
      runbook: 'pr-heal',
      callerRunId: 555,
    };
    expect(defaultDispatchRequestId(input)).toBe(
      defaultDispatchRequestId({ ...input }),
    );
  });

  it.each([
    [{ repository: 'other-org/other-repo' }, 'a different repository'],
    [{ issue: 43 }, 'a different issue'],
    [{ runbook: 'visual-refresh' }, 'a different runbook'],
    [{ callerRunId: 556 }, 'a different caller run id'],
    [{ runbook: undefined }, 'no runbook at all'],
    [{ callerRunId: undefined }, 'no caller run id at all'],
  ])('differs when %j changes (%s)', (override) => {
    const base = {
      repository: REPO,
      issue: 42,
      runbook: 'pr-heal',
      callerRunId: 555,
    };
    expect(defaultDispatchRequestId({ ...base, ...override })).not.toBe(
      defaultDispatchRequestId(base),
    );
  });

  it("is bounded well within Run.requestId's 128-character limit", () => {
    const id = defaultDispatchRequestId({
      repository: REPO,
      issue: 42,
      runbook: 'pr-heal',
      callerRunId: 555,
    });
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/^request:[0-9a-f]{64}$/u);
  });
});
