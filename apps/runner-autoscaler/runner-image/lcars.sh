#!/usr/bin/env bash
# The `lcars` launcher (agent-lcars#1289), installed onto PATH as
# `/usr/local/bin/lcars` -- see the Dockerfile's own comment at its COPY
# site for why a dispatched agent needs this at all.
#
# Mirrors the host watcher's own launcher
# (apps/telemetry-watcher/deploy/install-session-title-cli.sh, issue #1212)
# in shape and in why it exists: `lcars-session-title.cjs` (built by the
# `session-title-cli` Nx target from
# apps/telemetry-watcher/src/session-title-cli.ts) is a CommonJS bundle, not
# a self-executing binary, so something has to put `node` in front of it.
# Naming genuinely does not matter past this launcher itself:
# `executeSessionTitleAnnotationCommand` (the function this bundle's
# `main()` calls, in
# apps/telemetry-watcher/src/lib/session-title-annotation-command.ts) reads
# only `process.argv.slice(2)`. Node already strips the interpreter path
# (argv[0]) and the script path (argv[1]) before user code ever sees argv,
# so neither this launcher's filename nor the bundle's own carries any
# meaning to the command parser -- the ONLY thing that makes `session
# status "..."` the command surface a dispatched agent runs is that this
# file is installed as `lcars`, matching what
# `.agents/skills/lcars-session-updates` already tells every agent to type.
#
# Node resolution deliberately does NOT mirror the host launcher's fnm
# fallback dance: that complexity exists because the host's Node is
# fnm-managed and fnm's shim directory isn't guaranteed to be on every
# caller's PATH. This image installs Node from NodeSource's apt repository
# instead (see the Dockerfile's main RUN block) -- a normal system package
# at a fixed location already on PATH for every user, root or `runner` --
# the same "just call node" assumption sidecar-lifecycle.sh already makes
# for sidecar.cjs. A bare `exec node` is the correct match for THIS image,
# not a missed opportunity to copy the host script verbatim.
exec node /usr/local/lib/agent-lcars/lcars-session-title.cjs "$@"
