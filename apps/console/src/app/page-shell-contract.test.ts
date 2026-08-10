import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_DIRECTORY = resolve(process.cwd(), 'src/app');
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
