export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "breakpoint-theme";

/**
 * Reads the stored preference. Wrapped in try/catch: localStorage can throw
 * in a private window or with blocked site data, and "system" (do nothing,
 * fall back to the OS media query) is the correct answer either way.
 */
export function getStoredTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: ThemePreference): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

export function setStoredTheme(theme: ThemePreference): void {
  try {
    if (theme === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Nothing survives the reload either way; applying it to this document
    // still keeps the toggle honest for the rest of the session.
  }
  applyTheme(theme);
}

/**
 * Source for the blocking inline script in app/layout.tsx, which has to run
 * before first paint to avoid a flash of the wrong theme. Kept here, next to
 * the functions it mirrors, so the two never drift.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;
