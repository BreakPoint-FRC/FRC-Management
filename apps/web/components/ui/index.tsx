"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import type { ApiError } from "@/lib/api-client";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  // Exact match for the overview, prefix match elsewhere, so /tasks/abc still
  // highlights Tasks.
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <Link className="nav-link" href={href} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}

export function Badge({
  tone = "off",
  children,
}: {
  tone?: "ok" | "warn" | "danger" | "off";
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="card">
      {title ? <p className="card-title">{title}</p> : null}
      {children}
    </div>
  );
}

export function Loading() {
  return <p className="loading">Yukleniyor...</p>;
}

export function Empty({ children = "Kayit yok." }: { children?: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/**
 * Shows what the API actually said.
 *
 * The messages are already written for a person -- "Bu grubun uyesi
 * degilsiniz", "Bu modul bu grup icin kapali" -- so a generic "something went
 * wrong" would be strictly less useful than the thing it replaced. Validation
 * failures carry per-field issues, listed underneath.
 */
export function ErrorBox({ error }: { error: ApiError }) {
  return (
    <div className="error-box">
      <strong>{error.message}</strong>
      {error.issues?.length ? (
        <ul>
          {error.issues.map((issue, index) => (
            <li key={index}>
              {issue.path.length ? `${issue.path.join(".")}: ` : ""}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Loading, error and empty in one place, so no page reimplements the three. */
export function AsyncSection<T>({
  state,
  children,
  empty,
}: {
  state: { data: T | null; error: ApiError | null; loading: boolean };
  children: (data: T) => ReactNode;
  empty?: ReactNode;
}) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} />;
  if (!state.data) return <Empty>{empty}</Empty>;
  return <>{children(state.data)}</>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
      <h1 style={{ margin: 0 }}>{title}</h1>
      {children ? <div className="row">{children}</div> : null}
    </div>
  );
}

/**
 * A destructive action behind a native confirm.
 *
 * window.confirm rather than a dialog component: it is one call, it cannot get
 * out of sync with the row it belongs to, and it is already accessible. Pulling
 * in a modal library to ask "are you sure" would be more machinery than the
 * question deserves.
 *
 * Several deletes in this API are refused by design -- a system role, a season
 * with records, a company with sponsorship history. Those come back as a 409
 * with a sentence explaining why, which the caller shows in its ErrorBox.
 */
export function ConfirmButton({
  question,
  onConfirm,
  disabled,
  children,
}: {
  question: string;
  onConfirm: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className="btn btn-sm"
      type="button"
      disabled={disabled}
      onClick={() => {
        if (window.confirm(question)) onConfirm();
      }}
    >
      {children}
    </button>
  );
}

/** The Duzenle / Sil pair that sits at the end of a list row. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
      {children}
    </div>
  );
}
