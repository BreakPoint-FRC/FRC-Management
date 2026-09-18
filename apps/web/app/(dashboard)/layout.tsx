"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AccountMenu } from "@/components/account-menu";
import { useAuth } from "@/components/auth/auth-provider";
import { Loading, NavLink } from "@/components/ui";
import { visibleNavigationSections } from "@/lib/navigation";

/**
 * Each link carries the tool it leads to, so the nav is filtered by the same
 * vocabulary the server authorizes against instead of a second hand-kept list.
 * Sections group related tools and disappear entirely once nothing under them
 * is visible -- see visibleNavigationSections -- so a plain member's sidebar
 * is five lines, not fourteen with most of them greyed out.
 *
 * On a phone the sidebar is a slide-out drawer rather than a permanently
 * visible strip: a hamburger button in the mobile top bar opens it, and it
 * closes on a nav tap, a backdrop tap, Escape, or the route itself changing
 * (covers browser back/forward, which fire no click here to catch).
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { status, account, team, roles, permissions } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // The whole dashboard waits for setup, not part of it.
  //
  // The wizard is self-contained -- groups, roles, modules, permissions and
  // accounts are all edited on /setup -- so there is nothing here for an
  // unfinished team to reach. And most of it could not work anyway: tasks,
  // meetings, finance, sponsors and the Gantt board all hang off a season, and
  // the season is created at the NAMING step. Landing on one of them early
  // would fail with "there is no active season", which reads as a bug rather
  // than as a missing step.
  const blockedBySetup = !!team && team.setupStage !== "DONE";

  // Two redirects before the dashboard, in the order the server enforces them.
  //
  // A temporary password is refused on every route but /auth/me, /auth/password
  // and /auth/logout, so landing anywhere else would be a page of 403s.
  useEffect(() => {
    if (status === "anonymous") {
      router.replace("/login");
      return;
    }
    if (status !== "authenticated") return;
    if (account?.mustChangePassword) {
      router.replace("/change-password");
      return;
    }
    if (blockedBySetup) router.replace("/setup");
  }, [status, account?.mustChangePassword, blockedBySetup, router]);

  useEffect(() => setDrawerOpen(false), [pathname]);

  // The drawer overlays the page rather than replacing it in the DOM, so
  // without this Tab would walk straight past the sidebar's last link into
  // the (visually hidden, but still focusable) page underneath. While open,
  // focus starts inside the drawer and Tab/Shift+Tab cycle only its own
  // focusable elements -- the same contract the dialogs already keep.
  useEffect(() => {
    if (!drawerOpen) {
      return;
    }

    // Recomputed on every Tab, not cached once: the account menu's own
    // <details> can open mid-drawer and add focusable rows below it. Chromium
    // keeps a closed <details>'s panel laid out (content-visibility: hidden)
    // rather than display:none, so offsetParent alone does not detect it --
    // excluding anything still inside a closed <details> does.
    function focusableElements(): HTMLElement[] {
      const container = sidebarRef.current;
      if (!container) return [];
      return Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => {
        if (element.offsetParent === null) return false;
        // The <summary> itself stays reachable even while its own <details>
        // is closed -- only the panel content it reveals is excluded.
        const closedDetails = element.closest("details:not([open])");
        return !closedDetails || element.tagName === "SUMMARY";
      });
    }

    focusableElements()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    const toggle = toggleRef.current;
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      toggle?.focus();
    };
  }, [drawerOpen]);

  // "loading" is the session restore; "anonymous" is the moment before the
  // redirect above lands. Neither should flash a half-rendered dashboard, and
  // neither should the instant before the two redirects land.
  if (status !== "authenticated") return <Loading />;
  if (account?.mustChangePassword) return <Loading />;
  if (blockedBySetup) return <Loading />;

  const sections = visibleNavigationSections(account?.teamId, permissions);

  return (
    <div className="app-shell">
      <div
        className={`sidebar-backdrop${drawerOpen ? " is-open" : ""}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <div className="mobile-topbar">
        <button
          ref={toggleRef}
          type="button"
          className="sidebar-toggle"
          aria-label={drawerOpen ? "Menüyü kapat" : "Menüyü aç"}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
        <div className="brand">
          <span className="brand-dot" />
          <span>BreakPoint</span>
        </div>
      </div>

      <aside ref={sidebarRef} className={`sidebar${drawerOpen ? " is-open" : ""}`}>
        <div className="brand">
          <span className="brand-dot" />
          <span>BreakPoint</span>
        </div>

        <nav className="sidebar-sections">
          {sections.map((section) => (
            <div key={section.label ?? "top"}>
              {section.label ? <p className="sidebar-section-label">{section.label}</p> : null}
              <ul>
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLink href={item.href} icon={item.icon}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {account ? <AccountMenu account={account} team={team ?? null} roles={roles ?? []} /> : null}
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}
