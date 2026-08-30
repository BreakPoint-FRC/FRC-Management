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

export function setAccessToken(token: string | null): void {
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await send(path, init);

  // An access token lasts fifteen minutes, so an expired one is the normal
  // case rather than an error. Refresh once and replay; a second 401 means the
  // session is genuinely over and the caller has to handle it.
  if (res.status === 401 && path !== "/auth/refresh" && path !== "/auth/login") {
    const refreshed = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });

    if (!refreshed.ok) {
      setAccessToken(null);
      throw await toApiError(res);
    }

    setAccessToken(((await refreshed.json()) as { accessToken: string }).accessToken);
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
