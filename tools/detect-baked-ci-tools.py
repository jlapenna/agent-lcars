#!/usr/bin/env python3
"""Detect image-owned tools against the consuming job's existing setup pins."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys


def command(*args):
    return subprocess.check_output(
        args,
        text=True,
        stderr=subprocess.DEVNULL,
        timeout=5,
        env={**os.environ, "UV_PYTHON_DOWNLOADS": "never", "UV_OFFLINE": "1"},
    ).strip()


def output(name, value):
    if "\n" in value or "\r" in value:
        raise ValueError("Multiline tool metadata is invalid")
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write(f"{name}={value}\n")


def detect(tool):
    if os.environ.get("RUNNER_ENVIRONMENT") != "self-hosted":
        return False
    # PyYAML is image-owned too. A missing parser takes the setup fallback.
    import yaml

    workflow = yaml.safe_load(Path(".github/workflows/ci.yml").read_text())
    steps = workflow["jobs"][os.environ["GITHUB_JOB"]]["steps"]
    action = (
        "hashicorp/setup-terraform@"
        if tool == "terraform"
        else "astral-sh/setup-uv@"
    )
    pins = next(step["with"] for step in steps if step.get("uses", "").startswith(action))
    if tool == "terraform":
        expected = str(pins["terraform_version"]).removeprefix("v")
        actual = json.loads(command("terraform", "version", "-json"))
        return actual["terraform_version"] == expected

    expected_uv = str(pins["version"])
    expected_python = str(pins["python-version"])
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", expected_python):
        return False
    if command("uv", "--version").split()[1] != expected_uv:
        return False
    interpreter = command("uv", "python", "find", "--managed-python", expected_python)
    actual_python = command(interpreter, "--version").removeprefix("Python ")
    if actual_python != expected_python and not actual_python.startswith(
        expected_python + "."
    ):
        return False
    output("cache_dir", command("uv", "cache", "dir"))
    output("uv_version", expected_uv)
    output("python_version", expected_python)
    # setup-uv's python-version input sets UV_PYTHON; preserve that contract.
    with open(os.environ["GITHUB_ENV"], "a") as stream:
        stream.write(f"UV_PYTHON={expected_python}\n")
    return True


if __name__ == "__main__":
    tool = sys.argv[1]
    if tool not in ("terraform", "python"):
        raise SystemExit("Expected terraform or python")
    try:
        ready = detect(tool)
    except (
        ImportError,
        OSError,
        ValueError,
        KeyError,
        IndexError,
        StopIteration,
        TypeError,
        subprocess.SubprocessError,
    ):
        ready = False
    output("ready", str(ready).lower())
    if not ready:
        print(
            f"::notice::Baked {tool} tooling is unavailable or does not match "
            "this job's setup pins; using the setup action."
        )
