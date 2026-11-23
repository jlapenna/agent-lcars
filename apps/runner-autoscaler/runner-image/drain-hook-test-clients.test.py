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
    def child(self, scratch, duration, extra_args=(), extra_env=None, comm_override=None):
        rename = ""
        if comm_override is not None:
            rename = (
                "import ctypes; "
                f"ctypes.CDLL(None).prctl(15, {comm_override.encode('utf-8')!r}, 0, 0, 0); "
            )
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                f"{rename}import time; print('ready', flush=True); time.sleep({duration})",
                *extra_args,
            ],
            env={**os.environ, **(extra_env or {}), "TMPDIR": str(scratch)},
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
            owned = self.child(
                scratch,
                60,
                extra_args=("private-arg-secret",),
                extra_env={"PRIVATE_ENV": "private-env-secret"},
                comm_override="sk-comm-secret1",
            )
            sentinel = Path(scratch) / "client-state"
            sentinel.write_text("retained")
            diagnostics = io.StringIO()
            clean_env = {
                key: value
                for key, value in os.environ.items()
                if key not in ("HOOK_DRAIN_DEADLINE_SECONDS", "HOOK_SMOKE_DEGRADE_DEADLINE")
            }
            real_readlink = os.readlink

            # Emulated (QEMU user-mode) builds report the emulator for a peer's
            # /proc/<pid>/exe, so the deterministic label uses a known lookup.
            def known_exe(target, *args, **kwargs):
                if str(target).endswith("/exe"):
                    return "/usr/bin/python3"
                return real_readlink(target, *args, **kwargs)

            with mock.patch.dict(os.environ, clean_env, clear=True), \
                    mock.patch.object(sys, "argv", [str(HELPER), scratch]), \
                    mock.patch("os.readlink", side_effect=known_exe), \
                    mock.patch("time.monotonic", side_effect=[0, 31]), \
                    contextlib.redirect_stderr(diagnostics), \
                    self.assertRaises(SystemExit) as result:
                runpy.run_path(str(HELPER), run_name="__main__")
            stderr = diagnostics.getvalue()
            self.assertEqual(result.exception.code, 1)
            self.assertIn("reason=deadline processes=python3", stderr)
            self.assertNotIn("sk-comm-secret1", stderr)
            self.assertNotIn("private-arg-secret", stderr)
            self.assertNotIn("private-env-secret", stderr)
            self.assertIsNone(owned.poll())
            self.assertEqual(sentinel.read_text(), "retained")

    def test_unrecognized_comm_without_exe_falls_back_to_unknown_and_checks_pidfd(self):
        with tempfile.TemporaryDirectory() as scratch:
            owned = self.child(
                scratch,
                60,
                comm_override="sk-comm-secret1",
            )
            diagnostics = io.StringIO()
            clean_env = {
                key: value
                for key, value in os.environ.items()
                if key not in ("HOOK_DRAIN_DEADLINE_SECONDS", "HOOK_SMOKE_DEGRADE_DEADLINE")
            }
            real_readlink = os.readlink

            def hide_exe(target, *args, **kwargs):
                if str(target).endswith("/exe"):
                    raise PermissionError(13, "exe hidden")
                return real_readlink(target, *args, **kwargs)

            with mock.patch.dict(os.environ, clean_env, clear=True), \
                    mock.patch.object(sys, "argv", [str(HELPER), scratch]), \
                    mock.patch("os.readlink", side_effect=hide_exe), \
                    mock.patch("time.monotonic", side_effect=[0, 31]), \
                    contextlib.redirect_stderr(diagnostics), \
                    self.assertRaises(SystemExit) as result:
                runpy.run_path(str(HELPER), run_name="__main__")
            stderr = diagnostics.getvalue()
            self.assertEqual(result.exception.code, 1)
            self.assertIn("reason=deadline processes=unknown", stderr)
            self.assertNotIn("sk-comm-secret1", stderr)
            self.assertIsNone(owned.poll())

            # Also verify snapshot_label rejects a post-exit/recycled snapshot when
            # pidfd_send_signal reports ESRCH after reading stat.
            fake_proc = Path(scratch) / "fake-proc"
            fake_proc.mkdir()
            (fake_proc / "stat").write_text("999 (codex) S 1 " + " ".join(["0"] * 19) + " 42 0\n")
            namespace = {}
            for line in HELPER.read_text().splitlines():
                if line.startswith("try:"):
                    break
                namespace.setdefault("_src", []).append(line)
            exec("\n".join(namespace["_src"]), namespace)
            with mock.patch("signal.pidfd_send_signal", side_effect=ProcessLookupError(3, "ESRCH")):
                self.assertEqual(
                    namespace["snapshot_label"](fake_proc, "42", 99, "git"),
                    "git",
                )

    def test_degrade_deadline_exits_75_and_honors_configured_deadline(self):
        with tempfile.TemporaryDirectory() as scratch:
            owned = self.child(
                scratch,
                60,
                extra_args=("private-arg-secret",),
                extra_env={"PRIVATE_ENV": "private-env-secret"},
                comm_override="sk-comm-secret1",
            )
            sentinel = Path(scratch) / "client-state"
            sentinel.write_text("retained")
            result = subprocess.run(
                [sys.executable, str(HELPER), scratch],
                env={
                    **os.environ,
                    "HOOK_DRAIN_DEADLINE_SECONDS": "0.15",
                    "HOOK_SMOKE_DEGRADE_DEADLINE": "1",
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 75)
            # The live label depends on the host's /proc/<pid>/exe view (an
            # emulator under QEMU), so only the allowlisted shape is asserted here.
            self.assertRegex(
                result.stderr.strip(),
                r"^hook smoke cleanup: process drainage refused; retaining private scratch; "
                r"exception=RuntimeError errno=none reason=deadline processes=(python3|unknown)$",
            )
            self.assertNotIn("sk-comm-secret1", result.stderr)
            self.assertNotIn("private-arg-secret", result.stderr)
            self.assertNotIn("private-env-secret", result.stderr)
            self.assertIsNone(owned.poll())
            self.assertEqual(sentinel.read_text(), "retained")

            invalid = subprocess.run(
                [sys.executable, str(HELPER), scratch],
                env={
                    **os.environ,
                    "HOOK_DRAIN_DEADLINE_SECONDS": "private-bad-deadline",
                    "HOOK_SMOKE_DEGRADE_DEADLINE": "1",
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(invalid.returncode, 1)
            self.assertEqual(
                invalid.stderr.strip(),
                "hook smoke cleanup: process drainage refused; retaining private scratch; "
                "exception=ValueError errno=none reason=other",
            )
            self.assertNotIn("private-bad-deadline", invalid.stderr)

    def test_empty_first_scan_past_deadline_still_completes_confirmation_scan(self):
        with tempfile.TemporaryDirectory() as scratch:
            diagnostics = io.StringIO()
            clean_env = {
                key: value
                for key, value in os.environ.items()
                if key not in ("HOOK_DRAIN_DEADLINE_SECONDS", "HOOK_SMOKE_DEGRADE_DEADLINE")
            }
            with mock.patch.dict(os.environ, clean_env, clear=True), \
                    mock.patch.object(sys, "argv", [str(HELPER), scratch]), \
                    mock.patch("time.monotonic", side_effect=[0, 31, 62]), \
                    contextlib.redirect_stderr(diagnostics):
                runpy.run_path(str(HELPER), run_name="__main__")
            self.assertEqual(diagnostics.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
