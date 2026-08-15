import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  readCodexNativeTitles,
  titlesFromCodexNativeThreadRows,
} from './codex-native-title-source';

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'codex-native-threads.json'),
    'utf8',
  ),
) as unknown[];

describe('Codex native title source', () => {
  it('uses the fixture-frozen state rows and deterministically prefers the newest update', () => {
    expect(
      titlesFromCodexNativeThreadRows([
        ...fixture,
        {
          id: 'equal-update-title',
          title: 'Alpha title',
          updated_at_ms: 1786788777806,
        },
        {
          id: 'equal-update-title',
          title: 'Zulu title',
          updated_at_ms: 1786788777806,
        },
      ]),
    ).toEqual(
      new Map([
        ['codex-session-native-title', 'Explicit native Codex title'],
        ['codex-session-older-title', 'Later native title'],
        ['equal-update-title', 'Zulu title'],
      ]),
    );
  });

  it('drops malformed, blank, oversized, and unsafe state entries', () => {
    expect(
      titlesFromCodexNativeThreadRows([
        { id: '../outside', title: 'must not join' },
        { id: 'blank-title', title: ' \n ' },
        { id: 'oversized-title', title: 'x'.repeat(81) },
        { id: 'missing-title' },
        { id: 'wrong-title-type', title: { text: 'not a title' } },
        { id: 'valid-title', title: '  Valid title  ' },
      ]),
    ).toEqual(new Map([['valid-title', 'Valid title']]));
  });

  it('fails soft when its local state reader is unavailable', () => {
    expect(
      readCodexNativeTitles({
        databasePath: '/missing/state.sqlite',
        readRows: () => {
          throw new Error('state unavailable');
        },
      }),
    ).toEqual(new Map());
  });
});
