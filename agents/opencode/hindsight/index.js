import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import v1, { isHindsightEnabled } from './v1.js';

export const HindsightOpencode2Wrapper = {
  id: 'hindsight-coding-agents',
  server: v1,
  async setup(ctx) {
    if (!isHindsightEnabled()) return undefined;
    const candidates = [
      join(homedir(), '.hindsight', 'coding-agents', 'index.js'),
      '/home/runner/.hindsight/coding-agents/index.js',
    ];
    const entry = candidates.find((p) => existsSync(p));
    if (!entry) return undefined;
    // eslint-disable-next-line no-restricted-syntax -- runtime-conditional load from ~/.hindsight when enabled; absent in disabled environments.
    const mod = await import(pathToFileURL(entry).href);
    const plugin = mod.default ?? mod.HindsightOpencode2Plugin;
    return typeof plugin?.setup === 'function' ? plugin.setup(ctx) : undefined;
  },
};

export default HindsightOpencode2Wrapper;
