#!/usr/bin/env python3
"""Fail closed unless one local Docker host fits the complete E2E profile."""

import json
import os
from pathlib import Path
import subprocess
import sys

GIB = 1024**3


def validate_fit(cpu, available_memory, available_storage):
    # Local interactive hosts retain 1 CPU, 6 GiB RAM and 4 GiB disk for
    # host/services. This is separate from the post-reserve ARC contract.
    if cpu - 1 < 2 or available_memory - 6 * GIB < 6 * GIB:
        raise ValueError("local CPU/RAM cannot fit 2 CPU / 6 GiB after host reserves")
    if not available_storage or min(available_storage) - 4 * GIB < 40 * GIB:
        raise ValueError("local storage cannot fit 40 GiB after host reserves")
    return min(
        4,
        int((cpu - 1) // 2),
        (available_memory - 6 * GIB) // (6 * GIB),
        (min(available_storage) - 4 * GIB) // (40 * GIB),
    )


def checked(*command):
    return subprocess.check_output(command, text=True, timeout=15).strip()


def capacity(paths):
    if Path("/.dockerenv").exists() or os.environ.get("DOCKER_HOST"):
        raise ValueError(
            "remote/nested Docker capacity is unknown; use the supported CI lane"
        )
    endpoint = checked(
        "docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"
    )
    if not endpoint.startswith("unix://"):
        raise ValueError(
            "only a local Unix-socket Docker daemon has a verified host surface"
        )
    daemon = json.loads(checked("docker", "info", "--format", "{{json .}}"))
    cpu = min(daemon["NCPU"], len(os.sched_getaffinity(0)))
    meminfo = dict(
        line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines()
    )
    memory = min(daemon["MemTotal"], int(meminfo["MemAvailable"].split()[0]) * 1024)
    # Respect all cgroup v2 ancestors, not just the physical host totals.
    if not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise ValueError("cgroup capacity is unknown; use the supported CI lane")
    membership = Path("/proc/self/cgroup").read_text().strip().split(":", 2)
    if membership[:2] != ["0", ""]:
        raise ValueError("cgroup capacity is ambiguous")
    cgroup_root = Path("/sys/fs/cgroup")
    current = cgroup_root / membership[2].lstrip("/")
    if ".." in current.parts:
        raise ValueError("cgroup capacity path is ambiguous")
    while True:
        root_is_host = (
            current == cgroup_root
            and Path("/proc/1/comm").read_text().strip() in ("systemd", "init")
            and Path("/proc/1/cgroup").read_text().strip() == "0::/"
            and Path("/proc/self/ns/cgroup").stat().st_ino
            == Path("/proc/1/ns/cgroup").stat().st_ino
        )
        memory_control = current / "memory.max"
        cpu_control = current / "cpu.max"
        if (
            not memory_control.exists() or not cpu_control.exists()
        ) and not root_is_host:
            raise ValueError("cgroup resource controls are unknown")
        memory_limit = (
            memory_control.read_text().strip() if memory_control.exists() else "max"
        )
        if memory_limit != "max":
            memory = min(
                memory,
                int(memory_limit) - int((current / "memory.current").read_text()),
            )
        quota, period = (
            cpu_control.read_text().split()
            if cpu_control.exists()
            else ("max", "100000")
        )
        if quota != "max":
            cpu = min(cpu, int(quota) / int(period))
        if current == cgroup_root:
            break
        current = current.parent
    daemon_root = Path(daemon["DockerRootDir"])
    if not daemon_root.is_absolute() or not daemon_root.is_dir():
        raise ValueError("Docker daemon storage is unknown on this host")
    daemon_filesystem = os.statvfs(daemon_root)
    storage = [daemon_filesystem.f_bavail * daemon_filesystem.f_frsize]
    for path in map(Path, paths):
        while not path.exists() and path != path.parent:
            path = path.parent
        filesystem = os.statvfs(path)
        storage.append(filesystem.f_bavail * filesystem.f_frsize)
    return cpu, memory, storage


if __name__ == "__main__":
    try:
        print(validate_fit(*capacity(sys.argv[1:])))
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        sys.exit(f"e2e-docker: capacity preflight refused: {error}")
