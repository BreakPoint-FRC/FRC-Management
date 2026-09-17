"use client";

import { useId, type FormEvent, type ReactNode } from "react";

import type { ApiError } from "@/lib/api-client";
import { isFormLevel } from "@/lib/issues";
import { ErrorBox } from "./index";

/**
 * A form that opens above the list it edits.
 *
 * Same page, no route, no modal: the list stays visible while you type, which
 * for a table of tasks is most of the context you need. Closing is a state
 * change in the page, so there is nothing to unmount or trap focus in.
 */
export function FormPanel({
  title,
  error,
  saving,
  submitLabel = "Kaydet",
  cancelLabel = "Vazgeç",
  onSubmit,
  onCancel,
  children,
}: {
  title: string;
  error: ApiError | null;
  saving: boolean;
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form
      className="card stack-sm"
      style={{ marginBottom: 16 }}
      aria-busy={saving}
      onSubmit={handleSubmit}
    >
      <p className="card-title">{title}</p>

      {/* Field-level messages render beside their inputs; only what has nowhere
          else to go is repeated here. */}
      {isFormLevel(error) && error ? <ErrorBox error={error} /> : null}

      {children}

      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? "Kaydediliyor..." : submitLabel}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={saving}>
          {cancelLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * The label/input/hint/error group every *Field component below wraps its
 * own input in.
 *
 * `id` is the same id the caller puts on its `<input>`/`<select>`/
 * `<textarea>` -- that is what makes `htmlFor` actually point at anything,
 * rather than a label that merely sits next to its control and does nothing
 * for a screen reader or a click on the label text.
 */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? (
        <span className="small muted" id={fieldHintId(id)}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field-error" id={fieldErrorId(id)} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function fieldHintId(id: string) {
  return `${id}-hint`;
}

function fieldErrorId(id: string) {
  return `${id}-error`;
}

/** What an input's own aria-describedby should read, given its Field's hint/error. */
function describedBy(id: string, hint: string | undefined, error: string | undefined) {
  const ids = [hint ? fieldHintId(id) : null, error ? fieldErrorId(id) : null].filter(
    (value): value is string => value !== null
  );
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  type = "text",
  required,
  disabled,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  inputMode?: "decimal" | "text";
  placeholder?: string;
}) {
  const id = useId();

  return (
    <Field id={id} label={label} error={error} hint={hint}>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
        {...rest}
      />
    </Field>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  error,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  rows?: number;
}) {
  const id = useId();

  return (
    <Field id={id} label={label} error={error}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  hint,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  error?: string;
  hint?: string;
  /** Shown as the empty option. Omit to make the select required in practice. */
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();

  return (
    <Field id={id} label={label} error={error} hint={hint}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="row small" style={{ gap: 6 }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={disabled ? "muted" : undefined}>{label}</span>
      {hint ? <span className="muted">{hint}</span> : null}
    </label>
  );
}

/** Turns an enum label map into select options. */
export function optionsFrom(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
