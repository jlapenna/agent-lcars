'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

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
  // Phones keep FIND, the window and the primary action in view and fold the
  // selects and More filters behind one toggle, so the band does not fill the
  // first screen. The toggle names how many folded filters narrow the view,
  // so a filtered page never looks unfiltered.
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    // What the fold hides: the selects and More filters' fields.
    setActive(
      [
        ...form.querySelectorAll<HTMLSelectElement>(':scope > select'),
        ...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          '.console-toolbar__more :is(select, input:not([type=hidden]))',
        ),
      ].filter((field) => field.value).length,
    );
  }, []);
  return (
    <div className="console-toolbar">
      <form
        ref={formRef}
        method="get"
        action={action}
        className="console-toolbar__filters"
        role="search"
        aria-label="Filters"
        data-open={open ? '' : undefined}
      >
        <button
          type="button"
          className="console-toolbar__field console-toolbar__toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {active > 0 ? `Filters · ${active}` : 'Filters'}
        </button>
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

/** The form's filters as one comparable string. */
function formState(form: HTMLFormElement): string {
  return new URLSearchParams(
    [...new FormData(form)].map(([key, value]) => [key, String(value)]),
  ).toString();
}

/** Applies when its value is committed - Enter, the clear button, or focus
 * leaving the filters for no other control - so FIND behaves like the
 * selects and window beside it rather than waiting for a separate Apply. Not
 * per keystroke: each application is a navigation. Moving among the form's
 * own fields (Work's principal behind More filters) waits, and leaving to
 * another action (New work, a link) lets that action run instead of racing it
 * with a reload; Enter still applies. */
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
    let applied = formState(form);
    const onSubmit = () => {
      applied = formState(form);
    };
    const commit = () => {
      if (formState(form) !== applied) form.requestSubmit();
    };
    const onFocusOut = (event: FocusEvent) => {
      // Null: focus went to the page itself, not to another control.
      if (event.relatedTarget === null) commit();
    };
    form.addEventListener('submit', onSubmit);
    form.addEventListener('focusout', onFocusOut);
    input.addEventListener('search', commit);
    return () => {
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener('focusout', onFocusOut);
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
