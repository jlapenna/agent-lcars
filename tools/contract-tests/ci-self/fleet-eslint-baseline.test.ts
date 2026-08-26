import path from 'node:path';

import {
  FLEET_RESTRICTED_SYNTAX,
  FLEET_UNUSED_VARS_OPTIONS,
} from '@jlapenna/repo-tools/eslint';
import { loadESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The fleet ESLint baseline (#1340 C4) is a shared definition, and a shared
 * definition that nothing resolves to is worse than a duplicated one: it
 * looks enforced everywhere while enforcing nothing.
 *
 * ESLint v10 resolves the NEAREST flat config for a linted file, so a
 * nested `eslint.config.mjs` that forgets to spread the root config, or a
 * root block whose `files` glob stops matching, silently drops the baseline
 * for a whole subtree - the same failure mode `console-eslint-guardrails`
 * pins for the RSC rules, and the reason `use-server-actions-only` once sat
 * registered-but-inert for months.
 *
 * So this asserts against the RESOLVED config of real source files in each
 * kind of location (root tooling, an app under a nested config, a lib under
 * a nested config), comparing to the exported constants rather than
 * restating them - a message reworded in the baseline cannot drift from
 * what the repo actually enforces.
 */

const workspaceRoot = path.resolve(import.meta.dirname, '../../..');

// One file per config-resolution neighbourhood: the root, the console app
// (its own nested config), and a lib (another nested config).
const SAMPLES = [
  'tools/contract-tests/fleet-eslint-baseline.test.ts',
  'apps/console/src/lib/agent-activity.ts',
  'libs/dispatch-contracts/src/pipelines.ts',
];

async function resolvedRules(
  relativePath: string,
): Promise<Record<string, unknown[]>> {
  const FlatESLint = await loadESLint({ useFlatConfig: true });
  const eslint = new FlatESLint({ cwd: workspaceRoot });
  const config: { rules?: Record<string, unknown[]> } =
    await eslint.calculateConfigForFile(path.join(workspaceRoot, relativePath));
  return config.rules ?? {};
}

describe('fleet ESLint baseline is what the repo actually resolves', () => {
  it.each(SAMPLES)(
    '%s resolves the fleet restricted-syntax set exactly',
    { timeout: 60_000 },
    async (sample) => {
      const rules = await resolvedRules(sample);

      expect(rules['no-restricted-syntax']).toEqual([
        2,
        ...FLEET_RESTRICTED_SYNTAX,
      ]);
    },
  );

  it.each(SAMPLES)(
    '%s resolves import-order and unused-symbol hygiene at error',
    { timeout: 60_000 },
    async (sample) => {
      const rules = await resolvedRules(sample);

      expect(rules['simple-import-sort/imports']).toEqual([2]);
      expect(rules['simple-import-sort/exports']).toEqual([2]);
      expect(rules['unused-imports/no-unused-imports']).toEqual([2]);
      expect(rules['unused-imports/no-unused-vars']).toEqual([
        2,
        FLEET_UNUSED_VARS_OPTIONS,
      ]);
    },
  );

  it('bans dynamic import(), the shape agent-lcars used to miss entirely', async () => {
    const rules = await resolvedRules(SAMPLES[1]);
    const selectors = (
      rules['no-restricted-syntax'].slice(1) as { selector: string }[]
    ).map((entry) => entry.selector);

    expect(selectors).toContain('ImportExpression');
  });

  it('bans all three toLocale*String evasion shapes, not just the bare call', async () => {
    const rules = await resolvedRules(SAMPLES[1]);
    const toLocaleSelectors = (
      rules['no-restricted-syntax'].slice(1) as { selector: string }[]
    ).filter((entry) => entry.selector.includes('toLocale'));

    // Bare call, explicit `undefined` locale, empty-array locale list.
    expect(toLocaleSelectors).toHaveLength(3);
  });

  it('leaves .cjs alone: require() is its only import mechanism', async () => {
    const rules = await resolvedRules(
      'packages/fleet-tools/bin/fleet-identity.cjs',
    );

    // ESLint keeps the options a later block turned off, so assert the
    // severity rather than the whole entry.
    expect(rules['no-restricted-syntax'][0]).toBe(0);
  });
});
