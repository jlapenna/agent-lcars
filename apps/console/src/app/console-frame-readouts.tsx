'use client';

import { useEffect, useState } from 'react';

import { useConsoleNavigationKeys } from './console-navigation-context';
import {
  compactNumber,
  stardate,
  useLiveState,
  useMinuteClock,
  useShellReadouts,
} from './console-shell-state';
import { formatCompactRelativeTime } from './format';

const UNAVAILABLE = '—';

/**
 * The rail's readout blocks (design/fleet-console.html): fleet online, queue
 * depth, tokens and merges over the last day, and the date. The same figures
 * on every route. Maintainer data only; other sessions see the frame alone.
 */
/** The rail's figures, shared by the rail and its narrow-screen strip. */
function useRailFigures() {
  const state = useShellReadouts();
  const now = useMinuteClock();
  const readouts = state.status === 'ready' ? state.readouts : undefined;
  // Only maintainers get figures. The root layout gives them, and only them,
  // the full navigation, so that is known from the first render, before the
  // readouts arrive or when their read fails.
  const maintainer = useConsoleNavigationKeys() === undefined;
  // Loading, or a session without maintainer data: frame only. A failed
  // read, or a missing figure for a maintainer: an explicit unavailable mark.
  const shown =
    maintainer &&
    (state.status === 'unavailable' ||
      (readouts?.user.grants.includes('admin') ?? false));
  const value = (figure: string | undefined) =>
    shown ? (figure ?? UNAVAILABLE) : undefined;

  const fleet = readouts?.fleet;
  const blocks = [
    {
      key: 'fleet',
      modifier: 'short',
      label: 'Fleet online',
      value: value(
        fleet?.online === undefined
          ? undefined
          : fleet.capacity === undefined
            ? String(fleet.online)
            : `${fleet.online}/${fleet.capacity}`,
      ),
    },
    {
      key: 'queue',
      modifier: 'medium',
      label: 'Queue depth',
      value: value(
        readouts?.queueDepth === undefined
          ? undefined
          : String(readouts.queueDepth).padStart(2, '0'),
      ),
    },
    {
      key: 'tokens',
      modifier: 'tall',
      label: 'Tokens · 24h sessions',
      value: value(
        readouts?.tokens24h === undefined
          ? undefined
          : `${compactNumber(readouts.tokens24h)}${readouts.tokens24hPartial ? '+' : ''}`,
      ),
    },
    {
      key: 'merged',
      modifier: 'fill',
      label: 'Merged · 24h',
      value: value(
        readouts?.merged24h === undefined
          ? undefined
          : `${readouts.merged24h}${readouts.merged24hPartial ? '+' : ''}`,
      ),
    },
  ];

  return { blocks, now, maintainer };
}

export function RailReadouts() {
  const { blocks, now } = useRailFigures();
  return (
    <div className="lcars-rail-body" aria-label="Fleet readouts" role="group">
      {blocks.map((block) => (
        <div
          key={block.key}
          className={`lcars-rail-block lcars-rail-block--${block.modifier}`}
          data-testid={`rail-readout-${block.key}`}
        >
          {block.value !== undefined ? (
            <>
              <b>{block.value}</b>
              <span>{block.label}</span>
            </>
          ) : null}
        </div>
      ))}
      <div className="lcars-rail-block lcars-rail-block--end">
        {now ? <b>{stardate(now)}</b> : null}
      </div>
    </div>
  );
}

/** Short labels so the strip fits a phone line; the rail's own read in full. */
const STRIP_LABELS: Record<string, string> = {
  fleet: 'fleet',
  queue: 'queue',
  tokens: 'tokens 24h',
  merged: 'merged 24h',
};

/** Below 64em the rail is hidden, so its readouts ride a line under the
 * header: the date and the same figures, short-labelled, wrapping rather
 * than clipping on the narrowest phones. */
export function ReadoutStrip() {
  const { blocks, now, maintainer } = useRailFigures();
  // The date and figures arrive after mount, so the strip reserves the lines
  // they fill (global.css) rather than pushing the page down twice.
  return (
    <div
      className="lcars-readout-strip"
      aria-label="Fleet readouts, compact"
      role="group"
      data-figures={maintainer ? '' : undefined}
    >
      {now ? (
        <span className="lcars-readout-strip__date">{stardate(now)}</span>
      ) : null}
      {blocks.map((block) =>
        block.value !== undefined ? (
          <span key={block.key} data-testid={`strip-readout-${block.key}`}>
            <b>{block.value}</b> {STRIP_LABELS[block.key] ?? block.label}
          </span>
        ) : null,
      )}
    </div>
  );
}

/** The signed-in identity as a line of the console menu: where narrow
 * headers, which drop the identity block, still say who is signed in. */
export function MenuIdentity() {
  const state = useShellReadouts();
  if (state.status !== 'ready') return null;
  const { user } = state.readouts;
  return (
    <div className="console-menu-identity" data-testid="console-identity-menu">
      <span className="console-identity__avatar" aria-hidden="true">
        {user.initials}
      </span>
      <span>
        {user.login}
        {user.grants.length > 0 ? (
          <span className="console-identity__grants">
            {' '}
            {user.grants.join(' · ')}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** The rail head's environment line: the host this console serves. */
export function RailEnvironment() {
  const state = useShellReadouts();
  const environment =
    state.status === 'ready' ? state.readouts.environment : undefined;
  // The line is held from first paint: the head sits on its bottom edge, so
  // a line arriving with the readouts lifted the brand above it.
  return (
    <span className="lcars-rail-code" data-testid="rail-environment">
      {environment ?? '\u00a0'}
    </span>
  );
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour12: false });
}

/** "■ LIVE · synced 14:32:08" for routes with a live stream; otherwise the
 * time the page was loaded, labelled as a snapshot. */
export function ConsoleLiveStatus({
  dataAt,
  compact = false,
}: {
  dataAt?: string;
  /** One line under the title where the header's sync block does not fit
   * (below 80em): the same status, without the refresh hint. */
  compact?: boolean;
} = {}) {
  const live = useLiveState();
  // The page's own load time, captured once: a snapshot does not advance.
  const [loadedAt, setLoadedAt] = useState<number>();
  useEffect(() => setLoadedAt(Date.now()), []);
  // A snapshot served from cached sources says how old its data is, not when
  // the page loaded. Formatted after mount: relative time differs between the
  // server render and hydration.
  // The minute clock re-reads the age, as the rail's figures do.
  const now = useMinuteClock();
  const [dataAge, setDataAge] = useState<string>();
  useEffect(() => {
    if (dataAt && now) setDataAge(formatCompactRelativeTime(dataAt));
  }, [dataAt, now]);
  const mode = live?.mode;
  const tone =
    mode === 'live' || mode === 'updating'
      ? 'ok'
      : mode === undefined
        ? 'idle'
        : 'warn';
  const headline =
    mode === undefined
      ? 'Snapshot'
      : mode === 'live'
        ? 'Live'
        : mode === 'updating'
          ? 'Updating'
          : mode === 'connecting'
            ? 'Connecting'
            : 'Degraded';
  // A live route shows a sync time only after a sync actually happened.
  const at = mode === undefined ? loadedAt : live?.syncedAt;
  return (
    <div
      className={
        compact
          ? 'console-live-status console-live-status--compact'
          : 'console-live-status'
      }
      data-tone={tone}
      data-testid={
        compact ? 'console-live-status-compact' : 'console-live-status'
      }
      title={live?.label}
    >
      <b>■ {headline}</b>
      {mode === undefined && dataAge !== undefined ? (
        <span>
          {' · '}data {dataAge}
        </span>
      ) : at !== undefined ? (
        <span>
          {' · '}
          {mode === undefined ? 'loaded' : 'synced'} {clockTime(at)}
        </span>
      ) : null}
      {compact ? null : (
        <>
          <br />
          <span>
            {mode === undefined ? 'refresh to update' : 'auto-refresh 5 s'}
          </span>
        </>
      )}
    </div>
  );
}

/** Avatar initials, login and grants for the signed-in session. */
export function ConsoleIdentity() {
  const state = useShellReadouts();
  if (state.status !== 'ready') return null;
  const { user } = state.readouts;
  return (
    <div className="console-identity" data-testid="console-identity">
      <span className="console-identity__avatar" aria-hidden="true">
        {user.initials}
      </span>
      <span className="console-identity__text">
        <span className="console-identity__login">{user.login}</span>
        {user.grants.length > 0 ? (
          <span className="console-identity__grants">
            {user.grants.join(' · ')}
          </span>
        ) : null}
      </span>
    </div>
  );
}
