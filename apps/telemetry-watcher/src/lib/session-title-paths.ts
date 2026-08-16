import * as path from 'path';

/**
 * Local state root shared by the two session-title channels, relative to the
 * writer's home directory. The deployed watcher bind-mounts exactly this
 * directory read-only (see `deploy/docker-compose.yml`) — it is deliberately
 * its own root rather than a subdirectory of an existing mount, because the
 * existing mounts are transcript trees whose contents are a privacy boundary,
 * and this one is the opposite: a small, purpose-built handoff the agent
 * writes and the watcher reads.
 */
export const SESSION_STATE_DIRECTORY = path.join(
  '.local',
  'state',
  'agent-lcars',
);

/**
 * Titles a person or an agent deliberately chose — `lcars session title
 * "..."`. Feeds the `declared` tier, which outranks everything else: it is
 * the only channel in the system that can be revised mid-session, so it is
 * the only one that can describe what a long session became rather than what
 * it started as.
 */
export const DECLARED_TITLE_SUBDIRECTORY = 'session-metadata';

/**
 * Titles imported from a runtime's own store — today Codex's `threads` table,
 * which the watcher container cannot read itself (that database is WAL-mode,
 * and a WAL reader must be able to write the `-shm` sidecar, so a read-only
 * bind mount of it fails outright). The import therefore runs on the host and
 * publishes here. Feeds the `generated` tier.
 *
 * Kept in its own directory rather than sharing the declared one so an
 * imported title and an agent-authored title for the same session are
 * distinct files. Sharing a path would make the two channels race to
 * overwrite each other, and the loser would be whichever wrote first —
 * silently, with no way to tell afterwards which tier the surviving file
 * came from.
 */
export const GENERATED_TITLE_SUBDIRECTORY = 'native-titles';

/**
 * What the agent says it is doing RIGHT NOW — `lcars session status
 * "<text>"` (issue #1257). Its own channel, separate from both title
 * channels above, for the same reason `GENERATED_TITLE_SUBDIRECTORY` is
 * separate from `DECLARED_TITLE_SUBDIRECTORY`: `lcars session status` would
 * otherwise need a read-modify-write against the same file `lcars session
 * title` writes, racing a concurrent title update. The directory
 * determines meaning so two writers never clobber each other — the repo
 * already settled this once when it split declared from generated; this is
 * the same reasoning applied a second time. Unlike the title channels,
 * status has no precedence tier of its own (there is only ever one status
 * source), so there is no third "status overlay" pair to read — just this
 * one directory.
 */
export const STATUS_SUBDIRECTORY = 'session-status';

/** Absolute path of one channel's directory beneath a resolved state root. */
export function sessionTitleChannelDirectory(
  stateDirectory: string,
  subdirectory:
    | typeof DECLARED_TITLE_SUBDIRECTORY
    | typeof GENERATED_TITLE_SUBDIRECTORY
    | typeof STATUS_SUBDIRECTORY,
): string {
  return path.join(stateDirectory, subdirectory);
}
