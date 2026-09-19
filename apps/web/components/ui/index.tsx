"use client";

import { GuardedLink } from "@/components/unsaved-changes";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ApiError } from "@/lib/api-client";

export function NavLink({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // Exact match for the overview, prefix match elsewhere, so /tasks/abc still
  // highlights Tasks.
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <GuardedLink className="nav-link" href={href} aria-current={active ? "page" : undefined}>
      <Icon size={16} aria-hidden="true" />
      {children}
    </GuardedLink>
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

/** Content-agnostic shimmer placeholder -- stands in for a card, a table, a chart. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-block" aria-hidden="true">
      {Array.from({ length: lines }).map((_, index) => (
        <div
          key={index}
          className="skeleton-line"
          style={{ width: index === lines - 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}

export function Loading() {
  return (
    <div role="status">
      <span className="sr-only">Yükleniyor...</span>
      <Skeleton />
    </div>
  );
}

export function Empty({ children = "Kayıt yok." }: { children?: ReactNode }) {
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

/**
 * Loading, error and empty in one place, so no page reimplements the three.
 *
 * `data === null` is not the only shape of "nothing to show" -- a paginated
 * list answers a filter with no matches as a perfectly normal `{items: [],
 * total: 0}`, still a truthy object. Without `isEmpty`, that falls through to
 * `children`, which is why several pages ended up re-deriving their own
 * `items.length === 0` check beneath this one: pass the same check here
 * instead and let `empty` render it.
 */
export function AsyncSection<T>({
  state,
  children,
  empty,
  isEmpty,
}: {
  state: { data: T | null; error: ApiError | null; loading: boolean; reload?: () => void };
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
}) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) {
    return (
      <div className="stack-sm">
        <ErrorBox error={state.error} />
        {state.reload ? (
          <button className="btn" type="button" onClick={state.reload}>
            Tekrar dene
          </button>
        ) : null}
      </div>
    );
  }
  if (!state.data || (isEmpty && isEmpty(state.data))) return <Empty>{empty}</Empty>;
  return <>{children(state.data)}</>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {children ? <div className="row">{children}</div> : null}
    </div>
  );
}

/**
 * A destructive action behind a confirm dialog.
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
  onConfirm: () => void | Promise<unknown>;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
      setOpen(false);
    }
  }

  return (
    <>
      <button
        className="btn btn-sm"
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open ? (
        <ConfirmDialog
          question={question}
          pending={pending}
          onConfirm={() => void confirm()}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ConfirmDialog({
  question,
  pending,
  onConfirm,
  onCancel,
}: {
  question: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const trigger = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    cancelRef.current?.focus();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-describedby="confirm-dialog-question"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      onKeyDown={(event) => {
        // Native dialogs can tab into browser chrome; keep this decision in the UI.
        if (event.key !== "Tab") return;
        event.preventDefault();
        if (document.activeElement === cancelRef.current) confirmRef.current?.focus();
        else cancelRef.current?.focus();
      }}
    >
      <p id="confirm-dialog-question">{question}</p>
      <div className="row">
        <button
          ref={cancelRef}
          className="btn"
          type="button"
          disabled={pending}
          onClick={onCancel}
        >
          Vazgeç
        </button>
        <button
          ref={confirmRef}
          className="btn btn-primary"
          type="button"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "İşleniyor..." : "Onayla"}
        </button>
      </div>
    </dialog>
  );
}

/** The Düzenle / Sil pair that sits at the end of a list row. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
      {children}
    </div>
  );
}
