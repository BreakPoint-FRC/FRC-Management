"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { Loading, NavLink } from "@/components/ui";
import { visibleNavigationItems } from "@/lib/navigation";

/**
 * Each link carries the tool it leads to, so the nav is filtered by the same
 * vocabulary the server authorizes against instead of a second hand-kept list.
 * The overview has no tool -- everyone who is signed in can see their own
 * roles and permissions.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { status, account, team, permissions, signOut } = useAuth();
  const router = useRouter();

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

  // "loading" is the session restore; "anonymous" is the moment before the
  // redirect above lands. Neither should flash a half-rendered dashboard, and
  // neither should the instant before the two redirects land.
  if (status !== "authenticated") return <Loading />;
  if (account?.mustChangePassword) return <Loading />;
  if (blockedBySetup) return <Loading />;

  // Hiding a link the account cannot follow is a courtesy, not a control: the
  // route behind it is authorized on the server on every request.
  const visible = visibleNavigationItems(account?.teamId, permissions);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <span>BreakPoint</span>
        </div>

        <nav>
          <ul>
            {visible.map((item) => (
              <li key={item.href}>
                <NavLink href={item.href}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="stack-sm" style={{ marginTop: "auto" }}>
          <div className="small">
            <div>{account?.fullName}</div>
            <div className="muted">{account?.email}</div>
            {/* A platform system admin belongs to no team, which is the whole
                point of the role -- saying so beats an empty line. */}
            <div className="muted">{team ? team.name : "Sistem yoneticisi"}</div>
          </div>
          <button className="btn btn-sm" type="button" onClick={() => void signOut()}>
            Cikis yap
          </button>
        </div>
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}
