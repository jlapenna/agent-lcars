// A recipe admitted under a Claude-harness profile runs its provider tools on
// the Claude CLI. The executor projects the subscription token as a read-only
// file only into that worker; it is never part of the Pod spec or a job secret.
import { readFile } from 'node:fs/promises';

export async function claudeJobAuth({
  environment,
  tokenFile = '/run/secrets/claude-code-oauth-token',
}) {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token || token.length > 4096 || /\s/u.test(token))
    throw new Error('Invalid Claude credential for recipe');
  environment.CLAUDE_CODE_OAUTH_TOKEN = token;
  // Execution configuration for the shared evaluator, not a credential.
  environment.REPO_SKILL_EVALS_RUNNER = 'claude';
  return {
    close() {
      delete environment.CLAUDE_CODE_OAUTH_TOKEN;
      delete environment.REPO_SKILL_EVALS_RUNNER;
    },
  };
}
