import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HindsightCodingAgents = async (input) => {
  if (
    process.env.HINDSIGHT_DISABLED === 'true' ||
    process.env.HINDSIGHT_DISABLED === '1'
  ) {
    return {};
  }
  const configPath =
    process.env.HINDSIGHT_CONFIG ||
    join(homedir(), '.hindsight', 'coding-agent.json');
  if (!existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    if (cfg.disabled) return {};
  } catch {
    return {};
  }
  const candidates = [
    join(homedir(), '.hindsight', 'coding-agents', 'dist', 'index.js'),
    '/home/runner/.hindsight/coding-agents/dist/index.js',
  ];
  const entry = candidates.find((p) => existsSync(p));
  if (!entry) return {};
  const mod = await import(pathToFileURL(entry).href);
  const plugin = mod.default ?? mod.HindsightCodingAgentsPlugin;
  return typeof plugin === 'function' ? plugin(input) : {};
};

export default HindsightCodingAgents;
