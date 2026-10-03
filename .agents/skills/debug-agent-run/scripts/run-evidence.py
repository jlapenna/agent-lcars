#!/usr/bin/env python3
"""Read-only direct-runner evidence, executed on the configured SSH bastion."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from urllib.parse import urlsplit


class ProbeError(Exception):
    pass


def command(args, timeout=20, **kwargs):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, **kwargs)
    except (subprocess.TimeoutExpired, OSError) as error:
        raise ProbeError(f"{args[0]} unavailable or timed out") from error
    if result.returncode:
        # Never print arbitrary stderr or inspect Config.Env: both may hold secrets.
        raise ProbeError(f"{args[0]} exited {result.returncode}")
    return result.stdout


def deployment_config(config):
    """Read the active mounted configuration without inspecting environments."""
    import yaml
    if '_deployment' in config:
        return config['_deployment']
    path = config.get('config')
    if not path:
        mounts = json.loads(command([
            'docker', 'inspect', config.get('autoscaler', 'runner-autoscaler'),
            '--format', '{{json .Mounts}}',
        ]))
        config['_mounts'] = mounts
        path = next((m['Source'] for m in mounts
                     if m['Destination'] == '/config/orchestrator.yml'), None)
    if not path:
        raise ProbeError('autoscaler config mount missing; set DEBUG_RUN_CONFIG')
    try:
        deployment = yaml.safe_load(Path(path).read_text())
        if not isinstance(deployment, dict):
            raise ProbeError('queue deployment configuration is not a mapping')
        config['_deployment'] = deployment
        return deployment
    except (OSError, yaml.YAMLError) as error:
        raise ProbeError('cannot read queue deployment configuration') from error


def hosts(config):
    """Use the running autoscaler's fleet inventory, not a copied host list."""
    try:
        inventory = deployment_config(config)['fleet']['hosts']
        selected = config.get('hosts', '').split()
        available = {h['name']: h['docker'] for h in inventory}
        unknown = set(selected) - available.keys()
        if unknown:
            raise ProbeError('unknown configured hosts: ' + ', '.join(sorted(unknown)))
        return [(name, endpoint) for name, endpoint in available.items()
                if not selected or name in selected]
    except (KeyError, TypeError) as error:
        raise ProbeError('cannot read fleet host inventory') from error


def kubernetes_context(config, deployment):
    queue = deployment['kubernetes']
    namespace = queue['namespace']
    kubeconfig = config.get('kubeconfig') or queue.get('kubeconfig')
    if not kubeconfig:
        raise ProbeError('set DEBUG_RUN_KUBECONFIG to an operator-side credential')
    # A mounted controller path is not necessarily a bastion path. Resolve it
    # through the same inspected mounts used to find the active configuration.
    if not config.get('kubeconfig'):
        for mount in sorted(config.get('_mounts', []), key=lambda m: len(m['Destination']), reverse=True):
            target = mount['Destination']
            if kubeconfig == target or kubeconfig.startswith(target.rstrip('/') + '/'):
                kubeconfig = mount['Source'] + kubeconfig[len(target):]
                break
    return ['kubectl', '--kubeconfig', kubeconfig, '--namespace', namespace,
            '--request-timeout=10s']


def probe_kubernetes(config, deployment):
    if config.get('hosts'):
        raise ProbeError('DEBUG_RUN_HOSTS is Docker-only; select an exact Kubernetes run instead')
    base = kubernetes_context(config, deployment)
    jobs = json.loads(command(base + ['get', 'jobs', '-l', 'agent-lcars.queue-job=true', '-o', 'json']))['items']
    pods = json.loads(command(base + ['get', 'pods', '-l', 'agent-lcars.queue-job=true', '-o', 'json']))['items']
    selected = []
    for job in jobs:
        run_id = job['metadata'].get('annotations', {}).get('agent-lcars.run-id')
        if not isinstance(run_id, str) or not matches(run_id, config.get('selector', '')):
            continue
        if config.get('selector', '').isdecimal() and not run_id.startswith(config['repo'] + '#'):
            continue
        selected.append(job)
    failures = int(len(selected) > 100)
    if failures:
        print('Kubernetes inventory truncated to 100 matching Jobs; results incomplete')
    deadline = time.monotonic() + 240
    for job in selected[:100]:
        if time.monotonic() >= deadline:
            print('Kubernetes inspection exceeded 240 seconds; results incomplete')
            return 1
        name, uid = job['metadata']['name'], job['metadata']['uid']
        run_id = job['metadata']['annotations']['agent-lcars.run-id']
        state = next((c['type'] for c in job.get('status', {}).get('conditions', [])
                      if c.get('status') == 'True' and c.get('type') in ('Complete', 'Failed')), None)
        state = state or ('suspended' if job.get('spec', {}).get('suspend') else 'active')
        print(f'[kubernetes] job={name} run={run_id} state={state}', flush=True)
        owned = [pod for pod in pods if any(owner.get('uid') == uid and owner.get('kind') == 'Job'
                 for owner in pod['metadata'].get('ownerReferences', []))]
        if not owned:
            print('    no retained pod (may be suspended, Pending creation, or already cleaned up)')
        if len(owned) > 10:
            print('    pod inventory truncated to 10; results incomplete')
            failures += 1
        for pod in owned[:10]:
            if time.monotonic() >= deadline:
                print('Kubernetes inspection exceeded 240 seconds; results incomplete')
                return 1
            pod_name = pod['metadata']['name']
            phase = pod.get('status', {}).get('phase', 'unknown')
            node = pod.get('spec', {}).get('nodeName', 'unassigned')
            containers = pod.get('status', {}).get('containerStatuses', [])
            state = next((entry.get('state', {}) for entry in containers if entry.get('name') == 'direct-runner'), {})
            detail = state.get('terminated') or state.get('waiting') or {}
            print(f'    pod={pod_name} node={node} phase={phase} '
                  f'reason={detail.get("reason", "")} exit={detail.get("exitCode", "")} '
                  f'started={detail.get("startedAt", "")} finished={detail.get("finishedAt", "")}', flush=True)
            if phase != 'Running' or state.get('terminated'):
                continue
            if config.get('kube_worktrees') != 'true':
                print('    worktrees not inspected; opt in with DEBUG_RUN_KUBE_WORKTREES=true and an operator credential')
                continue
            try:
                print(command(base + ['exec', pod_name, '-c', 'direct-runner', '--', 'sh', '-c', WORKTREES]), end='')
            except ProbeError as error:
                failures += 1
                print(f'    worktree evidence incomplete: {error}')
    print(f'Matching direct runs: {len(selected[:100])}; incomplete probes: {failures}')
    return 1 if failures else 0


def host_command(endpoint, args, config):
    if endpoint == 'local':
        return command(args)
    address = urlsplit(endpoint)
    if address.scheme != 'ssh' or not address.hostname or address.password:
        raise ProbeError('unsupported Docker endpoint; expected local or ssh')
    target = (address.username + '@' if address.username else '') + address.hostname
    ssh = ['ssh', '-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6',
           '-i', os.path.expanduser(config.get('key', '~/p/homelab/ansible/ssh_key/id_ed25519'))]
    if address.port:
        ssh += ['-p', str(address.port)]
    return command(ssh + [target, shlex.join(args)])


def matches(run_id, selector):
    if not selector:
        return True
    if selector.isdecimal():
        # Bare issue numbers are explicitly scoped to the selected repository.
        return bool(re.fullmatch(r'[^#]+#' + re.escape(selector) + r'/r\d+', run_id))
    return run_id == selector or run_id.startswith(selector + '/r')


INSPECT = ('[{{json .Name}},{{json .State.Status}},{{json .State.ExitCode}},'
           '{{json (index .Config.Labels "agent-lcars.direct-runner.run-id")}},'
           '{{json .State.StartedAt}},{{json .State.FinishedAt}}]')
WORKTREES = r'''
found=0
for root in /tmp/agent-lcars-direct/checkout /home/runner/_work/*/*; do
  [ -d "$root/.git" ] || continue
  found=1
  entries=$(git -C "$root" worktree list --porcelain 2>/dev/null) || {
    printf '    worktree inventory unreadable: %s\n' "$root"
    continue
  }
  printf '%s\n' "$entries" | while IFS= read -r entry; do
    case "$entry" in
      'worktree '*)
        wt=${entry#worktree }
        commits=$(git -C "$wt" rev-list --count origin/main..HEAD 2>/dev/null) || commits=unknown
        dirty=$(git -C "$wt" status --porcelain 2>/dev/null) || dirty=unknown
        if [ "$dirty" != unknown ]; then
          if [ -z "$dirty" ]; then dirty=0; else dirty=$(printf '%s\n' "$dirty" | wc -l); fi
        fi
        printf '    worktree=%s commits=%s dirty=%s\n' "$wt" "$commits" "$dirty"
        ;;
    esac
  done
done
[ "$found" = 1 ] || echo '    no supported checkout readable (bootstrap may still be running)'
'''


def probe_host(name, endpoint, config):
    run = lambda args: host_command(endpoint, args, config)
    ids = run(['docker', 'ps', '-a', '--filter', 'label=agent-lcars.direct-runner',
               '--format', '{{.ID}}']).splitlines()
    count = 0
    failures = 0
    deadline = time.monotonic() + 30
    # Retention is bounded by the autoscaler; also bound pathological inventories.
    if len(ids) > 100:
        print(f'[{name}] inventory truncated to 100 containers')
    for container_id in ids[:100]:
        if time.monotonic() >= deadline:
            print(f'[{name}] host inspection exceeded 30 seconds; results incomplete')
            return count, failures + 1
        try:
            container, state, exit_code, run_id, started, finished = json.loads(
                run(['docker', 'inspect', '--format', INSPECT, container_id]))
            if not isinstance(run_id, str) or not matches(run_id, config.get('selector', '')):
                continue
            if config.get('selector', '').isdecimal() and not run_id.startswith(config['repo'] + '#'):
                continue
            count += 1
            print(f'[{name}] {container.lstrip("/")} run={run_id} state={state} '
                  f'exit={exit_code} started={started} finished={finished}', flush=True)
            if state == 'running':
                print(run(['docker', 'exec', container_id, 'sh', '-c', WORKTREES]), end='')
        except (ProbeError, ValueError) as error:
            failures += 1
            print(f'[{name}] container {container_id}: {error}')
    return count, failures


def probe(config):
    deployment = deployment_config(config)
    if deployment.get('kubernetes') is not None:
        return probe_kubernetes(config, deployment)
    count = 0
    failures = 0
    deadline = time.monotonic() + 240
    for name, endpoint in hosts(config):
        if time.monotonic() >= deadline:
            print('Scan exceeded 240 seconds; remaining hosts were not inspected')
            return 1
        try:
            found, incomplete = probe_host(name, endpoint, config)
            count += found
            failures += incomplete
        except (ProbeError, ValueError) as error:
            failures += 1
            print(f'[{name}] unavailable: {error}', flush=True)
    print(f'Matching direct runners: {count}; incomplete probes: {failures}')
    return 1 if failures else 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--probe':
        try:
            return probe(json.loads(sys.argv[2]))
        except (ProbeError, ImportError, ValueError) as error:
            print(f'Cannot collect run evidence: {error}', file=sys.stderr)
            return 1
    if len(sys.argv) > 2 or (len(sys.argv) == 2 and sys.argv[1].startswith('-')):
        print('usage: run-evidence.sh [issue-number | repo#issue | full-run-id]')
        return 2
    config = {'selector': sys.argv[1] if len(sys.argv) == 2 else '',
              'repo': os.environ.get('DEBUG_RUN_REPO', 'jlapenna/agent-lcars')}
    for key in ('config', 'hosts', 'key', 'autoscaler', 'kubeconfig', 'kube_worktrees'):
        value = os.environ.get('DEBUG_RUN_' + ('FLEET_KEY' if key == 'key' else key.upper()))
        if value:
            config[key] = value
    bastion = os.environ.get('DEBUG_RUN_BASTION', 'homelab@homelab.lan.jlapenna.net')
    remote = shlex.join(['python3', '-', '--probe', json.dumps(config)])
    # Stream results, so an unavailable host never hides preceding evidence.
    try:
        return subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
                               bastion, remote], input=Path(__file__).read_text(),
                              text=True, timeout=300).returncode
    except (subprocess.TimeoutExpired, OSError):
        print('Bastion evidence scan unavailable or exceeded 300 seconds', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
