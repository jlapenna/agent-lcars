import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { discoverSessionArtifacts } from './discover-artifacts';

describe('discoverSessionArtifacts', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-telemetry-share-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists files under the session share dir, sorted', () => {
    fs.mkdirSync(path.join(root, 'session-a'));
    fs.writeFileSync(path.join(root, 'session-a', 'report.md'), '');
    fs.writeFileSync(path.join(root, 'session-a', 'chart.png'), '');

    expect(discoverSessionArtifacts(root, 'session-a')).toEqual([
      'chart.png',
      'report.md',
    ]);
  });

  it('ignores subdirectories', () => {
    fs.mkdirSync(path.join(root, 'session-a', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'session-a', 'report.md'), '');

    expect(discoverSessionArtifacts(root, 'session-a')).toEqual(['report.md']);
  });

  it('fails soft when the session has no share dir', () => {
    expect(discoverSessionArtifacts(root, 'no-such-session')).toEqual([]);
  });
});
