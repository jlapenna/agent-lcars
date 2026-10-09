import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  artifactHashes,
  evaluateImageEvidence,
} from '../probes/qualification-evidence.mjs';
import { nativeModes, setupModes } from '../probes/qualification-modes.mjs';

function evidence(provider: string) {
  const expected = {
    provider,
    providerVersion: 'fixture-cli-version',
    imageId: 'sha256:' + 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    ...artifactHashes(resolve(import.meta.dirname, '../..')),
  };
  const report = (modes: string[]) => ({
    ...expected,
    jobUid: 1001,
    passed: true,
    qualification: 'not-evaluated',
    nativeReport: {
      provider,
      providerVersion: expected.providerVersion,
      observations: modes.map((mode) => ({
        mode,
        observedExpectedPrimitive: true,
      })),
    },
  });
  return {
    expected,
    native: report(nativeModes(provider)),
    setup: report(setupModes),
  };
}

describe('candidate worker image qualification consumer', () => {
  it.each(['claude', 'codex', 'opencode'])(
    'accepts complete offline evidence for %s independently without graduating it',
    (provider) => {
      const { expected, native, setup } = evidence(provider);
      expect(evaluateImageEvidence(expected, native, setup)).toMatchObject({
        offlinePassed: true,
        graduated: false,
        activationAuthorized: false,
      });
    },
  );

  it.each(['claude', 'codex', 'opencode'])(
    'rejects selective passing reports missing valid or prohibited operations for %s',
    (provider) => {
      for (const mode of [
        'bootstrap-workflow',
        'bootstrap-push-review',
        'bootstrap-workflow-recovery-exhausted',
        'bootstrap-hold-merge-blocked',
      ]) {
        const { expected, native, setup } = evidence(provider);
        native.nativeReport.observations =
          native.nativeReport.observations.filter(
            (entry) => entry.mode !== mode,
          );
        expect(
          evaluateImageEvidence(expected, native, setup).offlinePassed,
        ).toBe(false);
      }
    },
  );

  it('rejects mixed images, providers, versions, execution users and failed transports', () => {
    for (const mutation of [
      { imageId: 'sha256:' + 'c'.repeat(64) },
      { provider: 'claude' },
      { jobUid: 0 },
      { passed: false },
      {
        nativeReport: {
          provider: 'codex',
          providerVersion: 'other',
          observations: [],
        },
      },
    ]) {
      const { expected, native, setup } = evidence('codex');
      for (const kind of ['native', 'setup']) {
        expect(
          evaluateImageEvidence(
            expected,
            kind === 'native' ? { ...native, ...mutation } : native,
            kind === 'setup' ? { ...setup, ...mutation } : setup,
          ).offlinePassed,
        ).toBe(false);
      }
    }
  });

  it('rejects stale baked modules, runner/helpers and harness evidence', () => {
    for (const field of [
      'moduleHashes',
      'runtimeHashes',
      'probeHashes',
    ] as const) {
      const { expected, native, setup } = evidence('opencode');
      const name = Object.keys(expected[field])[0];
      native[field] = { ...native[field], [name]: 'd'.repeat(64) };
      expect(evaluateImageEvidence(expected, native, setup).offlinePassed).toBe(
        false,
      );
      delete native[field][name];
      expect(evaluateImageEvidence(expected, native, setup).offlinePassed).toBe(
        false,
      );
    }
    const { expected, native, setup } = evidence('codex');
    expect(
      evaluateImageEvidence(
        expected,
        { ...native, runnerHash: 'e'.repeat(64) },
        setup,
      ).offlinePassed,
    ).toBe(false);
  });

  it('rejects duplicated, missing, failed and extra observations including setup failures', () => {
    const { expected, native, setup } = evidence('claude');
    for (const observations of [
      [
        ...native.nativeReport.observations,
        native.nativeReport.observations[0],
      ],
      native.nativeReport.observations.map((entry, index) =>
        index === 0 ? { ...entry, observedExpectedPrimitive: false } : entry,
      ),
      native.nativeReport.observations.map((entry, index) =>
        index === 0 ? { ...entry, mode: 'unknown-mode' } : entry,
      ),
    ]) {
      expect(
        evaluateImageEvidence(
          expected,
          {
            ...native,
            nativeReport: { ...native.nativeReport, observations },
          },
          setup,
        ).offlinePassed,
      ).toBe(false);
    }
    setup.nativeReport.observations.pop();
    expect(evaluateImageEvidence(expected, native, setup).offlinePassed).toBe(
      false,
    );
    expect(evaluateImageEvidence(expected, native, null).offlinePassed).toBe(
      false,
    );
  });
});
