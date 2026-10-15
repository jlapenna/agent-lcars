import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

// Execute the real smoke's missing-event branch with owned CLI fixtures. The
// production real-CLI gate remains separate and retains its original budgets.
it.each([
  { missingStop: false, pendingWriter: false, refuseDrain: false },
  { missingStop: true, pendingWriter: false, refuseDrain: false },
  { missingStop: false, pendingWriter: true, refuseDrain: false },
  { missingStop: false, pendingWriter: true, refuseDrain: true },
])(
  'preserves bounded private lifecycle evidence and cleanup (missing stop=$missingStop, pending writer=$pendingWriter, refused drain=$refuseDrain)',
  async ({ missingStop, pendingWriter, refuseDrain }) => {
    const root = mkdtempSync(join(tmpdir(), 'hook-smoke-evidence-'));
    const scratch = join(root, 'scratch');
    const lib = join(root, 'lib');
    const sdk = join(root, 'sdk');
    const bin = join(root, 'bin');
    const writerIdentity = join(root, 'writer-identity.json');
    const writerDone = join(root, 'writer-done');
    const transportEvidence = join(root, 'transport-evidence.json');
    const drainEvidence = join(root, 'drain-evidence.json');
    const foreign = join(root, 'unrelated-home');
    mkdirSync(foreign);
    const unrelated = pendingWriter
      ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: foreign,
          env: { ...process.env, TMPDIR: foreign },
          stdio: 'ignore',
        })
      : undefined;
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
}
if(process.argv.slice(2).join(' ')==='hook opencode') {
process.stdout.write(JSON.stringify({writerConfigured:Boolean(process.env.LCARS_TELEMETRY_CREDENTIALS_FILE)}));
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
const kinds=command==='claude'?['start','stop','end']:command==='codex'?['start','stop','end']:['start','prompt',...${missingStop ? '[]' : "['stop']"}];
for(const kind of kinds)fs.appendFileSync(path.join(dir,'events.ndjson'),JSON.stringify({
version:1,agent,kind,sessionId:'owned-session',summary:{sessionId:'owned-session'},
runner:{runId:'hook-test-run',issueNumber:7,repo:{owner:'hook-test',name:'repo'}}})+'\\n');
if(command==='claude'){
const settings=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude/settings.json')));
for(const entry of settings.hooks.SessionEnd)for(const hook of entry.hooks)fs.writeFileSync(hook.command.slice(6),'');
}
if(command==='opencode'){
const inspection=require('node:child_process').spawnSync('lcars',['hook','opencode'],{env:process.env,encoding:'utf8'});
fs.writeFileSync(${JSON.stringify(transportEvidence)},JSON.stringify({
pluginEnabled:Boolean(process.env.LCARS_TELEMETRY_CREDENTIALS_FILE),
clientExit:inspection.status,writerConfigured:JSON.parse(inspection.stdout).writerConfigured}));
if(${pendingWriter}){
const launcher=fs.readFileSync(path.join(process.env.PATH.split(':')[0],'lcars'),'utf8');
const runtimeLib=launcher.match(/exec node (.+)\\/lcars-session-title\\.cjs/)[1];
const child=require('node:child_process').spawn(process.execPath,['-e',
${JSON.stringify(`const fs=require('node:fs');setTimeout(()=>{
fs.writeFileSync(process.argv[1]+'/delayed-output','owned test output');
fs.writeFileSync(${JSON.stringify(writerDone)},'finished');
},${refuseDrain ? 60_000 : 1200});`)},runtimeLib],{detached:true,stdio:'ignore',env:process.env});
const start=fs.readFileSync('/proc/'+child.pid+'/stat','utf8').split(') ')[1].split(' ')[19];
fs.writeFileSync(${JSON.stringify(writerIdentity)},JSON.stringify({pid:child.pid,start,lib:runtimeLib}));
child.unref();
}
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
    let smoke = resolve(
      'apps/runner-autoscaler/runner-image/hook-telemetry.test.sh',
    );
    let fixtureHome = root;
    if (missingStop || refuseDrain) {
      // Execute the actual wrapper: ordinary failures remove drained bundles,
      // while a refused drain retains bundles with its writer still live.
      const project = join(root, 'project');
      fixtureHome = join(root, 'home');
      const sourceSdk = join(fixtureHome, '.config/opencode');
      const targets = [
        'tools',
        'apps/runner-autoscaler/runner-image',
        'agents/opencode',
        'dist/apps/telemetry-watcher-session-title-cli',
        'dist/apps/telemetry-watcher-hook-flush',
      ];
      for (const target of targets)
        mkdirSync(join(project, target), { recursive: true });
      mkdirSync(join(sourceSdk, 'node_modules'), { recursive: true });
      for (const file of ['package.json', 'package-lock.json'])
        writeFileSync(join(sourceSdk, file), '{}');
      writeFileSync(join(project, 'agents/opencode/lcars-telemetry.js'), '{}');
      writeFileSync(
        join(
          project,
          'dist/apps/telemetry-watcher-session-title-cli/lcars-session-title.cjs',
        ),
        readFileSync(join(lib, 'lcars-session-title.cjs')),
      );
      writeFileSync(
        join(
          project,
          'dist/apps/telemetry-watcher-hook-flush/lcars-hook-flush.cjs',
        ),
        '',
      );
      writeFileSync(join(project, 'tools/nx'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
      for (const file of [
        'tools/hook-telemetry-runtime-smoke.sh',
        'apps/runner-autoscaler/runner-image/hook-telemetry.test.sh',
      ])
        writeFileSync(join(project, file), readFileSync(resolve(file)));
      if (refuseDrain)
        // Run the actual helper. Refuse only after it owns a real PIDFD, then
        // observe its finally block closing that descriptor without raw errors.
        writeFileSync(
          join(bin, 'python3'),
          `#!/usr/bin/env node
const fs=require('node:fs'),child=require('node:child_process');
const prelude=${JSON.stringify(`import atexit, errno, json, os, pathlib, select
original_select = select.select
observed = []
def refuse_owned(readers, writers, errors, timeout=None):
    if readers:
        observed.extend(readers)
        raise OSError(errno.EIO, 'private-drain-detail private-credential')
    return original_select(readers, writers, errors, timeout)
def record_closed():
    closed = []
    for descriptor in observed:
        try:
            os.fstat(descriptor)
            closed.append(False)
        except OSError as error:
            closed.append(error.errno == errno.EBADF)
    pathlib.Path(${JSON.stringify(drainEvidence)}).write_text(json.dumps({
        'ownedPidfdCount': len(observed), 'allClosed': bool(closed) and all(closed)}))
select.select = refuse_owned
atexit.register(record_closed)
`)};
const result=child.spawnSync('python3',process.argv.slice(2),{
input:prelude+fs.readFileSync(0,'utf8'),encoding:'utf8',
env:{...process.env,PATH:process.env.PATH.split(':').slice(1).join(':')}});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
process.exit(result.status??1);
`,
          { mode: 0o755 },
        );
      smoke = join(project, 'tools/hook-telemetry-runtime-smoke.sh');
    }
    try {
      const result = spawnSync('bash', [smoke], {
        env: {
          ...process.env,
          HOME: fixtureHome,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: scratch,
          HOOK_TEST_LIB_DIR: lib,
          HOOK_TEST_OPENCODE_CONFIG_DIR: sdk,
          CLAUDE_BIN: join(bin, 'claude'),
          CODEX_BIN: join(bin, 'codex'),
          OPENCODE_BIN: join(bin, 'opencode'),
        },
        encoding: 'utf8',
        timeout: 100_000,
      });
      const spawnError = Boolean(result.error);
      const line = result.stderr
        .split('\n')
        .find((value) => value.startsWith('hook smoke lifecycle: '));
      const evidence = line
        ? JSON.parse(line.slice('hook smoke lifecycle: '.length))
        : undefined;
      const lifecycle = evidence
        ? {
            agent: evidence.agent,
            cliExit: evidence.cliExit,
            outputCategories: { error: evidence.outputCategories?.error },
          }
        : undefined;
      const provider = evidence?.provider ?? [];
      const response = provider.find(
        (value: {
          route: string;
          stage: string;
          status: number;
          completed: boolean;
        }) =>
          value.route === '/v1/chat/completions' &&
          value.stage === 'response' &&
          value.status === 200 &&
          value.completed === true,
      );
      const identity = existsSync(writerIdentity)
        ? JSON.parse(readFileSync(writerIdentity, 'utf8'))
        : undefined;
      const transport = existsSync(transportEvidence)
        ? JSON.parse(readFileSync(transportEvidence, 'utf8'))
        : undefined;
      expect(transport).toEqual({
        pluginEnabled: true,
        clientExit: 0,
        writerConfigured: false,
      });
      let writerLive = false;
      if (identity) {
        try {
          process.kill(identity.pid, 0);
          writerLive = true;
        } catch {
          /* Already exited naturally. */
        }
      }
      const drainDiagnostic = result.stderr.match(
        /^hook smoke cleanup: process drainage refused; retaining private scratch; exception=(OSError|PermissionError|FileNotFoundError|ProcessLookupError|TimeoutError|RuntimeError|IndexError|ValueError|NotImplementedError|unknown) errno=(none|[0-9]{1,3})$/m,
      );
      const classification = result.stderr.includes(
        'hook smoke cleanup: process drainage refused; retaining private scratch',
      )
        ? 'drain-refused'
        : result.stderr.includes('session is missing hook events: stop')
          ? 'missing-hook-events'
          : result.status === 0
            ? 'none'
            : 'unclassified';
      // Assertion failures show only bounded categories, never child output.
      expect({
        status: result.status,
        signal: result.signal ? (constants.signals[result.signal] ?? -1) : null,
        spawnError,
        classification,
        exception: drainDiagnostic?.[1] ?? null,
        errno:
          drainDiagnostic && drainDiagnostic[2] !== 'none'
            ? Number(drainDiagnostic[2])
            : null,
      }).toEqual({
        status: missingStop || refuseDrain ? 1 : 0,
        signal: null,
        spawnError: false,
        classification: refuseDrain
          ? 'drain-refused'
          : missingStop
            ? 'missing-hook-events'
            : 'none',
        exception: refuseDrain ? 'OSError' : null,
        errno: refuseDrain ? constants.errno.EIO : null,
      });
      const drainage = existsSync(drainEvidence)
        ? JSON.parse(readFileSync(drainEvidence, 'utf8'))
        : undefined;
      expect(drainage).toEqual(
        refuseDrain ? { ownedPidfdCount: 1, allClosed: true } : undefined,
      );
      expect(
        result.stderr.includes('session is missing hook events: stop'),
      ).toBe(missingStop);
      expect(Boolean(line)).toBe(missingStop);
      expect(lifecycle).toEqual(
        missingStop
          ? { agent: 'opencode', cliExit: 0, outputCategories: { error: 1 } }
          : undefined,
      );
      expect((evidence?.outputBytes ?? 0) > 0).toBe(missingStop);
      expect(typeof evidence?.inspectedBytes === 'number').toBe(missingStop);
      expect(evidence?.inspectedBytes ?? 0).toBeLessThanOrEqual(65536);
      expect(Array.isArray(evidence?.provider)).toBe(missingStop);
      expect(response).toEqual(
        missingStop
          ? {
              route: '/v1/chat/completions',
              stage: 'response',
              status: 200,
              completed: true,
            }
          : undefined,
      );
      expect(provider.length).toBeLessThanOrEqual(64);
      expect(result.stdout.includes('ok: opencode start,prompt,stop')).toBe(
        !missingStop,
      );
      expect(existsSync(writerDone)).toBe(pendingWriter && !refuseDrain);
      expect(refuseDrain && existsSync(identity?.lib ?? '')).toBe(refuseDrain);
      expect(result.stderr.includes('retaining private bundles')).toBe(
        refuseDrain,
      );
      expect(refuseDrain && writerLive).toBe(refuseDrain);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(Boolean(unrelated)).toBe(pendingWriter);
      expect(unrelated?.exitCode ?? null).toBeNull();
      expect(unrelated?.signalCode ?? null).toBeNull();
      for (const privateValue of [
        'private-query',
        'private-credential',
        'private-request-body',
        'private-model-body',
        'private-error-detail',
        'private-drain-detail',
      ])
        expect((result.stdout + result.stderr).includes(privateValue)).toBe(
          false,
        );
      expect(readdirSync(scratch).length === 0).toBe(!refuseDrain);
    } finally {
      let ownedCleanupStatus = 0;
      // The old-cleanup control must not leave its deliberately delayed writer.
      if (existsSync(writerIdentity)) {
        const cleanup = spawnSync(
          'python3',
          [
            '-c',
            `import json,os,pathlib,select,signal,sys
x=json.loads(pathlib.Path(sys.argv[1]).read_text());p=pathlib.Path('/proc')/str(x['pid'])
try:
 before=p.joinpath('stat').read_text().rsplit(') ',1)[1].split()[19]
 if before==x['start']:
  fd=os.pidfd_open(x['pid'])
  try:
   if p.joinpath('stat').read_text().rsplit(') ',1)[1].split()[19]==before:
    signal.pidfd_send_signal(fd,signal.SIGKILL)
    select.select([fd],[],[],2)
  finally:os.close(fd)
except ProcessLookupError:pass
except FileNotFoundError:pass`,
            writerIdentity,
          ],
          { encoding: 'utf8' },
        );
        ownedCleanupStatus = cleanup.status ?? 1;
      }
      if (
        unrelated &&
        unrelated.exitCode === null &&
        unrelated.signalCode === null
      ) {
        const exited = once(unrelated, 'exit');
        unrelated.kill();
        await exited;
      }
      expect(ownedCleanupStatus).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  },
  110_000,
);
