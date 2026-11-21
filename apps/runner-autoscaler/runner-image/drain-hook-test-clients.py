#!/usr/bin/env python3
"""Wait for this fixture's detached clients before deleting their scratch."""
import errno, os, pathlib, select, sys, time

owned = {}
names = {}
empty_scans = 0

def parse_deadline_seconds():
    seconds = float(os.environ.get('HOOK_DRAIN_DEADLINE_SECONDS', '30'))
    if not (0 < seconds < float('inf')):
        raise ValueError('invalid drain deadline')
    return seconds

def start_ticks(process):
    return (process / 'stat').read_text().rsplit(') ', 1)[1].split()[19]

def comm_name(process, fallback='unknown'):
    try:
        raw = (process / 'comm').read_text(encoding='utf-8', errors='replace').strip()
    except OSError:
        return fallback
    if not raw:
        return fallback
    return ''.join(
        ch if ('A' <= ch <= 'Z' or 'a' <= ch <= 'z' or '0' <= ch <= '9' or ch in '._-') else '?'
        for ch in raw[:16]
    )

try:
    scratch = os.fsencode(sys.argv[1])
    deadline = time.monotonic() + parse_deadline_seconds()
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
                    names[key] = comm_name(process)
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
                names.pop(key, None)
        if not owned:
            empty_scans += 1
            if empty_scans >= 2:
                break
        else:
            empty_scans = 0
        if owned and time.monotonic() >= deadline:
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
    suffix = ''
    if reason == 'deadline':
        resolved = set()
        for key in owned:
            fallback = names.get(key, 'unknown')
            process = pathlib.Path('/proc') / str(key[0])
            try:
                current = comm_name(process, fallback) if start_ticks(process) == key[1] else fallback
            except OSError:
                current = fallback
            resolved.add(current)
        surviving = ','.join(sorted(resolved) or ['unknown'])
        suffix = f' processes={surviving}'
    print(f'hook smoke cleanup: process drainage refused; retaining private scratch; exception={category} errno={code} reason={reason}{suffix}', file=sys.stderr)
    if reason == 'deadline' and os.environ.get('HOOK_SMOKE_DEGRADE_DEADLINE') == '1':
        sys.exit(75)
    sys.exit(1)
finally:
    for descriptor in owned.values():
        os.close(descriptor)
