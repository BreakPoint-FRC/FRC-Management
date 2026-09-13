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
  savingChanged: (saving: boolean) => void;
}

interface HistoryMark {
  session: string;
  position: number;
}

type PendingLeave =
  | { kind: "action"; action: () => void }
  | {
      kind: "traversal";
      source: HistoryMark;
      target: HistoryMark;
      delta: number;
      promptAfterRestore: boolean;
    };

type TraversalPhase = "idle" | "restoring" | "prompting" | "replaying";

const HISTORY_MARK = "__breakpointHistory";

function readHistoryMark(state: unknown): HistoryMark | null {
  if (!state || typeof state !== "object") return null;
  const mark = (state as Record<string, unknown>)[HISTORY_MARK];
  if (!mark || typeof mark !== "object") return null;

  const { session, position } = mark as Record<string, unknown>;
  if (typeof session !== "string" || !Number.isSafeInteger(position)) return null;
  return { session, position: position as number };
}

function withHistoryMark(state: unknown, mark: HistoryMark): Record<string, unknown> {
  // Next keeps its App Router tree in history.state. Always copy that state;
  // replacing it would turn a normal Back operation into a full reload.
  const preserved = state && typeof state === "object" && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {};
  return { ...preserved, [HISTORY_MARK]: mark };
}

const Context = createContext<GuardContext | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const guard = useRef<MutableRefObject<Guard> | null>(null);
  const pending = useRef<PendingLeave | null>(null);
  const phase = useRef<TraversalPhase>("idle");
  const currentHistory = useRef<HistoryMark | null>(null);
  const [open, setOpen] = useState(false);
  const [savingBlocked, setSavingBlocked] = useState(false);

  const register = useCallback((next: MutableRefObject<Guard>) => {
    guard.current = next;
    return () => {
      if (guard.current !== next) return;
      guard.current = null;
      pending.current = null;
      phase.current = "idle";
      setOpen(false);
      setSavingBlocked(false);
    };
  }, []);

  const requestLeave = useCallback((action: () => void) => {
    if (pending.current) return;
    if (guard.current?.current.saving) {
      setSavingBlocked(true);
      return;
    }
    if (!guard.current?.current.dirty) {
      action();
      return;
    }
    pending.current = { kind: "action", action };
    setOpen(true);
  }, []);

  const savingChanged = useCallback((saving: boolean) => {
    if (!saving) setSavingBlocked(false);
  }, []);

  function resolve(discard: boolean) {
    const leave = pending.current;
    // A second browser traversal can briefly close the dialog while the
    // history cursor is returned to its source. Ignore a click from that
    // transition instead of replaying from the wrong entry.
    if (leave?.kind === "traversal" && phase.current !== "prompting") {
      setOpen(false);
      return;
    }
    setOpen(false);
    if (!leave) return;
    if (!discard) {
      pending.current = null;
      phase.current = "idle";
      return;
    }

    const current = guard.current?.current;
    if (current) {
      current.dirty = false;
      current.discard();
    }

    if (leave.kind === "action") {
      pending.current = null;
      phase.current = "idle";
      leave.action();
      return;
    }

    // Replay the exact traversal the browser originally requested. history.go
    // preserves both stacks; router.push would create a duplicate and destroy
    // a Forward destination.
    phase.current = "replaying";
    window.history.go(leave.delta);
  }

  useLayoutEffect(() => {
    // Register before App Router's passive popstate listener. popstate is not
    // cancelable, so ordering is what lets stopImmediatePropagation keep the
    // dirty page mounted while its history cursor is restored.
    const history = window.history;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const existing = readHistoryMark(history.state);
    const session = existing?.session ??
      (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    const initial = existing ?? { session, position: 0 };
    currentHistory.current = initial;

    originalReplaceState.call(
      history,
      withHistoryMark(history.state, initial),
      "",
      window.location.href
    );

    const trackedPushState: History["pushState"] = function (
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null
    ) {
      const current = currentHistory.current ?? { session, position: 0 };
      const next = { session, position: current.position + 1 };
      originalPushState.call(this, withHistoryMark(data, next), unused, url);
      currentHistory.current = next;
    };

    const trackedReplaceState: History["replaceState"] = function (
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null
    ) {
      const current = currentHistory.current ?? { session, position: 0 };
      originalReplaceState.call(this, withHistoryMark(data, current), unused, url);
    };

    history.pushState = trackedPushState;
    history.replaceState = trackedReplaceState;

    function goToPosition(from: HistoryMark, to: HistoryMark) {
      const delta = to.position - from.position;
      if (delta !== 0) window.history.go(delta);
    }

    function restoreSource(leave: Extract<PendingLeave, { kind: "traversal" }>) {
      phase.current = "restoring";
      goToPosition(leave.target, leave.source);
    }

    function onPopState(event: PopStateEvent) {
      const target = readHistoryMark(event.state);
      const leave = pending.current;

      if (phase.current === "replaying" && leave?.kind === "traversal") {
        if (target?.session === leave.target.session &&
            target.position === leave.target.position) {
          currentHistory.current = leave.target;
          phase.current = "idle";
          pending.current = null;
          // This is the user's confirmed traversal. Let Next consume it.
          return;
        }

        // An extra traversal raced the confirmed replay. Keep Next mounted and
        // finish at the target the user actually approved.
        event.stopImmediatePropagation();
        if (target?.session === leave.target.session) {
          goToPosition(target, leave.target);
        }
        return;
      }

      if (phase.current === "prompting" && leave?.kind === "traversal") {
        event.stopImmediatePropagation();
        setOpen(false);
        if (target?.session === leave.source.session) {
          phase.current = "restoring";
          goToPosition(target, leave.source);
        }
        return;
      }

      if (phase.current === "restoring" && leave?.kind === "traversal") {
        event.stopImmediatePropagation();
        if (target?.session === leave.source.session &&
            target.position === leave.source.position) {
          currentHistory.current = leave.source;
          if (leave.promptAfterRestore && guard.current?.current.dirty &&
              !guard.current.current.saving) {
            phase.current = "prompting";
            setOpen(true);
          } else {
            phase.current = "idle";
            pending.current = null;
          }
        } else if (target?.session === leave.source.session) {
          // Repeated browser controls may move the cursor again before the
          // first rollback settles. Always converge on the original source.
          goToPosition(target, leave.source);
        }
        return;
      }

      const source = currentHistory.current;
      const active = guard.current?.current;

      // Entries from before this document/provider cannot be indexed safely.
      // A cross-document traversal is still protected by beforeunload.
      if (!source || !target || source.session !== target.session) {
        if (target) currentHistory.current = target;
        return;
      }

      const delta = target.position - source.position;
      if (!active?.dirty || delta === 0) {
        currentHistory.current = target;
        return;
      }

      event.stopImmediatePropagation();
      if (active.saving) setSavingBlocked(true);
      const traversal: Extract<PendingLeave, { kind: "traversal" }> = {
        kind: "traversal",
        source,
        target,
        delta,
        // Saving uses the same rollback but deliberately does not open a
        // second decision while the request is in flight.
        promptAfterRestore: !active.saving,
      };
      pending.current = traversal;
      restoreSource(traversal);
    }

    window.addEventListener("popstate", onPopState, { capture: true });
    return () => {
      window.removeEventListener("popstate", onPopState, { capture: true });
      if (history.pushState === trackedPushState) history.pushState = originalPushState;
      if (history.replaceState === trackedReplaceState) history.replaceState = originalReplaceState;
    };
  }, []);

  const value = useMemo(
    () => ({ register, requestLeave, savingChanged }),
    [register, requestLeave, savingChanged]
  );
  return (
    <Context.Provider value={value}>
      {children}
      {savingBlocked ? (
        <p className="saving-leave-status" role="status" aria-live="polite" aria-atomic="true">
          Toplantı kaydediliyor. Sayfadan ayrılmak için kayıt işleminin tamamlanmasını bekleyin.
        </p>
      ) : null}
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

/** One active editor registers with the app-level guard; refs also cover the save/commit gap. */
export function useUnsavedChanges(state: Guard) {
  const { register, requestLeave, savingChanged } = useLeaveGuard();
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
    setSaving: (saving: boolean) => {
      current.current.saving = saving;
      savingChanged(saving);
    },
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
