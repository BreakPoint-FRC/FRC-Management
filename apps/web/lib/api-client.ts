const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Both tokens live in memory. Nothing about a session touches the disk.
 *
 * The access token is short-lived and the refresh token is what buys the next
 * one, so between them they are a session -- and keeping them in module scope
 * means closing the tab ends it. There is no cookie, no localStorage and no
 * cached response anywhere: a shared pit laptop keeps nothing after the person
 * using it walks away, which is the whole reason this app stores nothing.
 *
 * The cost is a sign-in on every page load, because a reload starts a new
 * module with both variables null. That is deliberate. Putting either token in
 * localStorage would survive the reload and would also hand it to any injected
 * script; an httpOnly cookie would survive it without that risk but would put a
 * live session back on the disk. Do not "fix" the sign-in by adding either.
 */
let accessToken: string | null = null;
let refreshToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setRefreshToken(token: string | null): void {
  refreshToken = token;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

/** Drops the whole session locally, whatever the server thinks. */
export function clearSession(): void {
  accessToken = null;
  refreshToken = null;
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

/**
 * Status 0 is "the request never reached a server", which is not something the
 * API can ever answer with. Saying so plainly matters here: this app has no
 * offline mode at all, so a dead connection is the difference between "the
 * wifi in this venue is saturated" and "something is broken", and those two
 * ask the user for completely different things.
 */
const OFFLINE_MESSAGE = "Internet baglantisi yok";

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    return new ApiError(res.status, body.message ?? res.statusText, body.issues);
  } catch {
    // A proxy or a crash can answer with something that is not JSON.
    return new ApiError(res.status, res.statusText);
  }
}

/**
 * `fetch`, with a dead connection turned into an ApiError.
 *
 * fetch only rejects when the request never got an answer -- DNS, a refused
 * connection, a dropped link. Every HTTP status, 500 included, resolves. So a
 * rejection here is exactly the offline case and nothing else.
 */
async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  return netFetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      // Only when there is something to describe. Fastify rejects a request
      // that announces JSON and then sends nothing -- "Body cannot be empty
      // when content-type is set to application/json" -- and several endpoints
      // here take no body at all: activating a season, adding a role hierarchy
      // edge.
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
  });
}

let refreshInFlight: Promise<string | null> | null = null;

async function runRefresh(): Promise<string | null> {
  // Nothing to present. This is the ordinary first-load case rather than a
  // failure -- the last session's tokens died with the tab that held them --
  // so it answers "no session" without troubling the network.
  if (refreshToken === null) {
    clearSession();
    return null;
  }

  const res = await netFetch(`${API_BASE_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  // Only an answer from the server ends the session. A dead connection threw
  // out of netFetch above and is left to reject: a lift ride through a dead
  // spot must not sign anyone out.
  if (!res.ok) {
    clearSession();
    return null;
  }

  const body = (await res.json()) as { accessToken: string; refreshToken: string };

  // The server rotates on every use, so the token just spent is already dead
  // and the replacement has to be kept or the next refresh looks like theft.
  setRefreshToken(body.refreshToken);
  setAccessToken(body.accessToken);
  return accessToken;
}

/**
 * Exchanges the stored refresh token for a new access token, at most once at a
 * time.
 *
 * The server rotates refresh tokens: using one revokes it and issues another,
 * and presenting an already-used one is treated as theft, which revokes every
 * session for the account. A page that fires five requests at once and meets
 * five 401s would otherwise start five rotations off the same token and lock
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
