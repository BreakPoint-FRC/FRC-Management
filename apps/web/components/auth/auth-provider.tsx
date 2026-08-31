"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  apiClient,
  clearSession,
  getRefreshToken,
  refreshSession,
  setAccessToken,
  setRefreshToken,
} from "@/lib/api-client";
import type { PermissionMap } from "@/lib/permissions";

export interface SessionAccount {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  archivedAt: string | null;
}

export interface SessionRole {
  roleId: string;
  roleKey: string;
  roleName: string;
  scope: "GLOBAL" | "GROUP";
  hierarchyLevel: number;
  groupId: string | null;
  groupName: string | null;
}

export interface SessionGroup {
  id: string;
  name: string;
  description: string | null;
}

interface Profile {
  account: SessionAccount;
  roles: SessionRole[];
  groups: SessionGroup[];
  permissions: PermissionMap;
}

interface AuthValue extends Partial<Profile> {
  /** "loading" only covers the initial session restore, not every request. */
  status: "loading" | "authenticated" | "anonymous";
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<AuthValue["status"]>("loading");

  const loadProfile = useCallback(async () => {
    const next = await apiClient.get<Profile>("/auth/me");
    setProfile(next);
    setStatus("authenticated");
  }, []);

  // A page load has nothing to restore. Both tokens live in memory and nothing
  // is written to the device, so `refreshSession` finds no token and answers
  // null without touching the network -- the ordinary path here, not a failure.
  //
  // The effect still has to run: it is what moves `status` off "loading" so the
  // login screen can render. It asks for a refresh rather than assuming the
  // answer, so a remount that does happen to hold a live session is restored
  // instead of being signed out.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Shared with the retry a 401 would start, so the first page load
        // cannot rotate the refresh cookie twice and revoke its own session.
        const token = await refreshSession();
        if (cancelled) return;

        if (token === null) {
          setStatus("anonymous");
          return;
        }

        await loadProfile();
      } catch {
        // Network trouble rather than a refusal -- refreshSession only clears
        // the tokens when the server actually says no. Either way this page
        // load has concluded that nobody is signed in.
        if (!cancelled) {
          setAccessToken(null);
          setStatus("anonymous");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadProfile]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const session = await apiClient.post<{ accessToken: string; refreshToken: string }>(
        "/auth/login",
        { email, password }
      );
      // The refresh token is what keeps this session alive past the access
      // token's fifteen minutes, for as long as the tab stays open.
      setRefreshToken(session.refreshToken);
      setAccessToken(session.accessToken);
      await loadProfile();
    },
    [loadProfile]
  );

  const signOut = useCallback(async () => {
    try {
      // Sent so the server can revoke the refresh token rather than leave it
      // valid until it expires on its own.
      await apiClient.post("/auth/logout", { refreshToken: getRefreshToken() });
    } finally {
      // Local state is cleared even if the call failed -- offline included.
      // The server may still think the session is alive, but this browser must
      // not, and nothing survives here for it to be wrong about for long.
      clearSession();
      setProfile(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, ...profile, signIn, signOut }),
    [status, profile, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
