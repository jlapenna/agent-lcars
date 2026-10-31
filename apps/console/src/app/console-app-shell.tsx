import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  RailEnvironment,
  RailReadouts,
  ReadoutStrip,
} from './console-frame-readouts';
import { ConsoleHeader, type ConsoleHeaderProps } from './console-header';
import { accentForNavKey } from './console-navigation';
import { ConsolePageShell } from './console-page-shell';

/**
 * The vertical half of the page elbow: the broad rail that turns through the
 * knee into the header's arm. Its head carries the brand and environment and
 * its blocks carry the fleet readouts (console-frame-readouts.tsx). Hidden
 * below 64em, where the header draws the compact elbow on its own.
 */
function ConsoleRail() {
  return (
    <>
      <div className="lcars-rail-head">
        <Link href="/" className="lcars-rail-home" data-testid="rail-home">
          <span className="lcars-rail-brand">
            Agent
            <br />
            LCARS
          </span>
          <RailEnvironment />
        </Link>
      </div>
      <RailReadouts />
    </>
  );
}

export type ConsoleAppShellProps = ConsoleHeaderProps & {
  className?: string;
  children: ReactNode;
  /** Route-specific controls that belong below the main page content. */
  footer?: ReactNode;
};

/**
 * The complete structural frame for every authenticated console route.
 *
 * This intentionally remains a Server Component: pages can stream their data
 * through `children` without making the page frame or data loading depend on
 * browser state. `ConsoleHeader` keeps its own small client boundary for the
 * interactive navigation controls.
 */
export function ConsoleAppShell({
  className,
  children,
  footer,
  ...header
}: ConsoleAppShellProps) {
  return (
    <ConsolePageShell
      className={className}
      route={header.current}
      accent={accentForNavKey(header.current)}
      framed={!header.hideHeader}
      streamingFallback={header.streamingFallback}
    >
      {header.hideHeader ? null : <ConsoleRail />}
      <ConsoleHeader {...header} />
      {header.hideHeader ? null : <ReadoutStrip />}
      <main className="console-page-content">{children}</main>
      {footer ? <div className="console-page-footer">{footer}</div> : null}
    </ConsolePageShell>
  );
}
