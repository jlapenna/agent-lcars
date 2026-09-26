import 'server-only';

import { required } from '@agent-lcars/util-server';

import {
  controlPlaneRepositories,
  validateDeploymentIdentity,
} from './deployment';
import { createDispatchTokenProvider } from './github-app-tokens';
import { validateOutcomeWebhooks } from './outcome-webhook';
import { parseWorkGrants } from './work-grants';

/**
 * Every static deployment-configuration check, run once at process start by
 * `instrumentation.ts`'s `register()`. These values are fixed for the life of
 * a revision, so a bad one is a deploy defect: it must fail the boot with a
 * message naming the variable (#1731), not surface on whichever webhook,
 * Work API call, or outcome drain first touches it (#2033).
 *
 * The request paths keep their own parsing, because it also enforces the
 * values; what moves here is the discovery of a broken configuration.
 */
export function validateStartupConfiguration(): void {
  validateDeploymentIdentity();
  // Also parses AGENT_LCARS_WATCHED_REPOS and requires the two to match.
  controlPlaneRepositories();
  parseWorkGrants(process.env['AGENT_LCARS_WORK_GRANTS']);
  validateOutcomeWebhooks();

  for (const name of [
    'AGENT_LCARS_APP_CLIENT_ID',
    'AGENT_LCARS_APP_PRIVATE_KEY',
    'AGENT_LCARS_WEBHOOK_SECRET',
    'PROJECT_ID',
    'AGENT_LCARS_WEBHOOK_QUEUE',
    'AGENT_LCARS_WEBHOOK_QUEUE_LOCATION',
    'AUTH_URL',
    'QUICK_TASK_EVIDENCE_BUCKET',
    'AGENT_LCARS_WORK_AUDIENCE',
  ] as const) {
    if (!required(name).trim()) {
      throw new Error(`${name} must not be blank`);
    }
  }

  try {
    const authUrl = new URL(required('AUTH_URL'));
    if (!['http:', 'https:'].includes(authUrl.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('AUTH_URL must be an absolute HTTP(S) URL');
  }

  // Construction parses the key without minting a token or making a network
  // request. Drains still rebuild their own provider to observe key rotation.
  try {
    createDispatchTokenProvider(process.env);
  } catch {
    throw new Error(
      'AGENT_LCARS_APP_PRIVATE_KEY must be a valid PEM private key',
    );
  }
}
