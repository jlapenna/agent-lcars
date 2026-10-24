#!/usr/bin/env python3
"""Regression coverage for fixture cleanup racing detached hook clients."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


HELPER = Path(__file__).with_name("drain-hook-test-clients.py")


class DrainTests(unittest.TestCase):
    def child(self, scratch, duration):
        child = subprocess.Popen(
            [sys.executable, "-c", f"import time; print('ready', flush=True); time.sleep({duration})"],
            env={**os.environ, "TMPDIR": str(scratch)},
            stdout=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        self.addCleanup(self.stop, child)
        self.assertEqual(child.stdout.readline().strip(), "ready")
        return child

    @staticmethod
    def stop(child):
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=5)
        child.stdout.close()

    def test_waits_for_owned_client_without_touching_foreign_client(self):
        with tempfile.TemporaryDirectory() as scratch, tempfile.TemporaryDirectory() as foreign:
            owned = self.child(scratch, 1)
            unrelated = self.child(foreign, 60)
            subprocess.run([sys.executable, str(HELPER), scratch], check=True, timeout=35)
            self.assertEqual(owned.poll(), 0)
            self.assertIsNone(unrelated.poll())

    def test_deadline_refuses_cleanup_and_preserves_live_client(self):
        with tempfile.TemporaryDirectory() as scratch:
            owned = self.child(scratch, 60)
            sentinel = Path(scratch) / "client-state"
            sentinel.write_text("retained")
            diagnostics = io.StringIO()
            with mock.patch.object(sys, "argv", [str(HELPER), scratch]), \
                    mock.patch("time.monotonic", side_effect=[0, 31]), \
                    contextlib.redirect_stderr(diagnostics), \
                    self.assertRaises(SystemExit) as result:
                runpy.run_path(str(HELPER), run_name="__main__")
            self.assertEqual(result.exception.code, 1)
            self.assertIn("reason=deadline", diagnostics.getvalue())
            self.assertIsNone(owned.poll())
            self.assertEqual(sentinel.read_text(), "retained")


if __name__ == "__main__":
    unittest.main()
