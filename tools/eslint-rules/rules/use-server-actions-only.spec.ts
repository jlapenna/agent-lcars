import * as path from 'node:path';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { rule, RULE_NAME } from './use-server-actions-only';

const ruleId = 'repo/use-server-actions-only';
const workspaceRoot = '/workspace';
const linter = new Linter({ configType: 'flat', cwd: workspaceRoot });
const plugin = { rules: { [RULE_NAME]: rule as never } };

function lint(
  code: string,
  filename = 'apps/example/src/app/actions.ts',
): Linter.LintMessage[] {
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
    path.join(workspaceRoot, filename),
  );
}

describe('use-server-actions-only', () => {
  it('allows dedicated action modules with only async runtime exports', () => {
    expect(
      lint(`
        'use server';
        export type ActionResult = { ok: boolean };
        export interface ActionOptions { id: string }
        export async function saveAction() { return { ok: true }; }
        export const deleteAction = async () => undefined;
      `),
    ).toEqual([]);
  });

  it.each([
    'apps/example/src/app/page.tsx',
    'apps/example/src/app/layout.tsx',
    'apps/example/src/app/dashboard.tsx',
    'apps/example/src/lib/server.ts',
    'apps/example/src/app/save-action.test.ts',
  ])('rejects a file-level directive in %s', (filename) => {
    const messages = lint(
      "'use server';\nexport async function value() {}\n",
      filename,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'misplacedDirective',
      ruleId,
    });
  });

  it.each([
    'export function syncAction() {}',
    'export const syncAction = () => undefined;',
    'export const constant = 1;',
    'export class Action {}',
    "export { helper } from './helper';",
    "export * from './helper';",
    'export default function action() {}',
  ])('rejects a non-async runtime export: %s', (runtimeExport) => {
    const messages = lint(
      `'use server';\nexport async function validAction() {}\n${runtimeExport}\n`,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'asyncExportsOnly',
      ruleId,
    });
  });

  it('rejects an action module without a Server Function export', () => {
    const messages = lint("'use server';\nexport type Result = string;\n");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'noServerFunctions',
      ruleId,
    });
  });

  it.each([
    "import 'server-only';\nexport async function getData() {}\n",
    "export default async function Page() { async function save() { 'use server'; } return null; }\n",
    "'use client';\nexport function Button() { return null; }\n",
  ])('ignores modules without a file-level directive', (code) => {
    expect(lint(code, 'apps/example/src/app/page.tsx')).toEqual([]);
  });

  it('ignores a string after the directive prologue', () => {
    expect(
      lint(
        "import { helper } from './helper';\n'use server';\nexport const value = helper;\n",
        'apps/example/src/app/actions.ts',
      ),
    ).toEqual([]);
  });
});
