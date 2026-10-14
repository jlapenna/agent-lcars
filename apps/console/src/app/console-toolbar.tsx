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
}: {
  name: string;
  label: string;
  value: string;
  /** A disabled option is drawn but cannot be chosen; `title` says why. */
  options: readonly {
    value: string;
    label: string;
    disabled?: boolean;
    title?: string;
  }[];
}) {
  const ref = useMarkFormHydrated<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className="console-toolbar__segmented"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <label key={option.value} title={option.title}>
          <input
            type="radio"
            name={name}
            value={option.value}
            disabled={option.disabled}
            defaultChecked={option.value === value}
            onChange={(event) => submitClosestForm(event.currentTarget)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

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
  return (
    <label className="console-toolbar__field console-toolbar__search">
      <span className="lcars-eyebrow">Find</span>
      <input
        type="search"
        name={name}
        aria-label={label}
        placeholder={placeholder}
        defaultValue={value}
      />
    </label>
  );
}
