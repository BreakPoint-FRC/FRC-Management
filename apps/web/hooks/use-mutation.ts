"use client";

import { useCallback, useState } from "react";

import { ApiError } from "@/lib/api-client";

export interface MutationState {
  /** Runs the call, captures an ApiError, and reports whether it succeeded. */
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  /**
   * The same, for the calls whose answer matters.
   *
   * `run` cannot report one: a 204 resolves to undefined, which is
   * indistinguishable from a failure once it is narrowed to a boolean. This
   * returns the body on success and null on failure, which is what
   * POST /teams needs -- the generated password exists nowhere else and cannot
   * be asked for again.
   */
  runFor: <T>(action: () => Promise<T>) => Promise<T | null>;
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

  const runFor = useCallback(async <T,>(action: () => Promise<T>): Promise<T | null> => {
    setSaving(true);
    setError(null);

    try {
      return await action();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata olustu")
      );
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  // Written in terms of runFor rather than beside it, so there is one place
  // that decides what counts as a failure.
  const run = useCallback(
    async (action: () => Promise<unknown>) => (await runFor(action)) !== null,
    [runFor]
  );

  return { run, runFor, saving, error, reset };
}
