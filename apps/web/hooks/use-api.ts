"use client";

import { useCallback, useEffect, useState } from "react";
import type { Paginated } from "@breakpoint/types";

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
          cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata oluştu")
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

function pageUrl(path: string, page: number, pageSize: number): string {
  return `${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=${pageSize}`;
}

/**
 * Fetches every page of a paginated list endpoint and merges them into one
 * flat array.
 *
 * packages/types/src/pagination.ts caps `pageSize` at 100 -- deliberately, so
 * one greedy client request cannot ask for a whole table. A picker built on a
 * single `pageSize=100` request mistakes that server cap for "everyone" and
 * silently drops the 101st account instead of refusing outright, so a team
 * that grows past 100 members loses the ability to select the rest -- and
 * where the picker's checked set is saved as a full replacement (a group's
 * member list), the accounts missing from the picker are missing from the
 * save too. `path` should carry every filter this list needs but no `page` of
 * its own; this appends one per request and keeps going until the server's
 * own `totalPages` says there is nothing left.
 *
 * Exported on its own (rather than inlined in the hook below) so the
 * pagination-walking logic can be unit tested directly against a mocked
 * `fetch`, the same way api-client.test.ts covers apiClient -- no React
 * renderer needed for what is really just a fetch loop.
 */
export async function fetchAllPages<T>(path: string, pageSize = 100): Promise<T[]> {
  const first = await apiClient.get<Paginated<T>>(pageUrl(path, 1, pageSize));
  const rest = await Promise.all(
    Array.from({ length: Math.max(first.totalPages, 1) - 1 }, (_, index) =>
      apiClient.get<Paginated<T>>(pageUrl(path, index + 2, pageSize))
    )
  );
  return [...first.items, ...rest.flatMap((page) => page.items)];
}

/** See fetchAllPages. This is only its React binding: fetch on mount/path change, into ApiState. */
export function useApiAllPages<T>(path: string | null, pageSize = 100): ApiState<T[]> {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchAllPages<T>(path, pageSize)
      .then((items) => {
        if (!cancelled) setData(items);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setData(null);
        setError(
          cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata oluştu")
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, pageSize, nonce]);

  return { data, error, loading, reload };
}
