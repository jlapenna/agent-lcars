import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

function installedHeadlessShellExecutable() {
  // Use the registry that owns chromium.launch's revision and platform path.
  // Resolve through the installed package graph, including pnpm isolation.
  const require = createRequire(import.meta.url);
  const testRequire = createRequire(require.resolve('@playwright/test/cli'));
  const playwrightRequire = createRequire(
    testRequire.resolve('playwright/package.json'),
  );
  const { registry } = playwrightRequire('playwright-core/lib/coreBundle');
  return registry.registry
    .findExecutable('chromium-headless-shell')
    ?.executablePath();
}

export async function chromiumHeadlessShellReadiness({
  resolveExecutable = installedHeadlessShellExecutable,
} = {}) {
  let executablePath;
  try {
    executablePath = resolveExecutable();
    if (!executablePath || !path.isAbsolute(executablePath)) {
      return { ready: false, reason: 'runtime-location-unavailable' };
    }
  } catch {
    // A changed registry surface must fail closed after a Playwright upgrade.
    return { ready: false, reason: 'runtime-location-unavailable' };
  }

  try {
    if (!(await stat(executablePath)).isFile()) {
      return { ready: false, reason: 'executable-unavailable' };
    }
    await access(
      executablePath,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
  } catch {
    return { ready: false, reason: 'executable-unavailable' };
  }
  return { ready: true, executablePath };
}
