import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverAcrossRoots, discoverTranscriptFiles } from './discover';
import { WatchRootConfig } from './watch-roots';

describe('discoverTranscriptFiles', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lcars-telemetry-watcher-'));
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

describe('discoverAcrossRoots', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-lcars-telemetry-watcher-root-a-'),
    );
    rootB = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-lcars-telemetry-watcher-root-b-'),
    );
  });

  afterEach(() => {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it('discovers files from multiple roots independently, tagging each with its own root', () => {
    fs.mkdirSync(path.join(rootA, '-home-jlapenna-p-members'));
    fs.writeFileSync(
      path.join(rootA, '-home-jlapenna-p-members', 'session-a.jsonl'),
      '',
    );
    fs.mkdirSync(path.join(rootB, 'any-project-dir'));
    fs.writeFileSync(
      path.join(rootB, 'any-project-dir', 'session-b.jsonl'),
      '',
    );

    const claudeRoot: WatchRootConfig = {
      path: rootA,
      adapter: 'claude-code',
      projectDirAllowlist: ['-home-jlapenna-p-members*'],
    };
    const codexRoot: WatchRootConfig = {
      path: rootB,
      adapter: 'codex',
    };

    const discovered = discoverAcrossRoots([claudeRoot, codexRoot]);

    expect(discovered).toEqual([
      {
        file: path.join(rootA, '-home-jlapenna-p-members', 'session-a.jsonl'),
        root: claudeRoot,
      },
      {
        file: path.join(rootB, 'any-project-dir', 'session-b.jsonl'),
        root: codexRoot,
      },
    ]);
  });

  it("applies each root's own allowlist independently (a dir allowed under one root can be rejected under another)", () => {
    fs.mkdirSync(path.join(rootA, 'allowed-here'));
    fs.writeFileSync(path.join(rootA, 'allowed-here', 'session-x.jsonl'), '');
    fs.mkdirSync(path.join(rootB, 'allowed-here'));
    fs.writeFileSync(path.join(rootB, 'allowed-here', 'session-y.jsonl'), '');

    const permissiveRoot: WatchRootConfig = {
      path: rootA,
      adapter: 'claude-code',
      projectDirAllowlist: ['allowed-here'],
    };
    const restrictiveRoot: WatchRootConfig = {
      path: rootB,
      adapter: 'claude-code',
      projectDirAllowlist: ['not-this-one'],
    };

    const discovered = discoverAcrossRoots([permissiveRoot, restrictiveRoot]);

    expect(discovered.map((d) => d.file)).toEqual([
      path.join(rootA, 'allowed-here', 'session-x.jsonl'),
    ]);
  });

  it('treats an omitted projectDirAllowlist as unfiltered (matches every project dir)', () => {
    fs.mkdirSync(path.join(rootA, 'totally-unscoped-dir-name'));
    fs.writeFileSync(
      path.join(rootA, 'totally-unscoped-dir-name', 'session-z.jsonl'),
      '',
    );

    const noAllowlistRoot: WatchRootConfig = {
      path: rootA,
      adapter: 'claude-code',
    };

    const discovered = discoverAcrossRoots([noAllowlistRoot]);

    expect(discovered.map((d) => d.file)).toEqual([
      path.join(rootA, 'totally-unscoped-dir-name', 'session-z.jsonl'),
    ]);
  });

  it('returns an empty list for an empty watchRoots array', () => {
    expect(discoverAcrossRoots([])).toEqual([]);
  });

  it('recursively discovers Codex date-partitioned rollout files', () => {
    const dateDir = path.join(rootA, '2026', '07', '20');
    fs.mkdirSync(dateDir, { recursive: true });
    fs.writeFileSync(path.join(dateDir, 'rollout-session.jsonl'), '');

    expect(
      discoverAcrossRoots([
        { path: rootA, adapter: 'codex', recursive: true },
      ]).map((entry) => entry.file),
    ).toEqual([path.join(dateDir, 'rollout-session.jsonl')]);
  });

  it("passes each root's own path and resolved allowlist to the injected discover function", () => {
    const calls: Array<{ rootPath: string; allowlist: string[] }> = [];
    const roots: WatchRootConfig[] = [
      { path: rootA, adapter: 'claude-code', projectDirAllowlist: ['a-*'] },
      { path: rootB, adapter: 'codex' },
    ];

    discoverAcrossRoots(roots, (rootPath, allowlist) => {
      calls.push({ rootPath, allowlist });
      return [];
    });

    expect(calls).toEqual([
      { rootPath: rootA, allowlist: ['a-*'] },
      { rootPath: rootB, allowlist: ['*'] },
    ]);
  });
});
