import type { ReactNode } from 'react';

import { ConsoleHeader, type ConsoleHeaderProps } from './console-header';
import { accentForNavKey } from './console-navigation';
import { ConsolePageShell } from './console-page-shell';

/**
 * The vertical half of the page elbow: the broad rail that turns through the
 * knee into the header's arm. It is pure frame. Its blocks carry no numbers
 * because a readout here would need data every route can supply honestly;
 * routes put their readouts inside the workspace instead. Hidden below 64em,
 * where the header draws the compact elbow on its own.
 */
function ConsoleRail() {
  return (
    <>
      <div className="lcars-rail-head">
        <span className="lcars-rail-brand">
          Agent
          <br />
          LCARS
        </span>
      </div>
      <div className="lcars-rail-body" aria-hidden="true">
        <span className="lcars-rail-block lcars-rail-block--short" />
        <span className="lcars-rail-block lcars-rail-block--medium" />
        <span className="lcars-rail-block lcars-rail-block--tall" />
        <span className="lcars-rail-block lcars-rail-block--fill" />
        <span className="lcars-rail-block lcars-rail-block--end" />
      </div>
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
      <main className="console-page-content">{children}</main>
      {footer ? <div className="console-page-footer">{footer}</div> : null}
    </ConsolePageShell>
  );
}
