import assert from 'node:assert/strict';

import { test } from 'vitest';

import { classifyClaudeReadiness } from './claude-readiness.js';

test('classifies only an explicit zero-cost OAuth 401 as a credential failure', () => {
  assert.equal(
    classifyClaudeReadiness('failure', {
      api_error_status: 401,
      is_error: true,
      total_cost_usd: 0,
    }),
    'credential-failure',
  );
  for (const execution of [
    { api_error_status: 429, is_error: true, total_cost_usd: 0 },
    { is_error: true, total_cost_usd: 0 },
    { api_error_status: '401', is_error: true, total_cost_usd: 0 },
    { api_error_status: 401, is_error: true, total_cost_usd: 0.01 },
  ]) {
    assert.equal(classifyClaudeReadiness('failure', execution), 'unknown');
  }
});

test('requires both a successful action and a non-error result for recovery', () => {
  assert.equal(
    classifyClaudeReadiness('success', {
      is_error: false,
      total_cost_usd: 0.001,
    }),
    'healthy',
  );
  assert.equal(
    classifyClaudeReadiness('failure', { is_error: false }),
    'unknown',
  );
  assert.equal(
    classifyClaudeReadiness('success', { is_error: true }),
    'unknown',
  );
});

test('missing, malformed, and unrelated probe metadata remain unknown', () => {
  for (const execution of [
    undefined,
    null,
    [],
    'not-json',
    {},
    { result: 'ok' },
  ]) {
    assert.equal(classifyClaudeReadiness('success', execution), 'unknown');
  }
});
