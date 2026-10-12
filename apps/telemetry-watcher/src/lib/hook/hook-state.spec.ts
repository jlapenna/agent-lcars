import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isHookReported,
  markHookSessionDelivered,
  readHookSessionState,
  shouldShipEvent,
  writeHookSessionState,
} from './hook-state';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const tempState = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-state-'));
  dirs.push(dir);
  return dir;
};

describe('hook session state', () => {
  it('round-trips and rejects a file for another session', () => {
    const dir = tempState();
    writeHookSessionState(dir, {
      version: 1,
      sessionId: 's1',
      seq: 3,
      lastKind: 'tool',
      updatedAt: '2026-10-10T12:00:00.000Z',
    });
    expect(readHookSessionState(dir, 's1')).toMatchObject({
      seq: 3,
      lastKind: 'tool',
    });
    fs.renameSync(
      path.join(dir, 'hook-sessions/s1.json'),
      path.join(dir, 'hook-sessions/s2.json'),
    );
    expect(readHookSessionState(dir, 's2')).toBeUndefined();
  });

  it('throttles only tool events', () => {
    const state = {
      version: 1 as const,
      sessionId: 's',
      seq: 1,
      lastShippedAt: '2026-10-10T12:00:00.000Z',
      updatedAt: '2026-10-10T12:00:00.000Z',
    };
    expect(shouldShipEvent('tool', state, '2026-10-10T12:00:05.000Z')).toBe(
      false,
    );
    expect(shouldShipEvent('tool', state, '2026-10-10T12:00:15.000Z')).toBe(
      true,
    );
    expect(shouldShipEvent('stop', state, '2026-10-10T12:00:05.000Z')).toBe(
      true,
    );
    expect(shouldShipEvent('tool', undefined, '2026-10-10T12:00:05.000Z')).toBe(
      true,
    );
  });

  it('tells the daemon a session is hook-reported only after a real delivery, within the window', () => {
    const dir = tempState();
    writeHookSessionState(dir, {
      version: 1,
      sessionId: 's1',
      seq: 1,
      updatedAt: '2026-10-10T12:00:00.000Z',
    });
    // Spooled but never delivered (no token, console down): the daemon keeps the session.
    expect(isHookReported(dir, 's1', '2026-10-10T12:05:00.000Z')).toBe(false);
    markHookSessionDelivered(dir, 's1', '2026-10-10T12:00:00.000Z');
    expect(readHookSessionState(dir, 's1')).toMatchObject({
      seq: 1,
      lastDeliveredAt: '2026-10-10T12:00:00.000Z',
    });
    expect(isHookReported(dir, 's1', '2026-10-10T12:05:00.000Z')).toBe(true);
    expect(isHookReported(dir, 's1', '2026-10-10T12:11:00.000Z')).toBe(false);
    expect(isHookReported(dir, 's1', '2026-10-10T11:59:00.000Z')).toBe(false);
    expect(isHookReported(dir, 'unknown', '2026-10-10T12:05:00.000Z')).toBe(
      false,
    );
  });
});
