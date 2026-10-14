import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

// Execute the real smoke's missing-event branch with owned CLI fixtures. The
// production real-CLI gate remains separate and retains its original budgets.
it.each([false, true])(
  'preserves bounded private lifecycle evidence and cleanup (missing stop=%s)',
  (missingStop) => {
    const root = mkdtempSync(join(tmpdir(), 'hook-smoke-evidence-'));
    const scratch = join(root, 'scratch');
    const lib = join(root, 'lib');
    const sdk = join(root, 'sdk');
    const bin = join(root, 'bin');
    for (const directory of [scratch, lib, sdk, bin, join(sdk, 'node_modules')])
      mkdirSync(directory, { recursive: true });
    for (const file of [
      'lcars-telemetry.js',
      'package.json',
      'package-lock.json',
    ])
      writeFileSync(join(sdk, file), '{}');
    writeFileSync(
      join(lib, 'lcars-session-title.cjs'),
      `const fs=require('node:fs'),path=require('node:path');
if(process.argv.slice(2).join(' ')==='integration install claude') {
const dir=path.join(process.env.HOME,'.claude');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({hooks:{SessionEnd:[]}}));
}`,
    );
    const fixture = join(bin, 'fixture.cjs');
    writeFileSync(
      fixture,
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const command=path.basename(process.argv[1]);
const agent=command==='claude'?'claude-code':command;
const dir=path.join(process.env.HOME,'.local/state/agent-lcars/spool');
fs.mkdirSync(dir,{recursive:true});
const kinds=command==='claude'?['start','stop','end']:command==='codex'?['start','end']:['start','prompt',...${missingStop ? '[]' : "['stop']"}];
for(const kind of kinds)fs.appendFileSync(path.join(dir,'events.ndjson'),JSON.stringify({
version:1,agent,kind,sessionId:'owned-session',summary:{sessionId:'owned-session'},
runner:{runId:'hook-test-run',issueNumber:7,repo:{owner:'hook-test',name:'repo'}}})+'\\n');
if(command==='claude'){
const settings=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude/settings.json')));
for(const entry of settings.hooks.SessionEnd)for(const hook of entry.hooks)fs.writeFileSync(hook.command.slice(6),'');
}
if(command==='opencode'){
const config=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.config/opencode/opencode.json')));
const url=config.provider['hook-test'].options.baseURL+'/chat/completions?private-query';
const request=http.request(url,{method:'POST',headers:{authorization:'private-credential'}},response=>{
response.resume();response.on('end',()=>console.log('private-model-body Error: private-error-detail'));
});request.end('private-request-body');
}
`,
      { mode: 0o755 },
    );
    for (const command of ['claude', 'codex', 'opencode'])
      symlinkSync(fixture, join(bin, command));
    try {
      const result = spawnSync(
        'bash',
        [resolve('apps/runner-autoscaler/runner-image/hook-telemetry.test.sh')],
        {
          env: {
            ...process.env,
            TMPDIR: scratch,
            HOOK_TEST_LIB_DIR: lib,
            HOOK_TEST_OPENCODE_CONFIG_DIR: sdk,
            CLAUDE_BIN: join(bin, 'claude'),
            CODEX_BIN: join(bin, 'codex'),
            OPENCODE_BIN: join(bin, 'opencode'),
          },
          encoding: 'utf8',
          timeout: 100_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(missingStop ? 1 : 0);
      if (missingStop) {
        expect(result.stderr).toContain('session is missing hook events: stop');
        const line = result.stderr
          .split('\n')
          .find((value) => value.startsWith('hook smoke lifecycle: '));
        expect(line).toBeDefined();
        const evidence = JSON.parse(
          line!.slice('hook smoke lifecycle: '.length),
        );
        expect(evidence).toMatchObject({
          agent: 'opencode',
          cliExit: 0,
          outputCategories: { error: 1 },
        });
        expect(evidence.outputBytes).toBeGreaterThan(0);
        expect(evidence.inspectedBytes).toBeLessThanOrEqual(65536);
        expect(evidence.provider).toContainEqual({
          route: '/v1/chat/completions',
          stage: 'response',
          status: 200,
          completed: true,
        });
        expect(evidence.provider.length).toBeLessThanOrEqual(64);
      } else {
        expect(result.stdout).toContain('ok: opencode start,prompt,stop');
        expect(result.stderr).not.toContain('hook smoke lifecycle:');
      }
      for (const privateValue of [
        'private-query',
        'private-credential',
        'private-request-body',
        'private-model-body',
        'private-error-detail',
      ])
        expect(result.stdout + result.stderr).not.toContain(privateValue);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  110_000,
);
