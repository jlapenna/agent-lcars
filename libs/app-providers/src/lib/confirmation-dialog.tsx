'use client';

import { Button, CloseButton, Group } from '@mantine/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import styles from './confirmation-dialog.module.css';

interface ConfirmationOptions {
  title: string;
  children: ReactNode;
  labels: { confirm: string; cancel: string };
  confirmProps?: { color?: string };
  onConfirm: () => void;
}

const ConfirmationContext = createContext<
  (options: ConfirmationOptions) => string
>(() => {
  throw new Error('ConfirmationDialogProvider is missing');
});

export function useConfirmationDialog() {
  return useContext(ConfirmationContext);
}

/** A menu item disappears as its action opens a form. Retain the real menu
 * trigger, rather than that soon-detached item, for both slow-load cancellation
 * and the loaded dialog's eventual close. */
export function dialogReturnTarget(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const menu = active.closest('[role="menu"]');
  const triggerId = menu?.getAttribute('aria-labelledby');
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  return trigger instanceof HTMLElement ? trigger : active;
}

/** Keep the destructive confirmation available synchronously with the primary
 * handler. The provider remains above routes, as the previous global host did;
 * closed secondary form and floating-control modules can load independently. */
export function ConfirmationDialogProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [confirmation, setConfirmation] = useState<{
    id: string;
    options: ConfirmationOptions;
    returnFocus: HTMLElement | null;
  }>();
  const sequence = useRef(0);
  const backdropPress = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const descriptionId = useId();
  const open = useCallback((options: ConfirmationOptions) => {
    const id = String(++sequence.current);
    setConfirmation({
      id,
      options,
      returnFocus: dialogReturnTarget(),
    });
    return id;
  }, []);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!confirmation || !node) return;
    const previous = confirmation.returnFocus;
    const overflow = document.body.style.overflow;
    const paddingRight = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbar > 0)
      document.body.style.paddingRight = `${parseFloat(getComputedStyle(document.body).paddingRight) + scrollbar}px`;
    document.body.style.overflow = 'hidden';
    node.showModal();
    return () => {
      node.close();
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [confirmation]);

  const close = () => setConfirmation(undefined);
  return (
    <ConfirmationContext value={open}>
      {children}
      {confirmation && (
        <dialog
          key={confirmation.id}
          ref={dialog}
          className={styles.dialog}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            if (
              event.shiftKey &&
              document.activeElement === closeButton.current
            ) {
              event.preventDefault();
              confirmButton.current?.focus();
            } else if (
              !event.shiftKey &&
              document.activeElement === confirmButton.current
            ) {
              event.preventDefault();
              closeButton.current?.focus();
            }
          }}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onPointerDown={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            backdropPress.current =
              event.target === event.currentTarget &&
              (event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom);
          }}
          onClick={(event) => {
            if (!backdropPress.current || event.target !== event.currentTarget)
              return;
            backdropPress.current = false;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              close();
          }}
        >
          <div className={styles.header}>
            <h2 id={labelId} className={styles.title}>
              {confirmation.options.title}
            </h2>
            <CloseButton
              ref={closeButton}
              aria-label="Close modal"
              onClick={close}
              autoFocus
            />
          </div>
          <div className={styles.body}>
            <div id={descriptionId}>{confirmation.options.children}</div>
            <Group justify="flex-end" mt="md">
              <Button variant="default" onClick={close}>
                {confirmation.options.labels.cancel}
              </Button>
              <Button
                {...confirmation.options.confirmProps}
                ref={confirmButton}
                onClick={() => {
                  confirmation.options.onConfirm();
                  close();
                }}
              >
                {confirmation.options.labels.confirm}
              </Button>
            </Group>
          </div>
        </dialog>
      )}
    </ConfirmationContext>
  );
}
