"use client";

import type { FormEvent, ReactNode } from "react";

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
  onSubmit,
  onCancel,
  children,
}: {
  title: string;
  error: ApiError | null;
  saving: boolean;
  submitLabel?: string;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form className="card stack-sm" style={{ marginBottom: 16 }} onSubmit={handleSubmit}>
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
          Vazgec
        </button>
      </div>
    </form>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <span className="small muted">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </div>
  );
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
  return (
    <Field label={label} error={error} hint={hint}>
      <input
        type={type}
        value={value}
        required={required}
        disabled={disabled}
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
  return (
    <Field label={label} error={error}>
      <textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
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
  return (
    <Field label={label} error={error} hint={hint}>
      <select
        value={value}
        disabled={disabled}
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
