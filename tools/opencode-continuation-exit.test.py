#!/usr/bin/env python3
"""Exercise the real artifact wrapper's failure paths with a failing CLI shim."""

import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


class ContinuationExitTest(unittest.TestCase):
    def setUp(self):
        self.fixture = (
            Path(__file__).resolve().parents[1]
            / "apps/runner-autoscaler/runner-image"
        )
        self.temporary = tempfile.TemporaryDirectory(prefix="opencode-exit-test-")
        self.addCleanup(self.temporary.cleanup)
        self.scratch = Path(self.temporary.name)
        self.home = self.scratch / "home"
        config = self.home / ".config/opencode"
        config.mkdir(parents=True)
        (config / "opencode.json").write_text("{}\n")
        for name in [
            "instructions.md",
            "context-lifecycle.js",
            "lcars-session.js",
            "lcars-telemetry.js",
            "package.json",
            "package-lock.json",
        ]:
            (config / name).write_text("{}\n")
        (config / "node_modules").mkdir()
        data = self.home / ".local/share/opencode"
        data.mkdir(parents=True)
        connection = sqlite3.connect(data / "opencode.db")
        connection.execute("CREATE TABLE part (data TEXT)")
        connection.commit()
        connection.close()
        self.cli = self.scratch / "opencode"
        self.cli.write_text(
            "#!/usr/bin/env bash\n"
            'if [ "$1" = --version ]; then\n'
            '  printf "%s\\n" "$FIXTURE_VERSION"\n'
            '  exit "${FIXTURE_VERSION_EXIT:-0}"\n'
            "fi\n"
            "echo 'child stderr sentinel' >&2\n"
            'exit "$FIXTURE_RUN_EXIT"\n'
        )
        self.cli.chmod(0o755)

    def run_wrapper(self, **overrides):
        env = {
            **os.environ,
            "HOME": str(self.home),
            "TMPDIR": str(self.scratch),
            "XDG_DATA_HOME": str(self.home / ".local/share"),
            "OPENCODE_BIN": str(self.cli),
            "FIXTURE_VERSION": (self.fixture / "opencode-version")
            .read_text()
            .strip()
            .removeprefix("v"),
            "FIXTURE_RUN_EXIT": "37",
            **overrides,
        }
        # The real wrapper owns version/provider/framework deadlines and EXIT
        # cleanup. The enclosing job supervises its whole cgroup; a Python
        # timeout would kill only the wrapper and strand its provider child.
        result = subprocess.run(
            ["bash", str(self.fixture / "opencode-continuation.test.sh")],
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(list(self.scratch.glob("tmp.*")), [])
        return result

    def test_version_probe_preserves_child_status(self):
        result = self.run_wrapper(FIXTURE_VERSION_EXIT="37")
        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertIn("exit 37", result.stderr)

    def test_framework_preserves_child_status_and_diagnostics(self):
        for status in [37, 124, 137]:
            with self.subTest(status=status):
                result = self.run_wrapper(FIXTURE_RUN_EXIT=str(status))
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertIn("child stderr sentinel", result.stderr)
                self.assertIn(f"exit {status}", result.stderr)
                self.assertIn("observations: 0", result.stderr)

    def test_wrong_version_remains_a_validation_failure(self):
        result = self.run_wrapper(FIXTURE_VERSION="wrong-version")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("test must run against pinned OpenCode", result.stderr)


if __name__ == "__main__":
    unittest.main()
