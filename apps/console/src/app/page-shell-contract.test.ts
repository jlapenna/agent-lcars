import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Anchor to this file's own location rather than process.cwd() so the test
// passes whether vitest runs from the workspace root or from apps/console.
// Note: the global `URL` constructor is jsdom's shim in this project's
// jsdom test environment and mis-resolves `new URL('.', import.meta.url)`
// for file: URLs, so fileURLToPath() is applied directly to the string
// import.meta.url (Node's own implementation) rather than to a `URL`
// instance built from it.
const APP_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const LOGIN_PAGE = 'login/page.tsx';

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === 'page.tsx' ? [path] : [];
  });
}

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('console page-shell contract', () => {
  it('requires every authenticated page to use the shared server shell', () => {
    const pages = pageFiles(APP_DIRECTORY);

    for (const page of pages) {
      if (relative(APP_DIRECTORY, page) === LOGIN_PAGE) continue;

      const pageSource = source(page);
      expect(pageSource).toContain('ConsoleAppShell');
      expect(pageSource).not.toContain('ConsolePageShell');
      expect(pageSource).not.toContain('ConsoleNavRail');
    }
  });

  it('keeps the non-route states in the same shell and leaves login explicit', () => {
    for (const file of ['error.tsx', 'loading.tsx', 'not-found.tsx']) {
      expect(source(join(APP_DIRECTORY, file))).toContain('ConsoleAppShell');
    }

    expect(source(join(APP_DIRECTORY, LOGIN_PAGE))).not.toContain(
      'ConsoleAppShell',
    );
  });

  it('keeps the shell server-rendered', () => {
    expect(source(join(APP_DIRECTORY, 'console-app-shell.tsx'))).not.toContain(
      "'use client'",
    );
  });
});
