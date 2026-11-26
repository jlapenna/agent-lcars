import { AGENT_BOT_LOGINS } from '@agent-lcars/dispatch-contracts';

/** Associations whose holders have been granted access to the repository.
 * Anyone can review or comment on a public repository; these cannot. */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

const FLEET_BOTS: ReadonlySet<string> = new Set(
  AGENT_BOT_LOGINS.map((login) => login.toLowerCase()),
);

/**
 * Whether a GitHub actor may cause LCARS to act or notify: a fleet bot, or an
 * author association of OWNER, MEMBER or COLLABORATOR. The fleet App's own
 * reviews and comments arrive as `NONE`, so the bots are named explicitly.
 * Used for approvals that wake the auto-merge sweep and for every GitHub
 * agent event (`github-agent-events.ts`).
 */
export function isTrustedGitHubActor(actor: {
  login?: string;
  association?: string;
}): boolean {
  return (
    (actor.login !== undefined && FLEET_BOTS.has(actor.login.toLowerCase())) ||
    TRUSTED_ASSOCIATIONS.has(actor.association ?? '')
  );
}
