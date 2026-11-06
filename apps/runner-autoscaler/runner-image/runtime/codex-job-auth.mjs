// Recipe-scoped access to the same broker/lease/CAS protocol used by native
// Codex runs. No static secret copy, cloud credential or object selector.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function codexJobAuth({
  request,
  signal,
  environment,
  root = '/dev/shm',
}) {
  let restored;
  while (true) {
    signal.throwIfAborted();
    const response = await request('GET');
    if (response.status === 409) {
      // Shared subscription is occupied; the outer run keeps heartbeating.
      await delay(30000, undefined, { signal });
      continue;
    }
    if (!response.ok)
      throw new Error(
        `Codex credential restore refused (HTTP ${response.status})`,
      );
    restored = await response.json();
    break;
  }
  const home = await mkdtemp(join(root, 'lcars-recipe-codex-'));
  const file = join(home, 'auth.json');
  const bytes = Buffer.from(restored.authBase64 ?? '', 'base64');
  if (
    !/^[1-9][0-9]*$/.test(restored.generation) ||
    !/^[a-f0-9]{64}$/.test(restored.sha256) ||
    !bytes.length ||
    bytes.length > 131072 ||
    createHash('sha256').update(bytes).digest('hex') !== restored.sha256
  ) {
    await rm(home, { recursive: true, force: true });
    throw new Error('Invalid Codex credential restore');
  }
  await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  environment.CODEX_HOME = home;
  // This is execution configuration, not another credential binding. Existing
  // recipes continue using the shared tool's public command/report contract.
  environment.REPO_SKILL_EVALS_RUNNER = 'codex';
  let attempted = false;
  return {
    async persist() {
      if (attempted)
        throw new Error('Codex credential persistence already attempted');
      attempted = true;
      const current = await readFile(file);
      if (!current.length || current.length > 131072)
        throw new Error('Codex auth missing after recipe');
      const response = await request('PUT', {
        generation: restored.generation,
        restoredSha256: restored.sha256,
        authBase64: current.toString('base64'),
      });
      if (!response.ok)
        throw new Error(
          `Codex credential persistence refused (HTTP ${response.status})`,
        );
    },
    get persistenceAttempted() {
      return attempted;
    },
    async close() {
      delete environment.CODEX_HOME;
      delete environment.REPO_SKILL_EVALS_RUNNER;
      await rm(home, { recursive: true, force: true });
    },
  };
}
