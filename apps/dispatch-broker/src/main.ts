import { pathToFileURL } from 'node:url';

import {
  classifyClaudeReadinessProbe,
  claudeReadiness,
  completionCallback,
  preflight,
} from './controller-core';

export * from './controller-core';

/** CLI-only operation routing. Application behavior lives behind services. */
export async function runOperation(
  operation: string | undefined,
): Promise<void> {
  if (operation === 'preflight') await preflight();
  else if (operation === 'completion-callback') await completionCallback();
  else if (
    operation === 'normalize' ||
    operation === 'broker' ||
    operation === 'reconcile'
  ) {
    throw new Error(
      `The Actions ${operation} operation was retired with agent-router.yml; use the hosted control-plane controller instead.`,
    );
  } else if (operation === 'classify-claude-readiness')
    await classifyClaudeReadinessProbe();
  else if (operation === 'claude-readiness') await claudeReadiness();
  else throw new Error(`Unsupported dispatch broker operation: ${operation}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runOperation(process.argv[2]);
}
