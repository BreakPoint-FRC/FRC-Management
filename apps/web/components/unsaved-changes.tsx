"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo,
  useRef, useState, type ComponentProps, type MutableRefObject, type ReactNode,
} from "react";

interface Guard {
  dirty: boolean;
  saving: boolean;
  discard: () => void;
}
interface GuardContext {
  register: (guard: MutableRefObject<Guard>) => () => void;
  requestLeave: (action: () => void) => void;
}
const Context = createContext<GuardContext | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const guard = useRef<MutableRefObject<Guard> | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);

  const register = useCallback((next: MutableRefObject<Guard>) => {
    guard.current = next;
    return () => {
      if (guard.current !== next) return;
      guard.current = null;
      pending.current = null;
      setOpen(false);
    };
  }, []);

  const requestLeave = useCallback((action: () => void) => {
    if (guard.current?.current.saving || pending.current) return;
    if (!guard.current?.current.dirty) {
      action();
      return;
    }
    pending.current = action;
    setOpen(true);
  }, []);

  function resolve(discard: boolean) {
    const action = pending.current;
    pending.current = null;
    setOpen(false);
    if (!discard || !action) return;
    const current = guard.current?.current;
    if (current) {
      current.dirty = false;
      current.discard();
    }
    action();
  }

  const value = useMemo(() => ({ register, requestLeave }), [register, requestLeave]);
  return (
    <Context.Provider value={value}>
      {children}
      {open ? <DiscardDialog onResolve={resolve} /> : null}
    </Context.Provider>
  );
}

function DiscardDialog({ onResolve }: { onResolve: (discard: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const leave = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    stay.current?.focus();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="unsaved-dialog"
      aria-labelledby="unsaved-title"
      aria-describedby="unsaved-description"
      onCancel={(event) => { event.preventDefault(); onResolve(false); }}
      onKeyDown={(event) => {
        // Native dialogs can tab into browser chrome; keep this decision in the UI.
        if (event.key !== "Tab") return;
        event.preventDefault();
        if (document.activeElement === stay.current) leave.current?.focus();
        else stay.current?.focus();
      }}
    >
      <h2 id="unsaved-title">Kaydedilmemiş değişiklikler</h2>
      <p id="unsaved-description">
        Kaydedilmemiş değişiklikleriniz var. Ayrılırsanız bu değişiklikler kaybolacak.
      </p>
      <div className="row">
        <button ref={stay} className="btn" type="button" onClick={() => onResolve(false)}>
          Düzenlemeye devam et
        </button>
        <button ref={leave} className="btn btn-primary" type="button" onClick={() => onResolve(true)}>
          Değişiklikleri sil ve devam et
        </button>
      </div>
    </dialog>
  );
}

export function useLeaveGuard() {
  const value = useContext(Context);
  if (!value) throw new Error("useLeaveGuard requires UnsavedChangesProvider");
  return value;
}

/** One active editor registers with the dashboard; refs also cover the save/commit gap. */
export function useUnsavedChanges(state: Guard) {
  const { register, requestLeave } = useLeaveGuard();
  const current = useRef(state);
  useLayoutEffect(() => { current.current = state; });
  useLayoutEffect(() => register(current), [register]);

  useEffect(() => {
    if (!state.dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!current.current.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [state.dirty]);

  return {
    requestLeave,
    markClean: () => { current.current.dirty = false; },
    setSaving: (saving: boolean) => { current.current.saving = saving; },
    isSaving: () => current.current.saving,
  };
}

/** Preserve Next Link behavior for clean forms and new-tab/download gestures. */
export function GuardedLink({ href, onClick, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const { requestLeave } = useLeaveGuard();
  const router = useRouter();
  return <Link {...props} href={href} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
      event.shiftKey || event.altKey || (props.target && props.target !== "_self") || props.download) return;
    const target = new URL(href, window.location.href);
    if (target.href === window.location.href) return;
    event.preventDefault();
    requestLeave(() => {
      if (target.origin !== window.location.origin) window.location.assign(target.href);
      else if (props.replace) router.replace(href, { scroll: props.scroll });
      else router.push(href, { scroll: props.scroll });
    });
  }} />;
}
