#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
dockerfile="$repo_root/tools/e2e-runner/Dockerfile"
control_plane_dockerfile="$repo_root/apps/runner-autoscaler/control-plane-image/Dockerfile"
repair_script="apps/runner-autoscaler/runner-image/repair-node-tar.sh"

grep -Fqx "COPY ${repair_script} /tmp/repair-node-tar.sh" "$dockerfile"
grep -Fqx 'RUN bash /tmp/repair-node-tar.sh && rm /tmp/repair-node-tar.sh' "$dockerfile"
grep -Fq 'readonly fixed_version="7.5.22"' "$repo_root/$repair_script"
grep -Fq -- '--install-strategy=nested tar@7.5.22' "$control_plane_dockerfile"
test "$(grep -Fc '= 7.5.22;' "$control_plane_dockerfile")" -eq 1

echo 'published runner shapes repair every inherited npm node-tar copy'
