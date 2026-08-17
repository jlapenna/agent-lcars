#!/usr/bin/env node

/**
 * The GitHub account the agent fleet claims work as.
 *
 * This is the single source of truth for node-side local tooling. Three
 * layers carry this identity and they must agree:
 *
 *   - CI/dispatch reads the `AGENT_FLEET_LOGIN` repo variable.
 *   - The console reads `AGENT_LCARS_FLEET_GITHUB_LOGIN`
 *     (apps/console/src/lib/deployment.ts's `agentFleetLogin()`).
 *   - Local tooling reads this module.
 *
 * A local pre-commit/Codex hook cannot see a GitHub repo variable, which is
 * why this default exists at all rather than the hook simply reading the
 * variable. Honour the same env name so a dispatch that does export it stays
 * consistent with CI instead of silently disagreeing with it.
 */
const DEFAULT_FLEET_LOGIN = 'agent-lcars-bot';

function fleetLogin() {
  const override = process.env.AGENT_FLEET_LOGIN;
  return typeof override === 'string' && override.trim()
    ? override.trim()
    : DEFAULT_FLEET_LOGIN;
}

module.exports = { DEFAULT_FLEET_LOGIN, fleetLogin };
