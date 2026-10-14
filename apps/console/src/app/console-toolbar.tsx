'use client';

import { type ReactNode, useEffect, useRef } from 'react';

/**
 * The workspace toolbar band's controls (design/fleet-console.html): a
 * repository and an agent select, a time-window segmented control, a FIND
 * search field, and the route's primary action at the trailing edge.
 *
 * Every control is a plain GET form control, so a choice works before
 * hydration and its state lives in the URL like every other console filter.
 * Routes render only the controls whose parameters they honour.
 */
export function ConsoleToolbar({
  action,
  preserve = {},
  children,
  primary,
}: {
  /** The route path the form submits to. */
  action: string;
  /** Other URL state to carry through a submission (e.g. `?sel=`). */
  preserve?: Record<string, string | undefined>;
  children?: ReactNode;
  /** The route's one primary action, docked to the trailing edge. */
  primary?: ReactNode;
}) {
  return (
    <div className="console-toolbar">
      <form
        method="get"
        action={action}
        className="console-toolbar__filters"
        role="search"
        aria-label="Filters"
      >
        {Object.entries(preserve).map(([name, value]) =>
          value === undefined ? null : (
            <input key={name} type="hidden" name={name} value={value} />
          ),
        )}
        {children}
      </form>
      {/* Outside the form: a route's action button never submits filters. */}
      {primary ? (
        <div className="console-toolbar__primary">{primary}</div>
      ) : null}
    </div>
  );
}

function submitClosestForm(element: HTMLElement) {
  element.closest('form')?.requestSubmit();
}

/** Marks the control's form as hydrated: from then on changes submit
 * themselves and the form's pre-hydration Apply button is hidden. */
function useMarkFormHydrated<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.closest('form')?.setAttribute('data-hydrated', '');
  }, []);
  return ref;
}

/** A native submit for the moments before hydration (or if it fails), when
 * the controls cannot submit on change; hidden once they can. */
export function ToolbarApply({ label = 'Apply' }: { label?: string }) {
  return (
    <button type="submit" className="console-toolbar__apply">
      {label}
    </button>
  );
}

export function ToolbarSelect({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value?: string;
  options: readonly { value: string; label: string }[];
}) {
  const ref = useMarkFormHydrated<HTMLSelectElement>();
  return (
    <select
      ref={ref}
      className="console-toolbar__field console-toolbar__select"
      name={name}
      aria-label={label}
      defaultValue={value ?? ''}
      onChange={(event) => submitClosestForm(event.currentTarget)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Radio inputs, not submit buttons: the checked window travels with every
 * submission, so Enter in the search field keeps it. */
export function ToolbarWindow({
  name,
  label,
  value,
  options,
  note,
}: {
  name: string;
  label: string;
  value: string;
  /** A disabled option is drawn but cannot be chosen. */
  options: readonly {
    value: string;
    label: string;
    disabled?: boolean;
  }[];
  /** Shown beside the control and describing it: why some windows are
   * disabled. Visible, because a disabled radio cannot take focus and a
   * title or hidden description reaches neither keyboard nor touch users. */
  note?: string;
}) {
  const ref = useMarkFormHydrated<HTMLDivElement>();
  const noteId = note ? `${name}-window-note` : undefined;
  return (
    <>
      <div
        ref={ref}
        className="console-toolbar__segmented"
        role="radiogroup"
        aria-label={label}
        aria-describedby={noteId}
      >
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              disabled={option.disabled}
              aria-describedby={option.disabled ? noteId : undefined}
              defaultChecked={option.value === value}
              onChange={(event) => submitClosestForm(event.currentTarget)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {note && (
        <span id={noteId} className="console-toolbar__note">
          {note}
        </span>
      )}
    </>
  );
}

/** Applies when its value is committed - Enter, the clear button, or focus
 * leaving the form - so FIND behaves like the selects and window beside it
 * rather than waiting for a separate Apply. Not per keystroke: each
 * application is a navigation. Moving to another control in the same form
 * (Work's principal field behind More filters) does not apply yet; that
 * control's own submission, or Enter, carries both values. */
export function ToolbarSearch({
  name,
  label,
  placeholder,
  value,
}: {
  name: string;
  label: string;
  placeholder: string;
  value?: string;
}) {
  const ref = useMarkFormHydrated<HTMLInputElement>();
  useEffect(() => {
    const input = ref.current;
    const form = input?.form;
    if (!input || !form) return;
    let applied = input.value;
    const onSubmit = () => {
      applied = input.value;
    };
    const commit = () => {
      if (input.value !== applied) form.requestSubmit();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && form.contains(next)) return;
      commit();
    };
    form.addEventListener('submit', onSubmit);
    input.addEventListener('focusout', onFocusOut);
    input.addEventListener('search', commit);
    return () => {
      form.removeEventListener('submit', onSubmit);
      input.removeEventListener('focusout', onFocusOut);
      input.removeEventListener('search', commit);
    };
  }, [ref]);
  return (
    <label className="console-toolbar__field console-toolbar__search">
      <span className="lcars-eyebrow">Find</span>
      <input
        ref={ref}
        type="search"
        name={name}
        aria-label={label}
        placeholder={placeholder}
        defaultValue={value}
      />
    </label>
  );
}
