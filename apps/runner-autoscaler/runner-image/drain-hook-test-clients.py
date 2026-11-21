#!/usr/bin/env python3
"""Wait for this fixture's detached clients before deleting their scratch."""
import errno, os, pathlib, select, signal, sys, time

owned = {}
names = {}
empty_scans = 0

KNOWN_LABELS = {
    'bash': 'bash',
    'claude': 'claude',
    'codex': 'codex',
    'curl': 'curl',
    'dash': 'dash',
    'git': 'git',
    'git-http-fetch': 'git-http-fetch',
    'git-https': 'git-https',
    'git-remote-ftp': 'git-remote-ftp',
    'git-remote-ftps': 'git-remote-ftps',
    'git-remote-http': 'git-remote-http',
    'git-remote-https': 'git-remote-https',
    'jq': 'jq',
    'node': 'node',
    'node-MainThread': 'node',
    'nodejs': 'node',
    'opencode': 'opencode',
    'python': 'python3',
    'python3': 'python3',
    'sh': 'sh',
    'ssh': 'ssh',
    'timeout': 'timeout',
}

def parse_deadline_seconds():
    seconds = float(os.environ.get('HOOK_DRAIN_DEADLINE_SECONDS', '30'))
    if not (0 < seconds < float('inf')):
        raise ValueError('invalid drain deadline')
    return seconds

def classify_label(candidate):
    if not candidate:
        return None
    base = candidate.removesuffix(' (deleted)')
    if base in KNOWN_LABELS:
        return KNOWN_LABELS[base]
    if base.startswith('python3.') and base[8:].replace('.', '').isdigit():
        return 'python3'
    return None

def stat_snapshot(process):
    raw = (process / 'stat').read_text(encoding='utf-8', errors='replace')
    left = raw.find('(')
    right = raw.rfind(') ')
    if left < 0 or right < left:
        raise ValueError('malformed proc stat')
    return raw[right + 2 :].split()[19], raw[left + 1 : right]

def pidfd_alive(descriptor):
    try:
        signal.pidfd_send_signal(descriptor, 0)
        return True
    except OSError as error:
        return error.errno != errno.ESRCH

def snapshot_label(process, expected_ticks, descriptor, fallback='unknown'):
    try:
        exe_name = os.path.basename(os.readlink(process / 'exe'))
    except OSError:
        exe_name = None
    try:
        ticks, comm = stat_snapshot(process)
    except OSError:
        return fallback
    if ticks != expected_ticks or not pidfd_alive(descriptor):
        return fallback
    return classify_label(exe_name) or classify_label(comm) or fallback

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
                before, _ = stat_snapshot(process)
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
                    try:
                        exe_name = os.path.basename(os.readlink(process / 'exe'))
                    except OSError:
                        exe_name = None
                    try:
                        after_ticks, after_comm = stat_snapshot(process)
                    except OSError:
                        os.close(descriptor)
                        raise
                    if after_ticks != before:
                        os.close(descriptor)
                        raise RuntimeError('owned process identity changed')
                    owned[key] = descriptor
                    names[key] = (
                        (classify_label(exe_name) or classify_label(after_comm) or 'unknown')
                        if pidfd_alive(descriptor)
                        else 'unknown'
                    )
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
        resolved = {
            snapshot_label(
                pathlib.Path('/proc') / str(key[0]),
                key[1],
                descriptor,
                names.get(key, 'unknown'),
            )
            for key, descriptor in owned.items()
        }
        surviving = ','.join(sorted(resolved) or ['unknown'])
        suffix = f' processes={surviving}'
    print(f'hook smoke cleanup: process drainage refused; retaining private scratch; exception={category} errno={code} reason={reason}{suffix}', file=sys.stderr)
    if reason == 'deadline' and os.environ.get('HOOK_SMOKE_DEGRADE_DEADLINE') == '1':
        sys.exit(75)
    sys.exit(1)
finally:
    for descriptor in owned.values():
        os.close(descriptor)
