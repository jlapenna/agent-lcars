import { pathToFileURL } from 'node:url';

import {
  broker,
  classifyClaudeReadinessProbe,
  claudeReadiness,
  completionCallback,
  normalize,
  preflight,
  scanReconcile,
} from './controller-core';

export * from './controller-core';

/** CLI-only operation routing. Application behavior lives behind services. */
export async function runOperation(
  operation: string | undefined,
): Promise<void> {
  if (operation === 'normalize') await normalize();
  else if (operation === 'broker') await broker();
  else if (operation === 'preflight') await preflight();
  else if (operation === 'completion-callback') await completionCallback();
  else if (operation === 'reconcile') await scanReconcile();
  else if (operation === 'classify-claude-readiness')
    await classifyClaudeReadinessProbe();
  else if (operation === 'claude-readiness') await claudeReadiness();
  else throw new Error(`Unsupported dispatch broker operation: ${operation}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runOperation(process.argv[2]);
}
