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

import { apiClient, setAccessToken } from "@/lib/api-client";
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

/**
 * Tells the service worker to drop its cached API responses.
 *
 * The worker caches every 200 it sees from the API, and the Cache API keys
 * entries by URL alone -- the Authorization header is not part of the key. On a
 * shared pit laptop that means the next person to sign in could be served the
 * previous one's data from cache the moment the network is slow enough to hit
 * the 5s timeout. Signing out is the one moment we can be sure that data should
 * be unreachable, so that is where it goes.
 */
function purgeApiCache(): void {
  if (typeof navigator === "undefined") return;
  navigator.serviceWorker?.controller?.postMessage({ type: "purge" });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<AuthValue["status"]>("loading");

  const loadProfile = useCallback(async () => {
    const next = await apiClient.get<Profile>("/auth/me");
    setProfile(next);
    setStatus("authenticated");
  }, []);

  // Restoring a session on first load. The access token lives in memory, so a
  // reload always starts without one -- but the refresh cookie survives, and
  // exchanging it is exactly what it is for. A failure here is the ordinary
  // signed-out case, not an error worth showing.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { accessToken } = await apiClient.post<{ accessToken: string }>("/auth/refresh");
        if (cancelled) return;

        setAccessToken(accessToken);
        await loadProfile();
      } catch {
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
      const { accessToken } = await apiClient.post<{ accessToken: string }>("/auth/login", {
        email,
        password,
      });
      setAccessToken(accessToken);
      await loadProfile();
    },
    [loadProfile]
  );

  const signOut = useCallback(async () => {
    try {
      await apiClient.post("/auth/logout");
    } finally {
      // Local state is cleared even if the call failed. The server may still
      // think the session is alive, but this browser must not.
      setAccessToken(null);
      setProfile(null);
      setStatus("anonymous");
      purgeApiCache();
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
