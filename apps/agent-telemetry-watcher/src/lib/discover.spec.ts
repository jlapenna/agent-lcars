import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { discoverTranscriptFiles } from './discover';

describe('discoverTranscriptFiles', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-telemetry-watcher-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds .jsonl files only under allowlisted project dirs', () => {
    fs.mkdirSync(path.join(root, '-home-jlapenna-p-members'));
    fs.writeFileSync(
      path.join(root, '-home-jlapenna-p-members', 'session-1.jsonl'),
      '',
    );
    fs.mkdirSync(path.join(root, '-home-jlapenna-p-homelab'));
    fs.writeFileSync(
      path.join(root, '-home-jlapenna-p-homelab', 'session-2.jsonl'),
      '',
    );

    const files = discoverTranscriptFiles(root, ['-home-jlapenna-p-members*']);

    expect(files).toEqual([
      path.join(root, '-home-jlapenna-p-members', 'session-1.jsonl'),
    ]);
  });

  it('ignores non-.jsonl files', () => {
    fs.mkdirSync(path.join(root, '-home-jlapenna-p-members'));
    fs.writeFileSync(
      path.join(root, '-home-jlapenna-p-members', 'session-1.jsonl'),
      '',
    );
    fs.writeFileSync(
      path.join(root, '-home-jlapenna-p-members', 'notes.txt'),
      '',
    );

    const files = discoverTranscriptFiles(root, ['-home-jlapenna-p-members*']);

    expect(files).toEqual([
      path.join(root, '-home-jlapenna-p-members', 'session-1.jsonl'),
    ]);
  });

  it('fails soft when the root dir does not exist', () => {
    expect(discoverTranscriptFiles(path.join(root, 'missing'), ['*'])).toEqual(
      [],
    );
  });
});
