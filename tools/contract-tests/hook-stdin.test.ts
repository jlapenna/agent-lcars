import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

// Exercise the production reader through real OS pipes. Runtime plugins can
// hand the hook client a nonblocking descriptor before any bytes are ready.
// A synchronous read then returns EAGAIN, which used to discard a valid event.
const fixture = String.raw`
import json,os,select,subprocess,sys,threading,time
from pathlib import Path

payload='{"hook_event_name":"Stop","session_id":"owned-µ"}'.encode()
source=Path(sys.argv[2]).as_uri()
script=(
 'const {defaultHookCommandDependencies}=await import('+json.dumps(source)+');'
 'const deps=defaultHookCommandDependencies();'
 'process.stderr.write("reader-ready\\n");'
 'const text=await deps.readStdin();'
 'process.stdout.write(JSON.stringify({text}));'
)
reader,writer=os.pipe()
os.set_blocking(reader,sys.argv[3]!='nonblocking')
child=subprocess.Popen([sys.argv[1],'--import','tsx','--input-type=module','--eval',script],stdin=reader,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
os.close(reader)
ready=False
deadline=time.monotonic()+5
while time.monotonic()<deadline:
 if not select.select([child.stderr],[],[],max(0,deadline-time.monotonic()))[0]:break
 line=child.stderr.readline()
 if line==b'reader-ready\n':ready=True;break
 if not line:break
def send():
 try:
  time.sleep(.05)
  split=payload.index('µ'.encode())+1
  os.write(writer,payload[:split])
  time.sleep(.02)
  os.write(writer,payload[split:])
 except BrokenPipeError:pass
 finally:os.close(writer)
thread=threading.Thread(target=send)
thread.start()
try:
 if not ready:child.terminate()
 output,_=child.communicate(timeout=5)
 try:actual=json.loads(output)['text'].encode()
 except Exception:actual=b''
 print(json.dumps({'ready':ready,'exit':child.returncode,'payloadMatches':actual==payload}))
finally:
 if child.poll() is None:child.kill();child.communicate()
 thread.join()
`;

it.each(['blocking', 'nonblocking'])(
  'reads a complete hook payload arriving later on a %s pipe',
  (mode) => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        fixture,
        process.execPath,
        resolve('apps/telemetry-watcher/src/lib/hook/hook-command.ts'),
        mode,
      ],
      { encoding: 'utf8', timeout: 12_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // Only synthetic contract metadata is exposed on assertion failure.
    expect(JSON.parse(result.stdout)).toEqual({
      ready: true,
      exit: 0,
      payloadMatches: true,
    });
  },
  15_000,
);
