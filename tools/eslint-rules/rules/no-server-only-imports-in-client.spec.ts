import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';

import { createRule, RULE_NAME } from './no-server-only-imports-in-client';

function writeFixture(
  workspaceRoot: string,
  relativePath: string,
  contents: string | object,
): void {
  const filePath = path.join(workspaceRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
}

function createFixture(): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rsc-boundary-'));

  writeFixture(workspaceRoot, 'tsconfig.base.json', {
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@repo/server': ['packages/nested/server/src/index.ts'],
        '@repo/server/client': ['packages/nested/server/src/client/index.ts'],
        '@repo/server/*': ['packages/nested/server/src/*'],
        '@repo/strict': ['packages/strict/src/index.ts'],
        '@repo/mixed': ['packages/mixed/src/index.ts'],
        '@repo/mixed/browser': ['packages/mixed/src/browser/index.ts'],
        '@repo/mixed/server': ['packages/mixed/src/server/index.ts'],
        '@repo/inferred': ['packages/inferred/src/index.ts'],
        '@repo/missing': ['packages/missing/src/index.ts'],
      },
    },
  });

  // Nested outside libs/*: a project.json-only project must still be found.
  writeFixture(workspaceRoot, 'packages/nested/server/project.json', {
    name: '@repo/server',
    sourceRoot: 'packages/nested/server/src',
    tags: ['platform:server'],
  });
  writeFixture(
    workspaceRoot,
    'packages/nested/server/src/index.ts',
    'export const secret = true;\n',
  );
  writeFixture(
    workspaceRoot,
    'packages/nested/server/src/private.ts',
    'export const privateValue = true;\n',
  );
  writeFixture(
    workspaceRoot,
    'packages/nested/server/src/client/index.ts',
    'export const safe = true;\n',
  );
  writeFixture(
    workspaceRoot,
    'packages/nested/server/src/client/poison.ts',
    "import 'server-only';\nexport const poisoned = true;\n",
  );

  // A safe-looking name alone must not make a subpath browser-safe.
  writeFixture(workspaceRoot, 'packages/strict/project.json', {
    name: '@repo/strict',
    sourceRoot: 'packages/strict/src',
    tags: ['platform:server'],
  });
  writeFixture(
    workspaceRoot,
    'packages/strict/src/index.ts',
    'export const strictSecret = true;\n',
  );
  writeFixture(
    workspaceRoot,
    'packages/strict/src/client/index.ts',
    'export const looksSafeButIsNotAnEntrypoint = true;\n',
  );

  // A package.json-only project mirrors Nx's package-based inferred project.
  writeFixture(workspaceRoot, 'packages/inferred/package.json', {
    name: '@repo/inferred',
    nx: { tags: ['platform:server'] },
  });
  writeFixture(
    workspaceRoot,
    'packages/inferred/src/index.ts',
    'export const inferredSecret = true;\n',
  );

  writeFixture(workspaceRoot, 'packages/mixed/project.json', {
    name: '@repo/mixed',
    sourceRoot: 'packages/mixed/src',
    tags: ['platform:shared'],
  });
  writeFixture(
    workspaceRoot,
    'packages/mixed/src/index.ts',
    'export const shared = true;\n',
  );
  writeFixture(
    workspaceRoot,
    'packages/mixed/src/browser/index.ts',
    'export const browserSafe = true;\n',
  );
  writeFixture(
    workspaceRoot,
    'packages/mixed/src/server/index.ts',
    "export * from './node';\n",
  );
  writeFixture(
    workspaceRoot,
    'packages/mixed/src/server/node.ts',
    "import 'server-only';\nexport const nodeOnly = true;\n",
  );

  // A tsconfig-only root exercises the graph-cycle-safe fallback for an
  // inferred app project and its app-owned alias.
  writeFixture(workspaceRoot, 'apps/web/tsconfig.json', {
    compilerOptions: {
      paths: {
        '@web/server': ['./src/lib/secret.ts'],
      },
    },
  });
  writeFixture(
    workspaceRoot,
    'apps/web/src/lib/secret.ts',
    "import 'server-only';\nexport const localSecret = true;\n",
  );
  writeFixture(
    workspaceRoot,
    'apps/web/src/lib/safe-comment.ts',
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
  it('fails rule construction when workspace configuration cannot be parsed', () => {
    const malformedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rsc-boundary-malformed-'),
    );
    try {
      writeFixture(malformedRoot, 'tsconfig.base.json', '{ not-json }');
      expect(() => createRule(malformedRoot)).toThrow(
        /Unable to parse workspace configuration/u,
      );
    } finally {
      fs.rmSync(malformedRoot, { recursive: true, force: true });
    }
  });

  it.each([
    '@repo/server',
    '@repo/server/private',
    '@repo/server/client/poison',
    '@repo/strict/client',
    '@repo/mixed',
    '@repo/mixed/server',
    '@repo/inferred',
    '@web/server',
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

  it.each(['@repo/missing', '@repo/server/client/missing'])(
    'fails closed when the workspace target for %s cannot be resolved',
    (source) => {
      const messages = lint(
        "'use client';\nimport { value } from '" + source + "';\n",
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        ruleId,
        messageId: 'configurationError',
      });
      expect(messages[0]?.message).toContain('cannot be resolved');
    },
  );

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
    "'use client';\nimport { safe } from '@repo/mixed/browser';\n",
    "'use client';\nimport { safe } from './lib/safe-comment';\n",
    "'use client';\nimport React from 'react';\n",
    "'use client';\nimport { client } from '@third-party/server/client';\n",
    "import { secret } from '@repo/server';\n",
  ])('allows safe module-graph usage', (code) => {
    expect(lint(code)).toEqual([]);
  });
});
