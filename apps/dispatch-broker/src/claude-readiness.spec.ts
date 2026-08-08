import assert from 'node:assert/strict';

import { test } from 'vitest';

import { classifyClaudeReadiness } from './claude-readiness.js';

test('classifies only an explicit zero-cost OAuth 401 as a credential failure', () => {
  assert.equal(
    classifyClaudeReadiness('failure', [
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
        subtype: 'success',
        api_error_status: 401,
        is_error: true,
        total_cost_usd: 0,
      },
    ]),
    'credential-failure',
  );
  for (const result of [
    { api_error_status: 429, is_error: true, total_cost_usd: 0 },
    { is_error: true, total_cost_usd: 0 },
    { api_error_status: '401', is_error: true, total_cost_usd: 0 },
    { api_error_status: 401, is_error: false, total_cost_usd: 0 },
    { api_error_status: 401, is_error: true, total_cost_usd: 0.01 },
  ]) {
    assert.equal(
      classifyClaudeReadiness('failure', [
        { type: 'result', subtype: 'success', ...result },
      ]),
      'unknown',
    );
  }
  assert.equal(
    classifyClaudeReadiness('success', [
      {
        type: 'result',
        subtype: 'success',
        api_error_status: 401,
        is_error: true,
        total_cost_usd: 0,
      },
    ]),
    'unknown',
  );
});

test('requires both a successful action and a non-error result for recovery', () => {
  assert.equal(
    classifyClaudeReadiness('success', [
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.001,
      },
    ]),
    'healthy',
  );
  assert.equal(
    classifyClaudeReadiness('failure', [
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.001,
      },
    ]),
    'unknown',
  );
  assert.equal(
    classifyClaudeReadiness('success', [
      { type: 'result', subtype: 'success', is_error: true },
    ]),
    'unknown',
  );
  for (const result of [
    { is_error: false },
    { is_error: false, total_cost_usd: Number.NaN },
    { is_error: false, total_cost_usd: -1 },
    { api_error_status: 401, is_error: false, total_cost_usd: 0 },
  ]) {
    assert.equal(
      classifyClaudeReadiness('success', [
        { type: 'result', subtype: 'success', ...result },
      ]),
      'unknown',
    );
  }
});

test('missing, malformed, and unrelated probe metadata remain unknown', () => {
  for (const execution of [
    undefined,
    null,
    [],
    'not-json',
    {},
    { result: 'ok' },
    [{ type: 'assistant' }],
    [
      { type: 'result', subtype: 'success', is_error: false },
      { type: 'assistant' },
    ],
    [
      { type: 'result', subtype: 'success', is_error: false },
      { type: 'result', subtype: 'success', is_error: false },
    ],
    [{ type: 'result', subtype: 'error_during_execution', is_error: true }],
  ]) {
    assert.equal(classifyClaudeReadiness('success', execution), 'unknown');
  }
});
