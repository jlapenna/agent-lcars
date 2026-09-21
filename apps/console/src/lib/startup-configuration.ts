import 'server-only';

import {
  controlPlaneRepositories,
  validateDeploymentIdentity,
} from './deployment';
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
}
