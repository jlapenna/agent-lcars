import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  it('requires every page to inherit the shared shell through the HOC', () => {
    const pages = pageFiles(APP_DIRECTORY);

    for (const page of pages) {
      const pageSource = source(page);
      expect(pageSource).toContain('withConsolePageShell');
      expect(pageSource).not.toContain('ConsoleAppShell');
      expect(pageSource).not.toMatch(/from ['"][^'"]*\/console-page-shell['"]/);
      expect(pageSource).not.toContain('ConsoleNavRail');
    }
  });

  it('keeps every non-route state in the same higher-order shell', () => {
    for (const file of ['error.tsx', 'loading.tsx', 'not-found.tsx']) {
      const fileSource = source(join(APP_DIRECTORY, file));
      expect(fileSource).toContain('withConsolePageShell');
      expect(fileSource).not.toContain('ConsoleAppShell');
    }
  });

  it('keeps the shell and higher-order wrapper server-renderable', () => {
    expect(source(join(APP_DIRECTORY, 'console-app-shell.tsx'))).not.toContain(
      "'use client'",
    );
    expect(
      source(join(APP_DIRECTORY, 'with-console-page-shell.tsx')),
    ).not.toContain("'use client'");
  });
});
