#!/usr/bin/env python3
"""Cache exactly the committed providers without loading resources or a backend."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def cache_providers(lockfiles):
    for lockfile in lockfiles:
        lock = Path(lockfile)
        providers = {}
        for source, block in re.findall(r'provider "([^"]+)"\s*\{([^}]+)\}', lock.read_text()):
            version = re.search(r'\bversion\s*=\s*"([^"]+)"', block)
            if not version:
                raise ValueError(f"Missing provider version in {lock}")
            providers[f"provider{len(providers)}"] = {"source": source, "version": version.group(1)}
        if not providers:
            raise ValueError(f"No locked providers in {lock}")
        with tempfile.TemporaryDirectory(prefix="runner-provider-cache-") as directory:
            root = Path(directory)
            # This generated configuration cannot contain backend, resource,
            # data, or module blocks. init only verifies/downloads providers.
            (root / "main.tf.json").write_text(json.dumps({"terraform": {"required_providers": providers}}))
            shutil.copyfile(lock, root / ".terraform.lock.hcl")
            subprocess.run(["terraform", f"-chdir={root}", "init", "-backend=false", "-input=false", "-lockfile=readonly"], check=True)


if __name__ == "__main__":
    cache = os.environ.get("TF_PLUGIN_CACHE_DIR")
    if not cache or not sys.argv[1:]:
        raise SystemExit("TF_PLUGIN_CACHE_DIR and at least one committed lockfile are required")
    Path(cache).mkdir(parents=True, exist_ok=True)
    cache_providers(sys.argv[1:])
