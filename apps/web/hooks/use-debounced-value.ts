"use client";

import { useEffect, useState } from "react";

/**
 * The value, delayed until it stops changing for `delayMs`.
 *
 * For a free-text filter like the accounts search box: every dropdown and
 * checkbox in this app applies on change, which is fine because picking one
 * is a single event. Typing is not -- applying on every keystroke would fire
 * a request per character.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
