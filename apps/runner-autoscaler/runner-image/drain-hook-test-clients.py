#!/usr/bin/env python3
"""Wait for this fixture's detached clients before deleting their scratch."""
import errno, os, pathlib, select, sys, time

scratch = os.fsencode(sys.argv[1])
deadline = time.monotonic() + 30
owned = {}
empty_scans = 0

def start_ticks(process):
    return (process / 'stat').read_text().rsplit(') ', 1)[1].split()[19]

try:
    while True:
        for process in pathlib.Path('/proc').iterdir():
            if not process.name.isdigit():
                continue
            try:
                if process.stat().st_uid != os.getuid():
                    continue
                before = start_ticks(process)
                key = (int(process.name), before)
                # The pinned PIDFD already proves this exact process owner.
                # Its natural exit is observed below without another environment read.
                if key in owned:
                    continue
                environment = (process / 'environ').read_bytes().split(b'\0')
                if b'TMPDIR=' + scratch not in environment:
                    # A fork/exec transition can briefly expose an empty env.
                    # Its inherited private cwd still binds the startup owner.
                    if any(environment):
                        continue
                    cwd = os.fsencode(os.readlink(process / 'cwd'))
                    if cwd != scratch and not cwd.startswith(scratch + b'/'):
                        continue
                if key not in owned:
                    descriptor = os.pidfd_open(key[0])
                    if start_ticks(process) != before:
                        os.close(descriptor)
                        raise RuntimeError('owned process identity changed')
                    owned[key] = descriptor
            except OSError as error:
                if error.errno in (errno.EACCES, errno.EPERM):
                    # An unrelated protected process is not this test's owner.
                    # A process inside our scratch that cannot be checked is.
                    try:
                        cwd = os.fsencode(os.readlink(process / 'cwd'))
                    except OSError:
                        continue
                    if cwd == scratch or cwd.startswith(scratch + b'/'):
                        raise RuntimeError('owned process cannot be verified')
                    continue
                if error.errno not in (errno.ENOENT, errno.ESRCH):
                    raise
        for key, descriptor in list(owned.items()):
            if select.select([descriptor], [], [], 0)[0]:
                os.close(owned.pop(key))
        if not owned:
            empty_scans += 1
            if empty_scans >= 2:
                break
        else:
            empty_scans = 0
        if time.monotonic() >= deadline:
            raise RuntimeError('owned hook processes did not drain')
        time.sleep(0.05)
except Exception as error:
    # Only built-in categories and known numeric errnos are safe diagnostics.
    categories = {
        OSError: 'OSError', PermissionError: 'PermissionError',
        FileNotFoundError: 'FileNotFoundError', ProcessLookupError: 'ProcessLookupError',
        TimeoutError: 'TimeoutError', RuntimeError: 'RuntimeError',
        IndexError: 'IndexError', ValueError: 'ValueError',
        NotImplementedError: 'NotImplementedError',
    }
    category = categories.get(type(error), 'unknown')
    code = error.errno if isinstance(error, OSError) else None
    code = code if type(code) is int and code in errno.errorcode else 'none'
    reasons = {
        'owned process identity changed': 'identity-changed',
        'owned process cannot be verified': 'owner-unverifiable',
        'owned hook processes did not drain': 'deadline',
    }
    reason = reasons.get(str(error), 'other') if type(error) is RuntimeError else 'other'
    print(f'hook smoke cleanup: process drainage refused; retaining private scratch; exception={category} errno={code} reason={reason}', file=sys.stderr)
    sys.exit(1)
finally:
    for descriptor in owned.values():
        os.close(descriptor)
