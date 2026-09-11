"""Regression coverage for the operator's current direct-runner evidence CLI."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('run-evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTest(unittest.TestCase):
    def test_filter_and_retained_exit_never_exec_stopped_container(self):
        calls = []
        def run(endpoint, args, config):
            calls.append(args)
            if args[1] == 'ps':
                return 'live\nstopped\nother\notherrepo\n'
            if args[1] == 'inspect':
                cid = args[-1]
                run_id = {'other': 'jlapenna/agent-lcars#1902/r1',
                          'otherrepo': 'someone/else#1901/r1'}.get(cid, 'jlapenna/agent-lcars#1901/r2')
                return json.dumps([cid, 'exited' if cid == 'stopped' else 'running',
                                   22 if cid == 'stopped' else 0, run_id, 'start', 'finish'])
            return '    worktree=/tmp/task commits=2 dirty=3\n'
        output = io.StringIO()
        with patch.object(evidence, 'host_command', side_effect=run), contextlib.redirect_stdout(output):
            count = evidence.probe_host('pike', 'local', {'selector': '1901', 'repo': 'jlapenna/agent-lcars'})
        self.assertEqual(count, (2, 0))
        self.assertIn('state=exited exit=22', output.getvalue())
        self.assertIn('commits=2 dirty=3', output.getvalue())
        self.assertEqual([a[2] for a in calls if a[1] == 'exec'], ['live'])
        self.assertNotIn('1902', output.getvalue())
        self.assertNotIn('someone/else', output.getvalue())

    def test_container_inspection_failure_is_not_a_successful_empty_scan(self):
        with patch.object(evidence, 'host_command', side_effect=['vanished\n', evidence.ProbeError('inspect failed')]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(evidence.probe_host('pike', 'local', {}), (0, 1))

    def test_full_run_and_anchor_selectors(self):
        run = 'work:01ABC/r2'
        self.assertTrue(evidence.matches(run, 'work:01ABC'))
        self.assertTrue(evidence.matches(run, run))
        self.assertFalse(evidence.matches(run, 'work:01ABC/r1'))
        self.assertFalse(evidence.matches('repo#19010/r1', '1901'))

    def test_unavailable_host_keeps_other_evidence_and_returns_failure(self):
        output = io.StringIO()
        with patch.object(evidence, 'hosts', return_value=[('down', 'local'), ('up', 'local')]), \
             patch.object(evidence, 'probe_host', side_effect=[evidence.ProbeError('timed out'), (1, 0)]), \
             contextlib.redirect_stdout(output):
            self.assertEqual(evidence.probe({}), 1)
        self.assertIn('[down] unavailable: timed out', output.getvalue())
        self.assertIn('Matching direct runners: 1; incomplete probes: 1', output.getvalue())

    def test_worktree_probe_reports_edits_outside_clean_primary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'checkout'
            work = Path(directory) / 'task with spaces'
            def git(*args, cwd=root):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null',
                                                '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com',
                                                *args], cwd=cwd, stderr=subprocess.DEVNULL, text=True)
            root.mkdir()
            git('init', '-b', 'main')
            (root / 'file').write_text('base')
            git('add', 'file')
            git('commit', '-m', 'base')
            git('update-ref', 'refs/remotes/origin/main', 'HEAD')
            git('worktree', 'add', '-b', 'task', str(work))
            (work / 'file').write_text('changed')
            git('commit', '-am', 'change', cwd=work)
            (work / 'untracked').write_text('pending')
            script = evidence.WORKTREES.replace('/tmp/agent-lcars-direct/checkout', str(root)).replace('/home/runner/_work/*/*', str(Path(directory) / 'absent/*/*'))
            result = subprocess.check_output(['sh', '-c', script], text=True)
            self.assertIn(f'worktree={root} commits=0 dirty=0', result)
            self.assertIn(f'worktree={work} commits=1 dirty=1', result)

    def test_command_timeout_is_sanitized(self):
        with patch.object(evidence.subprocess, 'run', side_effect=subprocess.TimeoutExpired('secret', 20)):
            with self.assertRaisesRegex(evidence.ProbeError, '^ssh unavailable or timed out$'):
                evidence.command(['ssh', 'host'])


if __name__ == '__main__':
    unittest.main()
