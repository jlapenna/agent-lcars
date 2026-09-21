#!/usr/bin/env node
'use strict';

// Offline canary evidence evaluator. Not a runtime health check or an
// authentication boundary: only a trusted runner may supply this evidence.
const fs = require('node:fs');

const providers = ['claude', 'codex', 'opencode'];
const scenarios = [
  'valid-work',
  'invalid-identity',
  'mode-violation',
  'ownership-lost',
  'primary-worktree',
  'missing-marker',
  'premature-completion',
  'review-hold',
  'missing-hook',
  'hook-failure',
  'recovery-success',
  'recovery-exhausted',
  'authorized-exception',
];

function evaluate(report, expected, now = Date.now()) {
  const failures = [];
  const fail = (reason) => failures.push(reason);
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ready: false, failures: ['invalid-report'] };
  }
  if (!expected || !providers.includes(expected.provider)) {
    return { ready: false, failures: ['invalid-expected-provider'] };
  }
  if (report.schemaVersion !== 1) fail('unsupported-schema');
  // Bind evidence to the exact artifact combination, not a provider name alone.
  for (const key of [
    'provider',
    'providerVersion',
    'imageDigest',
    'policyDigest',
    'adapterDigest',
  ]) {
    if (
      typeof expected[key] !== 'string' ||
      !expected[key].trim() ||
      report[key] !== expected[key]
    ) {
      fail(`identity-mismatch:${key}`);
    }
  }
  const started = Date.parse(report.startedAt);
  const expires = Date.parse(report.expiresAt);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(started) ||
    !Number.isFinite(expires) ||
    started > now ||
    expires <= now ||
    expires <= started
  ) {
    fail('invalid-evidence-window');
  }
  const results = Array.isArray(report.results) ? report.results : [];
  for (const scenario of scenarios) {
    const matches = results.filter((result) => result?.scenario === scenario);
    if (matches.length !== 1) {
      fail(`missing-or-duplicate:${scenario}`);
      continue;
    }
    const result = matches[0];
    if (
      result.status !== 'passed' ||
      result.evidenceKind !== 'runtime' ||
      typeof result.evidenceRef !== 'string' ||
      !result.evidenceRef.trim()
    ) {
      fail(`unproven:${scenario}`);
    }
  }
  return { ready: failures.length === 0, failures };
}

if (require.main === module) {
  try {
    const [reportPath, expectedPath, ...extra] = process.argv.slice(2);
    if (!reportPath || !expectedPath || extra.length) {
      throw new Error(
        'usage: worker-readiness.cjs <report.json> <expected-artifacts.json>',
      );
    }
    const result = evaluate(
      JSON.parse(fs.readFileSync(reportPath, 'utf8')),
      JSON.parse(fs.readFileSync(expectedPath, 'utf8')),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ ready: false, failures: ['invalid-input'] })}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { evaluate, scenarios };
