import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isHindsightEnabled() {
  if (
    process.env.HINDSIGHT_DISABLED === 'true' ||
    process.env.HINDSIGHT_DISABLED === '1'
  ) {
    return false;
  }
  const configPath =
    process.env.HINDSIGHT_CONFIG ||
    join(homedir(), '.hindsight', 'coding-agent.json');
  if (!existsSync(configPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    return !cfg.disabled;
  } catch {
    return false;
  }
}

export const HindsightCodingAgents = async (input) => {
  if (!isHindsightEnabled()) return {};
  const candidates = [
    join(homedir(), '.hindsight', 'coding-agents', 'dist', 'index.js'),
    '/home/runner/.hindsight/coding-agents/dist/index.js',
  ];
  const entry = candidates.find((p) => existsSync(p));
  if (!entry) return {};
  // eslint-disable-next-line no-restricted-syntax -- runtime-conditional load from ~/.hindsight when enabled; absent in disabled environments.
  const mod = await import(pathToFileURL(entry).href);
  const plugin = mod.default ?? mod.HindsightCodingAgentsPlugin;
  return typeof plugin === 'function' ? plugin(input) : {};
};

export default HindsightCodingAgents;
