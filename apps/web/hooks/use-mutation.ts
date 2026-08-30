"use client";

import { useCallback, useState } from "react";

import { ApiError } from "@/lib/api-client";

export interface MutationState {
  /** Runs the call, captures an ApiError, and reports whether it succeeded. */
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  saving: boolean;
  error: ApiError | null;
  reset: () => void;
}

/**
 * The write half of use-api.
 *
 * Returns a boolean rather than rethrowing so a caller can close its form on
 * success and leave it open on failure without a try/catch at every call site.
 * The error is kept in state, because a 403 or a 409 is something to render
 * beside the form, not something to swallow.
 */
export function useMutation(): MutationState {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const reset = useCallback(() => setError(null), []);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);

    try {
      await action();
      return true;
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata olustu")
      );
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { run, saving, error, reset };
}
