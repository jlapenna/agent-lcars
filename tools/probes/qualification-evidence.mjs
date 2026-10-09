// Release evidence only. These functions never authorize production activation.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { nativeModes, setupModes } from './qualification-modes.mjs';

export function artifactHashes(source) {
  const hash = (path) =>
    createHash('sha256').update(readFileSync(path)).digest('hex');
  const directoryHashes = (directory, include) =>
    Object.fromEntries(
      readdirSync(join(source, directory))
        .filter(include)
        .map((name) => [name, hash(join(source, directory, name))]),
    );
  return {
    moduleHashes: directoryHashes('packages/fleet-tools/bin', (name) =>
      /^(worker-|fleet-identity).*\.(cjs|mjs)$/.test(name),
    ),
    probeHashes: directoryHashes('tools/probes', (name) =>
      name.endsWith('.mjs'),
    ),
    runtimeHashes: Object.fromEntries(
      [
        'worker-policy-bootstrap.sh',
        'verify-outcome.sh',
        'worker-completion.sh',
      ].map((name) => [
        name,
        hash(join(source, 'apps/runner-autoscaler/runner-image/runtime', name)),
      ]),
    ),
    runnerHash: hash(
      join(source, 'apps/runner-autoscaler/runner-image/direct-runner.sh'),
    ),
  };
}

// Consume the whole native suite plus actual setup-negative boundary. Reject
// partial/selective reports even when their top-level passed flag is true.
export function evaluateImageEvidence(expected, native, setup) {
  const failures = [];
  const fail = (reason) => failures.push(reason);
  if (!['claude', 'codex', 'opencode'].includes(expected?.provider))
    return {
      offlinePassed: false,
      failures: ['invalid-provider'],
      graduated: false,
    };
  if (
    !/^sha256:[a-f0-9]{64}$/.test(expected.imageId ?? '') ||
    !/^[a-f0-9]{40}$/.test(expected.sourceCommit ?? '') ||
    !expected.providerVersion
  )
    fail('invalid-artifact-identity');
  for (const [kind, report, modes] of [
    ['native', native, nativeModes(expected.provider)],
    ['setup', setup, setupModes],
  ]) {
    if (
      !report ||
      report.passed !== true ||
      report.jobUid !== 1001 ||
      report.imageId !== expected.imageId ||
      report.provider !== expected.provider ||
      report.nativeReport?.provider !== expected.provider ||
      report.nativeReport?.providerVersion !== expected.providerVersion
    )
      fail(kind + ':identity-or-execution');
    for (const field of ['moduleHashes', 'probeHashes', 'runtimeHashes']) {
      const actual = report?.[field];
      const wanted = expected[field];
      if (
        !wanted ||
        Object.keys(wanted).length === 0 ||
        !actual ||
        Object.keys(actual).length !== Object.keys(wanted).length ||
        Object.entries(wanted).some(
          ([name, hash]) =>
            !/^[a-f0-9]{64}$/.test(hash) || actual[name] !== hash,
        )
      )
        fail(kind + ':source-mismatch:' + field);
    }
    if (
      !/^[a-f0-9]{64}$/.test(expected.runnerHash ?? '') ||
      report?.runnerHash !== expected.runnerHash
    )
      fail(kind + ':source-mismatch:runner');
    const observations = report?.nativeReport?.observations;
    if (
      !Array.isArray(observations) ||
      observations.length !== modes.length ||
      modes.some(
        (mode) =>
          observations.filter(
            (entry) =>
              entry?.mode === mode && entry.observedExpectedPrimitive === true,
          ).length !== 1,
      )
    )
      fail(kind + ':incomplete-scenarios');
  }
  return {
    offlinePassed: failures.length === 0,
    failures,
    graduated: false,
    activationAuthorized: false,
    remainingGates: [
      'monotonic provider-budget qualification (#2223)',
      'real policy-enabled dispatch acceptance (#2181)',
      'interactive/member-repository acceptance (#2044 and #2181)',
      'maintainer approval for exact provider/image/target (#2181)',
    ],
  };
}
