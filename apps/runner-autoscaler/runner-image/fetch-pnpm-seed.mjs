// Fetch on the builder CPU while preserving the target's optional packages.
import { spawnSync } from 'node:child_process';

const [architecture, store = '/pnpm-store', cache = '/pnpm-cache'] =
  process.argv.slice(2);
const targetCPU = { amd64: 'x64', arm64: 'arm64' }[architecture];

try {
  if (!targetCPU)
    throw new Error(`unsupported seed target architecture: ${architecture}`);
  const config = spawnSync(
    'pnpm',
    ['config', 'get', 'supportedArchitectures.cpu', '--json'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024,
    },
  );
  if (config.error || config.status !== 0)
    throw new Error('could not read pnpm supportedArchitectures.cpu');
  const raw = config.stdout.trim();
  const configured = raw === '' || raw === 'undefined' ? null : JSON.parse(raw);
  const cpus = configured ?? ['current'];
  if (
    !Array.isArray(cpus) ||
    cpus.some((cpu) => typeof cpu !== 'string' || !cpu)
  ) {
    throw new Error(
      'pnpm supportedArchitectures.cpu must be an array of nonempty strings',
    );
  }
  // An explicit empty array must remain empty: no CLI override preserves it.
  const flags = [
    ...new Set(cpus.map((cpu) => (cpu === 'current' ? targetCPU : cpu))),
  ].map((cpu) => `--cpu=${cpu}`);
  const result = spawnSync(
    'pnpm',
    [
      'fetch',
      '--frozen-lockfile',
      '--ignore-scripts',
      ...flags,
      '--config.minimum-release-age=0',
      '--store-dir',
      store,
      '--config.cache-dir=' + cache,
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`pnpm seed fetch: ${error.message}`);
  process.exitCode = 1;
}
