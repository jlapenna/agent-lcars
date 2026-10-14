import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findCodexRollout } from './codex-rollout';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('findCodexRollout', () => {
  it('finds the rollout for a session id under the dated tree', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    dirs.push(home);
    const day = path.join(home, 'sessions', '2026', '10', '10');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, 'rollout-2026-10-10T17-14-11-abc.jsonl'),
      '',
    );
    fs.writeFileSync(
      path.join(day, 'rollout-2026-10-10T17-20-00-other.jsonl'),
      '',
    );
    expect(findCodexRollout(home, 'abc')).toBe(
      path.join(day, 'rollout-2026-10-10T17-14-11-abc.jsonl'),
    );
    expect(findCodexRollout(home, 'missing')).toBeUndefined();
    expect(findCodexRollout(path.join(home, 'nope'), 'abc')).toBeUndefined();
  });
});
