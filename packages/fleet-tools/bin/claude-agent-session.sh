#!/usr/bin/env bash
# Attach to (or inspect) Claude issue-agent sessions running on the
# homelab fleet's ephemeral JIT runners (jlapenna/agent-lcars's
# apps/runner-autoscaler, homelab#97). The agent advertises the exact
# `resume` command for its run in its first issue comment, so the
# maintainer can paste it to take over. See .github/workflows/claude.yml.
#
# Runners are single-job, torn-down-at-completion containers named
# `runner-<scale-set>-<uuid8>` (apps/runner-autoscaler/scaler.go),
# scheduled onto whichever of the fleet's hosts
# (homelab/pike/laforge/spark/janeway) the autoscaler picks -- there is
# no single local docker daemon to query. This fans discovery out over
# SSH to every configured fleet host, the same way the autoscaler
# control plane itself reaches them (apps/runner-autoscaler/hosts.go),
# but using the OPERATOR's own already-authorized homelab-user SSH
# access, not the control plane's own dedicated fleet automation key
# (which only that container can read).
#
# Fleet-canonical copy (agent-lcars#1307; it started life in
# supersprinklesracing/sprinkles as members#3407): jlapenna/homelab and
# sprinkles vendor this file byte-for-byte -- all three repos share the
# identical fleet -- and the verify-fleet-scripts published action fails
# their CI when a vendored copy drifts. Edit it HERE and re-sync the
# consumers. The per-repo differences (scale set, checkout path,
# transcripts bucket, extra hosts) are exactly the CLAUDE_* defaults
# below: a consumer overrides them in a sibling claude-agent-session.conf,
# never by editing its copy of this script.
#
# claude-code-action (the GitHub Action claude.yml uses to actually run
# Claude) does not leave a standalone `claude` CLI on PATH inside the
# container -- it drives its own bundled bun/TypeScript engine instead.
# `resume` below installs a fresh copy via `npx` (Node IS baked into the
# runner image) rather than assuming a pre-installed binary; this is a
# different process than the one that wrote the transcript, but Claude
# Code's session storage under ~/.claude/projects is CLI-version-agnostic,
# the same way resuming a local session after upgrading `claude` works.
#
# `resume-archive` is a separate, fleet-independent path for a run whose
# container is already gone: claude.yml's "Finalize telemetry sidecar"
# step archives the raw transcript to GCS and records its gs:// URI on
# the session's Firestore doc (transcriptGcsUri) once the job ends. This
# subcommand restores that archived transcript into the CURRENT
# checkout's local ~/.claude/projects/<cwd-slug>/ dir so
# `claude --resume <session-id>` works here, on the workstation -- entirely
# unaffected by the fleet topology, since it never touches a runner host.
set -euo pipefail

# Repo-specific defaults: tools/claude-agent-session.conf at the top of
# the repository this command is launched from may pre-seed any CLAUDE_*
# variable read below. Use the `: "${CLAUDE_X:=value}"` form there so an
# explicit environment override still wins over the repo's conf. Without a
# conf, the fallbacks below are jlapenna/agent-lcars's own registration --
# a consumer repo MUST ship a conf or its sessions target the wrong scale
# set, checkout path, and transcripts bucket. (This script lives only in
# agent-lcars and runs from PATH as fleet-claude-agent-session — see
# tools/install-fleet-tools.sh — so the conf is resolved from the caller's
# repo, never from the script's own directory.)
launch_repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$launch_repo_root" ] && [ -f "$launch_repo_root/tools/claude-agent-session.conf" ]; then
  # shellcheck source=/dev/null
  . "$launch_repo_root/tools/claude-agent-session.conf"
fi

# Fleet hosts this queries. Keep in sync with jlapenna/homelab's
# github-runner-autoscaler/orchestrator.yml `fleet.hosts` list -- there is
# no live discovery endpoint for it (the control plane's own /metrics
# doesn't expose the host inventory), so this is a duplicated, hand-
# maintained default, the same way this repo already duplicates other
# fleet facts (the runner image tag, scale-set names). Override entirely
# via CLAUDE_FLEET_HOSTS (space-separated short names; each maps to
# <name>.<CLAUDE_FLEET_DOMAIN>) if the fleet's host list changes before
# this script is updated to match.
read -r -a FLEET_HOSTS <<<"${CLAUDE_FLEET_HOSTS:-homelab pike laforge spark janeway}"
FLEET_SSH_USER="${CLAUDE_FLEET_SSH_USER:-homelab}"
FLEET_DOMAIN="${CLAUDE_FLEET_DOMAIN:-lan.jlapenna.net}"
# Space-separated `host=fqdn` pairs for hosts that do not follow the
# <name>.<CLAUDE_FLEET_DOMAIN> convention (generalizes homelab's
# laptop=laptop.ts.jlapenna.net tailscale mapping; set it in the conf).
FLEET_HOST_ENDPOINTS="${CLAUDE_FLEET_HOST_ENDPOINTS:-}"
SSH_OPTS=(-o ConnectTimeout=8 -o BatchMode=yes)

# Which scale set(s) to search: the one the surrounding repo's claude.yml
# runs on (see its runs-on:). Repos sharing this fleet each have their own
# registration (agent-lcars: homelab-autoscale-claude-agent-lcars,
# sprinkles: homelab-autoscale-claude-agent, homelab:
# homelab-autoscale-homelab-agent) -- the conf sets CLAUDE_SCALE_SETS
# (space-separated).
read -r -a SCALE_SETS <<<"${CLAUDE_SCALE_SETS:-homelab-autoscale-claude-agent-lcars}"

# Best-effort default for `resume`'s working directory inside the
# container: actions/checkout's standard $GITHUB_WORKSPACE convention
# (_work/<repo>/<repo>) under the runner image's HOME (confirmed via
# agent-lcars's apps/runner-autoscaler/runner-image/entrypoint.sh:
# HOME=/home/runner, user `runner`). Not independently confirmed against a live container's
# actual checkout path -- override with CLAUDE_AGENT_WORKDIR if wrong; a
# wrong -w only affects relative-path display inside the resumed session,
# not whether resume itself works.
CLAUDE_AGENT_WORKDIR="${CLAUDE_AGENT_WORKDIR:-/home/runner/_work/agent-lcars/agent-lcars}"
# Optional once-per-host token file so pasted commands need no env setup.
TOKEN_FILE="${CLAUDE_AGENT_TOKEN_FILE:-$HOME/.config/claude-agent/oauth-token}"
# Same bucket the surrounding repo's claude.yml finalize step uploads to
# (agent-lcars's infra/terraform/main.tf, google_storage_bucket.transcripts).
TRANSCRIPTS_BUCKET="${CLAUDE_AGENT_TRANSCRIPTS_BUCKET:-agent-lcars-session-transcripts}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [session-id]

Commands:
  list                    List live agent sessions across the fleet (newest first)
  tail [id]               Live-tail a session transcript (defaults to newest anywhere)
  resume [id]             Take over a session interactively (defaults to newest)
  resume-archive <uri|id> Restore an archived GCS transcript into this checkout's
                          local ~/.claude/projects/ dir, then print the
                          'claude --resume' line for it (for a run whose
                          runner container is already gone)

A session only shows up in 'list'/'tail'/'resume' while its runner
container is still alive -- ephemeral JIT runners are torn down
immediately at job end. For a finished run, use 'resume-archive' instead.

Auth for resume, in order of preference:
  1. CLAUDE_CODE_OAUTH_TOKEN in the environment
  2. Token file: $TOKEN_FILE  (mint one with: claude setup-token)
  3. Neither: Claude Code prompts /login inside the container (credentials
     then persist in that container until it is torn down at job end)

resume-archive usage:
  $(basename "$0") resume-archive gs://$TRANSCRIPTS_BUCKET/runs/<run-id>/<session-id>.jsonl
  $(basename "$0") resume-archive <run-id>
    Bare numeric run ids are expanded by listing
    gs://$TRANSCRIPTS_BUCKET/runs/<run-id>/ for its *.jsonl file; if more
    than one is found, they are listed and you must pass the full URI.
  Requires 'gcloud' with read access to the transcripts bucket. Downloads
  into ~/.claude/projects/<cwd-slug>/ for the CURRENT working directory
  (the slug Claude Code itself uses: '/' and '.' in \$PWD replaced with '-').
  Re-running with the same transcript is a no-op; downloading a different
  transcript over an existing same-named file is refused rather than
  overwritten.
EOF
  exit 1
}

# user@endpoint for a fleet host: <host>.<FLEET_DOMAIN> unless
# FLEET_HOST_ENDPOINTS carries an explicit override for it.
fleet_target() {
  local host="$1" endpoint pair
  endpoint="$host.$FLEET_DOMAIN"
  for pair in $FLEET_HOST_ENDPOINTS; do
    case "$pair" in
      "$host="*) endpoint="${pair#*=}" ;;
    esac
  done
  printf '%s@%s' "$FLEET_SSH_USER" "$endpoint"
}

ssh_host() {
  local host="$1"
  shift
  ssh "${SSH_OPTS[@]}" "$(fleet_target "$host")" "$@"
}

# Print "mtime host container fullpath" for every live session across
# every fleet host, newest first. A host that's down/unreachable just
# contributes nothing -- one bad host must never hide sessions on the
# others.
all_sessions() {
  # NOTE: every remote command below is built as ONE pre-quoted string and
  # passed to ssh_host as its single argument, never as separate words.
  # ssh does not preserve argv grouping when given multiple arguments --
  # it rejoins them with spaces and the remote shell re-tokenizes from
  # scratch, silently losing any embedded spaces (e.g. inside a -printf
  # format string) or quoting (e.g. protecting *.jsonl from a stray
  # remote glob expansion). One string, quoted exactly as if typed by
  # hand at an interactive ssh prompt, is the only safe way to send a
  # multi-word remote command through ssh.
  local host filter_str s containers c remote_cmd
  filter_str=""
  for s in "${SCALE_SETS[@]}"; do
    filter_str+=" --filter label=autoscaler.scale-set=$s"
  done
  for host in "${FLEET_HOSTS[@]}"; do
    containers="$(ssh_host "$host" "docker ps$filter_str --format '{{.Names}}'" 2>/dev/null)" || continue
    [ -n "$containers" ] || continue
    while IFS= read -r c; do
      [ -n "$c" ] || continue
      remote_cmd="docker exec '$c' find /home/runner/.claude/projects -mindepth 2 -maxdepth 2 -name '*.jsonl' -printf '%T@ $host $c %p\\n'"
      ssh_host "$host" "$remote_cmd" 2>/dev/null || true
    done <<<"$containers"
  done | sort -rn
}

# Resolve a resume-archive argument (full gs:// URI or bare numeric run id)
# to a single gs://.../<session-id>.jsonl transcript URI.
resolve_archive_uri() {
  local arg="$1" prefix
  if [[ "$arg" == gs://*.jsonl ]]; then
    echo "$arg"
    return 0
  fi
  if [[ ! "$arg" =~ ^[0-9]+$ ]]; then
    echo "Argument must be a gs://.../<session-id>.jsonl URI or a numeric run id, got: $arg" >&2
    exit 1
  fi
  prefix="gs://$TRANSCRIPTS_BUCKET/runs/$arg/"
  local matches=()
  # `**` (not `*`) to recurse into the adapter subdirectory the archive
  # writer actually uses (e.g. .../claude-code/<session-id>.jsonl -- see
  # agent-lcars's apps/telemetry-watcher/src/lib/finalize.ts) -- gcloud
  # storage's `*` stays within one path segment, `**` crosses directory
  # boundaries.
  mapfile -t matches < <(gcloud storage ls "${prefix}**/*.jsonl" 2>/dev/null || true)
  if [ ${#matches[@]} -eq 0 ]; then
    echo "No transcripts found under $prefix" >&2
    exit 1
  elif [ ${#matches[@]} -gt 1 ]; then
    echo "Multiple transcripts found for run $arg; pass the full URI:" >&2
    printf '  %s\n' "${matches[@]}" >&2
    exit 1
  fi
  echo "${matches[0]}"
}

# Resolve [id] -> "host container fullpath". Without id: newest session
# anywhere on the fleet.
resolve_session() {
  local want="${1:-}" line
  if [ -n "$want" ]; then
    line="$(all_sessions | grep -m1 "/${want}\.jsonl\$" || true)"
  else
    line="$(all_sessions | head -1)"
  fi
  if [ -z "$line" ]; then
    echo "No matching live session found across fleet hosts: ${FLEET_HOSTS[*]} (scale sets: ${SCALE_SETS[*]})" >&2
    echo "A session only appears here while its runner container is still alive. For a finished run, use 'resume-archive' instead." >&2
    exit 1
  fi
  echo "$line" | awk '{print $2, $3, $4}'
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  list)
    all_sessions | while read -r ts host c path; do
      id="$(basename "$path" .jsonl)"
      printf '%s  %-10s %-32s %s\n' "$(date -d "@${ts%.*}" +%Y-%m-%dT%H:%M)" "$host" "$c" "$id"
    done
    ;;
  tail)
    # `resolve_session`'s own `exit 1` doesn't propagate through `<<<"$(...)"`
    # (a failing command substitution is not caught by `set -e` in that
    # position) -- capture it as a plain assignment first, where `||`
    # DOES see the real exit code, so an unresolved session actually stops
    # here instead of falling through with empty host/container/path.
    result="$(resolve_session "${1:-}")" || exit 1
    read -r host container path <<<"$result"
    id="$(basename "$path" .jsonl)"
    echo "Tailing $id in $container on $host (ctrl-c to stop)" >&2
    exec ssh -t "${SSH_OPTS[@]}" "$(fleet_target "$host")" \
      docker exec "$container" tail -f "$path"
    ;;
  resume)
    result="$(resolve_session "${1:-}")" || exit 1
    read -r host container path <<<"$result"
    id="$(basename "$path" .jsonl)"
    # Best-effort liveness check: claude-code-action's engine runs as a
    # `bun` process (see script header). If this is wrong (image changes,
    # different action version), forcing past it is still harmless --
    # worst case, a second CLI process reads/writes the same session file
    # concurrently with the original. CLAUDE_AGENT_RESUME_FORCE=1 bypasses
    # it outright -- re-running this same command with no way to skip the
    # check can never "proceed anyway" while the run is still live, since
    # the check just fails the same way again.
    if [ -z "${CLAUDE_AGENT_RESUME_FORCE:-}" ] && ssh_host "$host" docker exec "$container" pgrep -x bun >/dev/null 2>&1; then
      echo "A claude-code-action run (bun) is still active in $container on $host." >&2
      echo "Wait for the run to finish, or force it: CLAUDE_AGENT_RESUME_FORCE=1 $(basename "$0") resume ${1:-}" >&2
      exit 1
    fi
    token="${CLAUDE_CODE_OAUTH_TOKEN:-}"
    if [ -z "$token" ] && [ -r "$TOKEN_FILE" ]; then
      token="$(cat "$TOKEN_FILE")"
    fi
    echo "Resuming $id in $container on $host" >&2
    echo "Installing a fresh Claude Code CLI via npx inside the container (claude-code-action doesn't leave one on PATH)..." >&2
    if [ -z "$token" ]; then
      echo "No OAuth token found; Claude Code will prompt /login inside the container." >&2
      echo "(Set up $TOKEN_FILE via 'claude setup-token' to skip this.)" >&2
      exec ssh -t "${SSH_OPTS[@]}" "$(fleet_target "$host")" \
        docker exec -it -w "$CLAUDE_AGENT_WORKDIR" "$container" \
        npx -y @anthropic-ai/claude-code@latest --resume "$id"
    fi
    # Never pass the OAuth token as a docker/ssh argv value -- `-e
    # KEY=value` on a docker exec command line sits in `ps` output on the
    # fleet host for as long as the container lives, visible to anyone
    # with shell access there. Pipe it into a 0600 file INSIDE the
    # container over stdin instead (never touching the fleet host's own
    # disk or argv), then have the resumed shell read-and-delete it
    # before exporting the env var -- the token's VALUE never appears in
    # any process listing, only the command that reads it does.
    write_token_cmd="docker exec -i '$container' sh -c 'umask 077; cat > /tmp/.claude-agent-token'"
    printf '%s' "$token" | ssh "${SSH_OPTS[@]}" "$(fleet_target "$host")" "$write_token_cmd"
    resume_cmd="docker exec -it -w '$CLAUDE_AGENT_WORKDIR' '$container' sh -c 'CLAUDE_CODE_OAUTH_TOKEN=\$(cat /tmp/.claude-agent-token 2>/dev/null); rm -f /tmp/.claude-agent-token; export CLAUDE_CODE_OAUTH_TOKEN; exec npx -y @anthropic-ai/claude-code@latest --resume $id'"
    exec ssh -t "${SSH_OPTS[@]}" "$(fleet_target "$host")" "$resume_cmd"
    ;;
  resume-archive)
    [ $# -ge 1 ] || usage
    gcs_uri="$(resolve_archive_uri "$1")"

    base="$(basename "$gcs_uri")"
    session_id="${base%.jsonl}"
    if [ "$base" = "$session_id" ]; then
      echo "Not a .jsonl transcript URI: $gcs_uri" >&2
      exit 1
    fi

    # The same cwd -> project-dir slug Claude Code itself computes: '/' and
    # '.' both become '-' (so e.g. a worktree under .claude/worktrees/ gets
    # a '--' where '/.' was).
    slug="$(printf '%s' "$PWD" | sed 's/[\/.]/-/g')"
    dest_dir="$HOME/.claude/projects/$slug"
    dest_file="$dest_dir/$session_id.jsonl"

    tmp_file="$(mktemp)"
    trap 'rm -f "$tmp_file"' EXIT
    echo "Downloading $gcs_uri ..." >&2
    gcloud storage cp "$gcs_uri" "$tmp_file"

    mkdir -p "$dest_dir"
    if [ -e "$dest_file" ]; then
      if cmp -s "$tmp_file" "$dest_file"; then
        echo "Already present and identical: $dest_file (no-op)" >&2
      else
        echo "Refusing to overwrite $dest_file: existing content differs from $gcs_uri." >&2
        exit 1
      fi
    else
      mv "$tmp_file" "$dest_file"
      echo "Saved transcript to $dest_file" >&2
    fi

    echo
    echo "cd $PWD && claude --resume $session_id"
    echo "# Caveat: cwd/file paths inside this transcript refer to the runner's checkout, not this one." >&2
    ;;
  *) usage ;;
esac
