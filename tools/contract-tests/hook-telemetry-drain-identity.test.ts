import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

// Execute the owning Python helper against a real process and a native
// /proc EACCES transition. The interleaving restores readable cwd before
// the helper handles the error, reproducing its live-owner refusal.
it('drains a previously verified PIDFD without re-reading its environment while refusing an unverified owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-drain-identity-'));
  try {
    const result = spawnSync(
      'python3',
      [
        '-c',
        String.raw`import pathlib,subprocess,os,json,time,sys,shutil,signal
p=pathlib.Path(sys.argv[2]);source=pathlib.Path(sys.argv[1]).read_text()
helper=source.split("<<'PY_DRAIN'\n",1)[1].split('\nPY_DRAIN',1)[0]
rows=[]
for mode in ['tracked','undiscovered']:
 root=p/mode;root.mkdir();scratch=root/'private';scratch.mkdir();control=root/'control';ready=root/'ready';denied=root/'denied';restored=root/'restored';done=root/'done';observed=root/'observed'
 child_script=r"""import ctypes,os,pathlib,sys,time
root=pathlib.Path(sys.argv[1]);c=ctypes.CDLL(None,use_errno=True);root.joinpath('ready').write_text('ready');deadline=time.monotonic()+1.2
while time.monotonic()<deadline:
 if root.joinpath('control').exists() and not root.joinpath('denied').exists():
  assert c.prctl(4,0,0,0,0)==0
  root.joinpath('denied').write_text('denied')
  limit=time.monotonic()+3
  while root.joinpath('control').read_text()!='restore' and time.monotonic()<limit:time.sleep(.001)
  assert c.prctl(4,1,0,0,0)==0
  root.joinpath('restored').write_text('restored')
 time.sleep(.001)
root.joinpath('done').write_text('done')
"""
 child=subprocess.Popen(['python3','-c',child_script,str(root)],cwd=scratch,env={**os.environ,'TMPDIR':str(scratch)},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 cleanup_fd=os.pidfd_open(child.pid)
 try:
  deadline=time.monotonic()+3
  while not ready.exists() and time.monotonic()<deadline:time.sleep(.001)
  assert ready.exists()
  prelude=f"""import pathlib,os,time,json,errno
original_read_bytes=pathlib.Path.read_bytes
target={child.pid}; mode={mode!r}; root=pathlib.Path({str(root)!r}); triggered=False
def controlled_read(self,*args,**kwargs):
 global triggered
 if str(self)==f'/proc/{{target}}/environ' and not triggered and (mode=='undiscovered' or any(key[0]==target for key in globals().get('owned',{{}}))):
  triggered=True;root.joinpath('control').write_text('deny');limit=time.monotonic()+3
  while not root.joinpath('denied').exists() and time.monotonic()<limit:time.sleep(.001)
  assert root.joinpath('denied').exists()
  try:return original_read_bytes(self,*args,**kwargs)
  except PermissionError as error:
   assert error.errno==errno.EACCES
   root.joinpath('control').write_text('restore');limit=time.monotonic()+3
   while not root.joinpath('restored').exists() and time.monotonic()<limit:time.sleep(.001)
   assert root.joinpath('restored').exists()
   root.joinpath('observed').write_text(json.dumps({{'nativeErrno':error.errno,'alreadyOwned':any(key[0]==target for key in globals().get('owned',{{}})),'cwdOwned':os.readlink(f'/proc/{{target}}/cwd')=={str(scratch)!r}}}))
   raise
 return original_read_bytes(self,*args,**kwargs)
pathlib.Path.read_bytes=controlled_read
"""
  st=time.monotonic();r=subprocess.run(['python3','-',str(scratch)],input=prelude+helper,capture_output=True,text=True,env={**os.environ,'TMPDIR':str(root)},timeout=40)
  done_at_drain_return=done.exists()
  child_exit=child.wait(timeout=4)
  rows.append({'mode':mode,'status':r.returncode,'signal':-r.returncode if r.returncode<0 else None,'childExit':child_exit,'done':done.exists(),'doneAtDrainReturn':done_at_drain_return,'refused':r.stderr.strip()=='hook smoke cleanup: process drainage refused; retaining private scratch; exception=RuntimeError errno=none reason=owner-unverifiable','nativeObservation':json.loads(observed.read_text())if observed.exists()else None})
 finally:
  try:
   child.wait(timeout=6)
  except subprocess.TimeoutExpired:
   signal.pidfd_send_signal(cleanup_fd,signal.SIGKILL)
   child.wait(timeout=3)
   raise RuntimeError('owned fixture did not exit naturally')
  finally:os.close(cleanup_fd)
 shutil.rmtree(root)
print(json.dumps(rows))
`,
        resolve('apps/runner-autoscaler/runner-image/hook-telemetry.test.sh'),
        root,
      ],
      {
        env: { ...process.env, TMPDIR: root },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    expect({
      status: result.status,
      signal: result.signal,
      spawnError: Boolean(result.error),
    }).toEqual({ status: 0, signal: null, spawnError: false });
    expect(JSON.parse(result.stdout)).toEqual([
      {
        mode: 'tracked',
        status: 0,
        signal: null,
        childExit: 0,
        done: true,
        doneAtDrainReturn: true,
        refused: false,
        nativeObservation: null,
      },
      {
        mode: 'undiscovered',
        status: 1,
        signal: null,
        childExit: 0,
        done: true,
        doneAtDrainReturn: false,
        refused: true,
        nativeObservation: {
          nativeErrno: 13,
          alreadyOwned: false,
          cwdOwned: true,
        },
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 100_000);
