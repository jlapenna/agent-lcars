'use client';

import { useEffect, useState } from 'react';

import type {
  EditDialogProps,
  SnoozeDialogProps,
} from './inbox-secondary-dialogs';

type Props = { returnFocus: HTMLElement | null } & (
  | { kind: 'edit'; options: EditDialogProps }
  | { kind: 'snooze'; options: SnoozeDialogProps }
);

/** Import the actual form only after activation. A failed secondary chunk
 * leaves the working primary action and the rest of the page available. */
export function DeferredInboxDialog(props: Props) {
  const [module, setModule] =
    useState<typeof import('./inbox-secondary-dialogs')>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const origin = props.returnFocus;
    return () => {
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
  }, [props.returnFocus]);
  useEffect(() => {
    let current = true;
    // eslint-disable-next-line no-restricted-syntax -- #2201 secondary forms are activated independently of the loaded primary confirmation.
    import('./inbox-secondary-dialogs').then(
      (loaded) => {
        if (current) setModule(loaded);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, []);
  if (module)
    return props.kind === 'edit' ? (
      <module.EditDialog {...props.options} />
    ) : (
      <module.SnoozeDialog {...props.options} />
    );
  return (
    <div role={failed ? 'alert' : 'status'}>
      {failed ? 'Options could not load.' : 'Loading options…'}{' '}
      {failed && (
        <button type="button" onClick={() => window.location.reload()}>
          Reload page
        </button>
      )}
      <button type="button" onClick={props.options.onClose}>
        Cancel
      </button>
    </div>
  );
}
