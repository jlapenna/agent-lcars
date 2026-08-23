import { describe, expect, it } from 'vitest';

import {
  readSessionStatusOverlay,
  readSessionTitleOverlay,
} from './session-title-annotation-source';

describe('session annotation overlays', () => {
  it('reads only transcript-discovered session files without enumerating history', () => {
    const files = new Map([
      [
        '/state/session-metadata/current.json',
        JSON.stringify({
          version: 1,
          sessionId: 'current',
          updatedAt: '2026-08-23T00:00:00.000Z',
          title: 'Current work',
        }),
      ],
      [
        '/state/session-status/current.json',
        JSON.stringify({
          version: 1,
          sessionId: 'current',
          updatedAt: '2026-08-23T00:00:00.000Z',
          status: 'Testing',
        }),
      ],
    ]);
    const dependencies = {
      readDirectory: () => {
        throw new Error('directory enumeration is not allowed');
      },
      readFile: (filePath: string) => files.get(filePath),
      joinPath: (...parts: string[]) => parts.join('/'),
    };

    expect(
      readSessionTitleOverlay('/state', ['current'], dependencies).declared
        .annotations,
    ).toEqual(
      new Map([
        ['current', expect.objectContaining({ title: 'Current work' })],
      ]),
    );
    expect(
      readSessionStatusOverlay('/state', ['current'], dependencies).annotations,
    ).toEqual(
      new Map([['current', expect.objectContaining({ status: 'Testing' })]]),
    );
  });
});
