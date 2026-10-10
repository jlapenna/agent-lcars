#!/usr/bin/env bash
# Exercise the exact workflow shell with real curl against a bounded loopback
# HTTP fixture. Auth/Work API enforcement is covered at the actual router.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json, os, pathlib, subprocess, tempfile, textwrap, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

workflow = pathlib.Path('.github/workflows/work-create.yml').read_text()
script = textwrap.dedent(workflow.split('        run: |\n', 1)[1])
syntax = subprocess.run(['bash', '-n'], input=script, text=True, capture_output=True)
assert syntax.returncode == 0, syntax.stderr
for name, read_status, read_body, post_status, want_exit in [
    ('success', 200, {'revision': 7}, 200, 0),
    ('historical-revision-zero', 200, {'revision': 0}, 200, 0),
    ('stale', 200, {'revision': 7}, 409, 1),
    ('missing-schedule', 404, {'message': 'No such schedule'}, 200, 1),
    ('missing-revision', 200, {}, 200, 1),
    ('fractional-revision', 200, {'revision': 1.5}, 200, 1),
]:
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args): pass
        def reply(self, status, payload):
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
        def do_GET(self):
            calls.append(('GET', self.path, None))
            self.reply(read_status, read_body)
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
            calls.append(('POST', self.path, body))
            self.reply(post_status, {'enabled': False} if post_status == 200 else {'message': 'Schedule changed'})
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as directory:
            summary = pathlib.Path(directory) / 'summary'
            env = dict(os.environ, ACTION='schedule-disable', BEARER='fixture-not-a-credential',
                       CONSOLE_URL=f'http://127.0.0.1:{server.server_port}',
                       ITEM_ID='01J5Z3K9QX8F0N2B4V6C8D1E3G', GITHUB_STEP_SUMMARY=str(summary),
                       TMPDIR=directory)
            result = subprocess.run(['bash'], input=script, text=True, env=env, capture_output=True, timeout=10)
            assert result.returncode == want_exit, (name, result.stdout, result.stderr)
            prefix = '/api/work/v1/schedules/01J5Z3K9QX8F0N2B4V6C8D1E3G'
            assert calls[0] == ('GET', prefix, None), (name, calls)
            should_post = read_status == 200 and type(read_body.get('revision')) is int
            assert len(calls) == (2 if should_post else 1), (name, calls)
            if should_post:
                assert calls[1] == ('POST', prefix + '/disable', {'expectedRevision': read_body['revision']}), (name, calls)
            if want_exit:
                assert not summary.exists(), (name, summary.read_text())
                assert '::error::' in result.stdout, (name, result.stdout)
            else:
                assert 'schedule-disable' in summary.read_text(), name
            print('PASS', name)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
PY
