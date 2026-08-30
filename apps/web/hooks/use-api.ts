"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, apiClient } from "@/lib/api-client";

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch on mount, and again whenever the path changes.
 *
 * No SWR, no React Query. Every page here loads one or two lists and shows
 * them; a caching library would be more machinery than the thing it caches.
 *
 * Pass `null` to hold off -- a detail page that has not resolved its id yet, or
 * a request that depends on a filter the user has not chosen.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }

    // Set by the cleanup below. Without it, switching pages quickly lets a slow
    // first response land after a fast second one and overwrite it.
    let cancelled = false;

    setLoading(true);
    setError(null);

    apiClient
      .get<T>(path)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setData(null);
        setError(
          cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata olustu")
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  return { data, error, loading, reload };
}
