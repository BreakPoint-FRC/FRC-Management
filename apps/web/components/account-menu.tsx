"use client";

import { useEffect, useRef, useState } from "react";
import { formatAccountRole, primaryAccountRole } from "@breakpoint/types";

import { useAuth, type SessionAccount, type SessionRole, type SessionTeam } from "@/components/auth/auth-provider";
import { GuardedLink, useLeaveGuard } from "@/components/unsaved-changes";
import { applyTheme, getStoredTheme, setStoredTheme, type ThemePreference } from "@/lib/theme";

/** First letters of up to two words, for the circle avatar. */
function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "Sistem" },
  { value: "light", label: "Açık" },
  { value: "dark", label: "Koyu" },
];

/**
 * The identity corner every account gets: an avatar, a name, and -- since a
 * person can hold several roles across several groups at once under the
 * OR-merged permission model -- the highest-precedence one as a single line,
 * not an attempt to name them all.
 */
export function AccountMenu({
  account,
  team,
  roles,
}: {
  account: SessionAccount;
  team: SessionTeam | null;
  roles: readonly SessionRole[];
}) {
  const { signOut } = useAuth();
  const { requestLeave } = useLeaveGuard();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [theme, setTheme] = useState<ThemePreference>("system");

  useEffect(() => {
    const stored = getStoredTheme();
    setTheme(stored);
    applyTheme(stored);
  }, []);

  // Clicking anywhere outside closes the panel -- <details> has no such
  // behaviour of its own, and a menu that only closes by re-clicking its own
  // summary reads as stuck.
  //
  // A click inside the unsaved-changes confirmation is not an "outside"
  // click in the sense meant here: that native <dialog> already owns its own
  // modal semantics, and treating its own "stay" button as a reason to close
  // this menu would hide "Çıkış yap" the moment the guard it just triggered
  // asks to keep editing -- the one button "stay" is supposed to return
  // focus to.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!detailsRef.current || detailsRef.current.contains(target)) return;
      if ((target as Element).closest?.("dialog")) return;
      detailsRef.current.open = false;
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const primary = primaryAccountRole(roles);
  const subtitle = primary
    ? formatAccountRole(primary.roleName, primary.groupName)
    : team
      ? "Rol atanmamış"
      : "Sistem yöneticisi";

  function chooseTheme(next: ThemePreference) {
    setTheme(next);
    setStoredTheme(next);
  }

  return (
    <details className="account-menu" ref={detailsRef}>
      <summary>
        <span className="account-avatar" aria-hidden="true">
          {initials(account.fullName)}
        </span>
        <span className="account-menu-info">
          <span className="account-menu-name">{account.fullName}</span>
          <span className="account-menu-sub">{subtitle}</span>
        </span>
      </summary>

      <div className="account-menu-panel">
        {team ? (
          <GuardedLink href="/account">Rollerim ve yetkilerim</GuardedLink>
        ) : null}
        <GuardedLink href="/change-password">Şifre değiştir</GuardedLink>

        <hr className="account-menu-divider" />

        <div className="account-menu-theme" role="group" aria-label="Tema">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={option.value === theme ? "is-active" : ""}
              aria-pressed={option.value === theme}
              onClick={() => chooseTheme(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <hr className="account-menu-divider" />

        <button
          type="button"
          onClick={() => {
            // No manual close here: a confirmed sign-out unmounts this whole
            // shell anyway, and closing eagerly -- before requestLeave even
            // resolves -- hid this same button behind its own collapsed
            // panel, so "stay" had nothing visible left to return focus to.
            requestLeave(() => {
              void signOut().catch(() => {});
            });
          }}
        >
          Çıkış yap
        </button>
      </div>
    </details>
  );
}
