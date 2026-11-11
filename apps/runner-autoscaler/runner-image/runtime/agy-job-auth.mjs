// A recipe admitted under an Antigravity-harness profile runs its provider
// tools on the agy CLI. The executor projects the OAuth token as a read-only
// file only into that worker. agy keeps its login in a native application
// directory and rotates it in place, so the token is copied into a private,
// worker-owned directory (as direct-runner.sh does for agy runs) and removed
// when the recipe ends. It is never part of the Pod spec or a job secret.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;

export async function agyJobAuth({
  environment,
  model,
  tokenFile = '/run/secrets/antigravity-oauth-token',
  root = tmpdir(),
}) {
  if (typeof model !== 'string' || !MODEL.test(model))
    throw new Error('Antigravity recipe profile requires a providerModel');
  const token = await readFile(tokenFile, 'utf8');
  if (!token.trim() || token.length > 65536)
    throw new Error('Invalid Antigravity credential for recipe');
  const home = await mkdtemp(join(root, 'lcars-agy-'));
  try {
    await chmod(home, 0o700);
    const app = join(home, 'antigravity-cli');
    await mkdir(app, { mode: 0o700 });
    await writeFile(join(app, 'antigravity-oauth-token'), token, {
      mode: 0o600,
      flag: 'wx',
    });
    environment.REPO_EVAL_ANTIGRAVITY_AUTH_DIR = app;
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  // Execution configuration for the shared evaluator, not credentials.
  environment.REPO_SKILL_EVALS_RUNNER = 'antigravity';
  environment.REPO_SKILL_EVALS_MODEL = model;
  // The OAuth login is billed by subscription quota and Antigravity reports no
  // USD usage, so the recipe's --max-cost-usd cannot be enforced; an exhausted
  // quota still settles as provider-limit.
  environment.REPO_SKILL_EVALS_QUOTA_BILLED = '1';
  return {
    async close() {
      delete environment.REPO_EVAL_ANTIGRAVITY_AUTH_DIR;
      delete environment.REPO_SKILL_EVALS_RUNNER;
      delete environment.REPO_SKILL_EVALS_MODEL;
      delete environment.REPO_SKILL_EVALS_QUOTA_BILLED;
      await rm(home, { recursive: true, force: true });
    },
  };
}
