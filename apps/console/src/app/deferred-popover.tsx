'use client';

import { type ComponentType, useEffect, useRef, useState } from 'react';

import type { DeferredSurfaceProps } from './deferred-surface-props';

/** Closed secondary controls need their button, not Floating UI or a focus
 * trap. Load the existing Mantine surface on activation and keep it mounted
 * afterward so drafts, keyboard navigation and focus return stay intact. */
function DeferredSurface(props: DeferredSurfaceProps) {
  const { target, opened, onChange, kind } = props;
  const [loaded, setLoaded] = useState<{
    Surface: ComponentType<DeferredSurfaceProps>;
    focusOnMount: boolean;
  }>();
  const [error, setError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!opened || loaded) return;
    let current = true;
    setError(false);
    // eslint-disable-next-line no-restricted-syntax -- #2201 load floating menus only after their visible trigger is activated.
    import('./deferred-popover-surface').then(
      ({ DeferredPopoverSurface }) => {
        if (current)
          setLoaded({
            Surface: DeferredPopoverSurface,
            focusOnMount: document.activeElement === trigger.current,
          });
      },
      () => {
        if (!current) return;
        setError(true);
        onChange(false);
      },
    );
    return () => {
      current = false;
    };
  }, [opened, loaded, onChange]);

  if (loaded)
    return <loaded.Surface {...props} focusOnMount={loaded.focusOnMount} />;

  return (
    <>
      {target({
        ref: trigger,
        'aria-haspopup': kind === 'menu' ? 'menu' : 'dialog',
        'aria-expanded': false,
        'aria-busy': opened || undefined,
        onClick: (event) => {
          if (!event.defaultPrevented) onChange(!opened);
        },
        onKeyDown: (event) => {
          if (event.defaultPrevented) return;
          if (event.key === 'Escape') onChange(false);
          if (
            kind === 'menu' &&
            (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          ) {
            event.preventDefault();
            onChange(true);
          }
        },
      })}
      {error && (
        <span role="alert">
          Options could not load.{' '}
          <button type="button" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </span>
      )}
    </>
  );
}

export function DeferredMenu(
  props: Omit<DeferredSurfaceProps, 'kind' | 'opened' | 'onChange'>,
) {
  const [opened, setOpened] = useState(false);
  return (
    <DeferredSurface
      {...props}
      kind="menu"
      opened={opened}
      onChange={setOpened}
    />
  );
}

export function DeferredPopover(props: Omit<DeferredSurfaceProps, 'kind'>) {
  return <DeferredSurface {...props} kind="popover" />;
}
