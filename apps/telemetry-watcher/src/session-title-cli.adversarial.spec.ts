import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

interface ProjectConfig {
  targets: Record<string, { options?: Record<string, unknown> }>;
}

const workspaceRoot = path.resolve(__dirname, '../../..');

describe('standalone session-title CLI build boundary', () => {
  it('has its own emitted file and entrypoint, without routing through watcher main', () => {
    const project = JSON.parse(
      fs.readFileSync(
        path.join(workspaceRoot, 'apps/telemetry-watcher/project.json'),
        'utf8',
      ),
    ) as ProjectConfig;
    const target = project.targets['session-title-cli'];
    expect(target?.options).toMatchObject({
      outputPath: 'dist/apps/telemetry-watcher-session-title-cli',
      outputFileName: 'lcars-session-title.cjs',
      main: 'apps/telemetry-watcher/src/session-title-cli.ts',
    });
    expect(target?.options?.main).not.toBe(
      'apps/telemetry-watcher/src/main.ts',
    );
    const outputPath = path.resolve(
      workspaceRoot,
      String(target?.options?.outputPath),
    );
    const artifact = path.join(
      outputPath,
      String(target?.options?.outputFileName),
    );
    const artifactIsValid =
      !fs.existsSync(artifact) || fs.statSync(artifact).isFile();
    expect(artifactIsValid).toBe(true);
    expect(outputPath).not.toBe(
      path.resolve(workspaceRoot, 'dist/apps/telemetry-watcher'),
    );

    const cli = fs.readFileSync(
      path.join(
        workspaceRoot,
        'apps/telemetry-watcher/src/session-title-cli.ts',
      ),
      'utf8',
    );
    expect(cli).toContain('./lib/session-title-annotation-command');
    expect(cli).not.toContain("from './main'");
    expect(cli).not.toContain('WatcherDaemon');
  });
});
