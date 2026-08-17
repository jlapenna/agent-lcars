import path from 'node:path';

import { loadESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');

/**
 * The RSC guardrail rules are registered in flat configs whose `files`
 * patterns resolve relative to the config file ESLint actually loads for
 * each linted file. ESLint v10 resolves the NEAREST config
 * (apps/console/eslint.config.mjs for console sources), so a root-config
 * block scoped `apps/console/src/**` silently never matches — exactly how
 * `use-server-actions-only` sat registered-but-inert from #77da253 until
 * the third-pass dead-code audit. This contract pins both rules to the
 * RESOLVED config of a real console source file, the same resolution the
 * lint target uses, so a config reshuffle that orphans either rule fails
 * here instead of passing vacuously.
 */
describe('console eslint guardrail rules', () => {
  // Resolving the flat config cold takes seconds (plugin graph + tsconfig
  // parsing), and over vitest's 5s default it flakes when the machine is
  // shared with other Nx tasks (observed locally: 5.6s under load).
  it(
    'resolves both RSC guardrail rules at error severity for console sources',
    { timeout: 60_000 },
    async () => {
      const FlatESLint = await loadESLint({ useFlatConfig: true });
      const eslint = new FlatESLint({ cwd: workspaceRoot });
      const config: {
        rules?: Record<string, unknown[]>;
      } = await eslint.calculateConfigForFile(
        path.join(workspaceRoot, 'apps/console/src/app/page.tsx'),
      );
      const severityOf = (rule: string) => {
        const entry = config.rules?.[rule];
        return Array.isArray(entry) ? entry[0] : entry;
      };
      // 2 is "error" in ESLint's normalized numeric severity.
      expect(
        severityOf('@nx/workspace-use-server-actions-only'),
        'use-server-actions-only must be active on console sources',
      ).toBe(2);
      expect(
        severityOf('@nx/workspace-no-server-only-imports-in-client'),
        'no-server-only-imports-in-client must be active on console sources',
      ).toBe(2);
    },
  );
});
