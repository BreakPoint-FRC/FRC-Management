import { purgeApiCache } from "./api-cache";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * The access token lives in memory, not localStorage.
 *
 * A token in localStorage survives a tab close, which sounds convenient and is
 * the reason an XSS bug turns into a stolen session. Losing it on reload costs
 * one silent POST /auth/refresh -- the refresh token is an httpOnly cookie that
 * JavaScript, including anything injected into the page, cannot read at all.
 */
let accessToken: string | null = null;

/**
 * Which account the current token belongs to.
 *
 * `undefined` means no session has been seen yet on this page load, which is
 * not the same as signed out: whatever the first session restore turns up is
 * itself a change, and the cache left behind by whoever used this browser last
 * must not survive it.
 */
let subject: string | null | undefined = undefined;

function subjectOf(token: string | null): string | null {
  if (token === null) return null;

  try {
    const payload = token.split(".")[1];
    const { sub } = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof sub === "string" ? sub : token;
  } catch {
    // Not a JWT we can read. Falling back to the token itself over-purges --
    // every rotation looks like a new account -- which is the safe direction.
    return token;
  }
}

export function setAccessToken(token: string | null): void {
  const next = subjectOf(token);

  // Every way the session can change passes through here: signing in, signing
  // out, a refresh the server refused, a session revoked from another device.
  // Comparing accounts rather than tokens keeps an ordinary rotation from
  // throwing away the offline cache the current user is still reading from.
  if (next !== subject) {
    subject = next;
    purgeApiCache();
  }

  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * An error carrying what the API actually said.
 *
 * The old client threw `API request failed: 403 Forbidden`, which throws away
 * the part a user could act on -- the API answers with a Turkish message
 * explaining which permission or group was missing, and validation failures
 * carry per-field issues that a form needs to render next to the offending
 * input.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: Array<{ path: (string | number)[]; message: string }>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    return new ApiError(res.status, body.message ?? res.statusText, body.issues);
  } catch {
    // A proxy or a crash can answer with something that is not JSON.
    return new ApiError(res.status, res.statusText);
  }
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      // Only when there is something to describe. Fastify rejects a request
      // that announces JSON and then sends nothing -- "Body cannot be empty
      // when content-type is set to application/json" -- and several endpoints
      // here take no body at all: /auth/refresh, /auth/logout, activating a
      // season, adding a role hierarchy edge.
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
    // The API is on a different origin, so the refresh cookie only travels when
    // both sides opt in: this, and `credentials: true` in the API CORS plugin.
    credentials: "include",
  });
}

let refreshInFlight: Promise<string | null> | null = null;

async function runRefresh(): Promise<string | null> {
  const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });

  // Only an answer from the server ends the session. A network error is a
  // different thing entirely and is left to reject below: a lift ride through a
  // dead spot must not sign anyone out.
  if (!res.ok) {
    setAccessToken(null);
    return null;
  }

  setAccessToken(((await res.json()) as { accessToken: string }).accessToken);
  return accessToken;
}

/**
 * Exchanges the refresh cookie for a new access token, at most once at a time.
 *
 * The server rotates refresh tokens: using one revokes it and issues another,
 * and presenting an already-used one is treated as theft, which revokes every
 * session for the account. A page that fires five requests at once and meets
 * five 401s would otherwise start five rotations off the same cookie and lock
 * the user out of every device they own. Everyone shares one call instead --
 * including the session restore on boot, which is why this is exported.
 */
export function refreshSession(): Promise<string | null> {
  refreshInFlight ??= runRefresh().finally(() => {
    // Cleared either way: a refusal must not leave a promise that permanently
    // answers "no" to a session that has since been signed back in.
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const sentWith = accessToken;
  let res = await send(path, init);

  // An access token lasts fifteen minutes, so an expired one is the normal
  // case rather than an error. Refresh once and replay; a second 401 means the
  // session is genuinely over and the caller has to handle it.
  if (res.status === 401 && path !== "/auth/refresh" && path !== "/auth/login") {
    // Someone else may have refreshed while this request was in flight. That
    // token is already good, so replaying with it is enough -- rotating again
    // would spend a refresh token for nothing.
    const token =
      accessToken !== sentWith && accessToken !== null ? accessToken : await refreshSession();

    if (token === null) throw await toApiError(res);
    res = await send(path, init);
  }

  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: (path: string): Promise<void> => request<void>(path, { method: "DELETE" }),
};
