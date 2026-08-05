import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';

import { createRule, RULE_NAME } from './no-server-only-imports-in-client';

function createFixture(): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rsc-boundary-'));
  fs.mkdirSync(path.join(workspaceRoot, 'libs/server/src/client'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(workspaceRoot, 'libs/mixed/src/server'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(workspaceRoot, 'apps/web/src/lib'), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(workspaceRoot, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: {
        paths: {
          '@repo/server': ['libs/server/src/index.ts'],
          '@repo/server/client': ['libs/server/src/client/index.ts'],
          '@repo/mixed/server': ['libs/mixed/src/server/index.ts'],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'libs/server/project.json'),
    JSON.stringify({ name: '@repo/server', tags: ['platform:server'] }),
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'libs/server/src/index.ts'),
    'export const secret = true;\n',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'libs/server/src/client/index.ts'),
    'export const safe = true;\n',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'libs/mixed/project.json'),
    JSON.stringify({ name: '@repo/mixed', tags: ['platform:shared'] }),
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'libs/mixed/src/server/index.ts'),
    "import { assertNotBrowser } from '@repo/util';\nassertNotBrowser();\n",
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'apps/web/src/lib/secret.ts'),
    "import 'server-only';\nexport const localSecret = true;\n",
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'apps/web/src/lib/safe-comment.ts'),
    '// This file deliberately does not call assertNotBrowser().\nexport const safe = true;\n',
  );

  return workspaceRoot;
}

const workspaceRoot = createFixture();
const filename = path.join(workspaceRoot, 'apps/web/src/client.tsx');
const ruleId = 'repo/no-server-only-imports-in-client';
const linter = new Linter({ configType: 'flat', cwd: workspaceRoot });
const plugin = {
  rules: {
    [RULE_NAME]: createRule(workspaceRoot) as never,
  },
};

function lint(code: string): Linter.LintMessage[] {
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        plugins: { repo: plugin },
        rules: { [ruleId]: 'error' },
      },
    ],
    filename,
  );
}

afterAll(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('no-server-only-imports-in-client', () => {
  it.each([
    '@repo/server',
    '@repo/server/private',
    '@repo/mixed/server',
    './lib/secret',
    'server-only',
  ])('rejects the server-only value import %s', (source) => {
    const messages = lint(
      "'use client';\nimport { value } from '" + source + "';\n",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      ruleId,
      messageId: 'serverOnlyImport',
    });
  });

  it.each([
    "'use client';\nexport { secret } from '@repo/server';\n",
    "'use client';\nexport * from './lib/secret';\n",
    "'use client';\nvoid import('@repo/server');\n",
  ])('rejects server-only re-exports and dynamic imports', (code) => {
    expect(lint(code)).toHaveLength(1);
  });

  it.each([
    "'use client';\nimport type { Secret } from '@repo/server';\n",
    "'use client';\nexport type { Secret } from '@repo/server';\n",
    "'use client';\nexport { type Secret } from '@repo/server';\n",
    "'use client';\nimport { safe } from '@repo/server/client';\n",
    "'use client';\nimport { safe } from './lib/safe-comment';\n",
    "import { secret } from '@repo/server';\n",
  ])('allows safe module-graph usage', (code) => {
    expect(lint(code)).toEqual([]);
  });
});
