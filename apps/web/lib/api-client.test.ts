import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient, getAccessToken, setAccessToken } from "./api-client";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** An access token the client can read an account id out of, as the API's are. */
const jwt = (sub: string, id = "1") =>
  `header.${btoa(JSON.stringify({ sub, jti: id })).replace(/=/g, "")}.signature`;

const REFRESH_URL = "http://localhost:4000/auth/refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A fetch that answers by request rather than by call order, which is the only
 * way to describe a burst: several requests are in flight at once, so which of
 * them reaches the mock first is exactly the thing under test.
 */
function fetchServing(token: string, options: { refresh?: () => Response | Promise<Response> } = {}) {
  const refresh = options.refresh ?? (async () => json(200, { accessToken: token }));

  return vi.fn(async (url: string, init: any) => {
    if (url === REFRESH_URL) return refresh();
    return init.headers.Authorization === `Bearer ${token}`
      ? json(200, { path: url })
      : json(401, { message: "Oturum acmaniz gerekiyor" });
  });
}

describe("apiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it("handles successful responses without a body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204, statusText: "No Content" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiClient.delete("/tasks/task-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/tasks/task-1",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("sends the access token and the refresh cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("token-abc");

    await apiClient.get("/tasks");

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer token-abc");
    // Without this the browser withholds the httpOnly refresh cookie, because
    // the API is on a different origin.
    expect(init.credentials).toBe("include");
  });

  it("omits the header entirely when signed out", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.get("/health");

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("surfaces the message the API sent, not just the status text", async () => {
    // The API explains which permission was missing, in Turkish. Throwing
    // "403 Forbidden" would discard the only part a user can act on.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(403, { message: "Bu grubun uyesi degilsiniz" }))
    );

    await expect(apiClient.get("/tasks")).rejects.toThrow("Bu grubun uyesi degilsiniz");
  });

  it("carries validation issues through so a form can show them per field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(400, {
          message: "Invalid request",
          issues: [{ path: ["roles", 1], message: "Bu rol zaten listede var" }],
        })
      )
    );

    await expect(apiClient.post("/accounts", {})).rejects.toMatchObject({
      status: 400,
      issues: [{ path: ["roles", 1], message: "Bu rol zaten listede var" }],
    });
  });

  it("survives an error body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502, statusText: "Bad Gateway" }))
    );

    await expect(apiClient.get("/tasks")).rejects.toBeInstanceOf(ApiError);
  });

  it("refreshes once on a 401 and replays the request", async () => {
    // An access token lasts fifteen minutes, so meeting an expired one is the
    // normal case rather than a failure.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { message: "Oturum acmaniz gerekiyor" }))
      .mockResolvedValueOnce(json(200, { accessToken: "fresh-token" }))
      .mockResolvedValueOnce(json(200, { items: [1] }));
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("stale-token");

    await expect(apiClient.get("/tasks")).resolves.toEqual({ items: [1] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:4000/auth/refresh");
    expect(getAccessToken()).toBe("fresh-token");
    // The replay carries the new token, not the stale one.
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer fresh-token");
  });

  it("gives up and clears the token when the refresh also fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { message: "Oturum acmaniz gerekiyor" }))
      .mockResolvedValueOnce(json(401, { message: "Oturum suresi doldu" }));
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("stale-token");

    await expect(apiClient.get("/tasks")).rejects.toMatchObject({ status: 401 });
    expect(getAccessToken()).toBeNull();
  });

  it("omits the JSON content-type when there is no body", async () => {
    // Fastify refuses a request that announces JSON and sends nothing, so a
    // bodyless POST that set the header would 400. /auth/refresh and
    // /auth/logout are both bodyless, which makes this the difference between
    // a session that survives a reload and one that does not.
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.post("/auth/logout");

    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("still sets it when there is a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.post("/tasks", { name: "x" });

    expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");
  });

  it("sends a DELETE without a content-type either", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.delete("/tasks/task-1");

    expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBeUndefined();
  });

  it("does not try to refresh a failed login", async () => {
    // Otherwise a wrong password would fire a pointless refresh on every
    // attempt, and a successful one would mask the failure.
    const fetchMock = vi.fn().mockResolvedValue(json(401, { message: "E-posta veya sifre hatali" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiClient.post("/auth/login", {})).rejects.toThrow("E-posta veya sifre hatali");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("concurrent refreshes", () => {
    // Refresh tokens rotate, and the API treats a second use of one as theft:
    // it revokes every session for the account. A page firing several requests
    // at once must therefore produce exactly one rotation, or it signs the user
    // out of every device they own.
    it("collapses a burst of 401s into a single refresh", async () => {
      const fetchMock = fetchServing(jwt("acc-a", "2"));
      vi.stubGlobal("fetch", fetchMock);
      setAccessToken(jwt("acc-a", "1"));

      const results = await Promise.all([
        apiClient.get("/tasks"),
        apiClient.get("/members"),
        apiClient.get("/finance/entries"),
      ]);

      expect(results).toEqual([
        { path: "http://localhost:4000/tasks" },
        { path: "http://localhost:4000/members" },
        { path: "http://localhost:4000/finance/entries" },
      ]);

      const refreshes = fetchMock.mock.calls.filter(([url]) => url === REFRESH_URL);
      expect(refreshes).toHaveLength(1);

      // Three originals, one refresh, three replays -- every request replayed
      // with the new token rather than being dropped.
      expect(fetchMock).toHaveBeenCalledTimes(7);
      expect(getAccessToken()).toBe(jwt("acc-a", "2"));
    });

    it("lets a later 401 refresh again once the first one has settled", async () => {
      const fetchMock = fetchServing(jwt("acc-a", "2"));
      vi.stubGlobal("fetch", fetchMock);
      setAccessToken(jwt("acc-a", "1"));

      await apiClient.get("/tasks");
      // The token expires again; the shared promise must not have latched.
      setAccessToken(jwt("acc-a", "3"));
      await apiClient.get("/tasks");

      expect(fetchMock.mock.calls.filter(([url]) => url === REFRESH_URL)).toHaveLength(2);
    });

    it("does not refresh again when another request already did", async () => {
      // A request sent before the refresh but answered after it. Its token is
      // stale, yet the one in hand is already good -- rotating a second time
      // would spend a refresh token for nothing.
      const fresh = jwt("acc-a", "2");
      const late = deferred<Response>();

      const fetchMock = vi.fn(async (url: string, init: any) => {
        if (url === REFRESH_URL) return json(200, { accessToken: fresh });
        if (url.endsWith("/members") && init.headers.Authorization !== `Bearer ${fresh}`) {
          return late.promise;
        }
        return init.headers.Authorization === `Bearer ${fresh}`
          ? json(200, { path: url })
          : json(401, { message: "Oturum acmaniz gerekiyor" });
      });
      vi.stubGlobal("fetch", fetchMock);
      setAccessToken(jwt("acc-a", "1"));

      const members = apiClient.get("/members");
      await apiClient.get("/tasks");
      late.resolve(json(401, { message: "Oturum acmaniz gerekiyor" }));

      await expect(members).resolves.toEqual({ path: "http://localhost:4000/members" });
      expect(fetchMock.mock.calls.filter(([url]) => url === REFRESH_URL)).toHaveLength(1);
    });

    it("rejects the whole burst and clears the token when the refresh is refused", async () => {
      const fetchMock = fetchServing(jwt("acc-a", "2"), {
        refresh: () => json(401, { message: "Oturum guvenlik nedeniyle sonlandirildi" }),
      });
      vi.stubGlobal("fetch", fetchMock);
      setAccessToken(jwt("acc-a", "1"));

      const results = await Promise.allSettled([apiClient.get("/tasks"), apiClient.get("/members")]);

      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(fetchMock.mock.calls.filter(([url]) => url === REFRESH_URL)).toHaveLength(1);
      expect(getAccessToken()).toBeNull();
    });

    it("leaves the session alone when the refresh cannot reach the network", async () => {
      // Losing wifi in a pit is not the server saying no. Clearing the token
      // here would turn a dead spot into a forced sign-in.
      const fetchMock = fetchServing(jwt("acc-a", "2"), {
        refresh: () => Promise.reject(new TypeError("Failed to fetch")),
      });
      vi.stubGlobal("fetch", fetchMock);
      setAccessToken(jwt("acc-a", "1"));

      await expect(apiClient.get("/tasks")).rejects.toThrow("Failed to fetch");
      expect(getAccessToken()).toBe(jwt("acc-a", "1"));
    });
  });

  describe("cached API responses", () => {
    function stubWorker() {
      const postMessage = vi.fn();
      vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage } } });
      return postMessage;
    }

    it("tells the worker to drop cached responses when the account changes", async () => {
      const postMessage = stubWorker();

      setAccessToken(jwt("acc-a"));
      expect(postMessage).toHaveBeenCalledWith({ type: "purge" });

      // Signing out, then someone else signing in on the same laptop.
      setAccessToken(null);
      setAccessToken(jwt("acc-b"));
      expect(postMessage).toHaveBeenCalledTimes(3);
    });

    it("keeps the cache across a rotation for the same account", async () => {
      setAccessToken(jwt("acc-a", "1"));
      const postMessage = stubWorker();

      setAccessToken(jwt("acc-a", "2"));

      // Otherwise every fifteen minutes would throw away the offline reads the
      // user is still depending on.
      expect(postMessage).not.toHaveBeenCalled();
    });

    it("purges when a page load concludes that nobody is signed in", async () => {
      // A fresh module, because the distinction being tested is between "no
      // session yet on this page load" and "signed out": the first outcome of
      // a session restore is a change either way, and the cache the last
      // person to use this browser left behind must not survive it.
      vi.resetModules();
      const postMessage = vi.fn();
      vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage } } });

      const fresh = await import("./api-client");
      fresh.setAccessToken(null);

      expect(postMessage).toHaveBeenCalledWith({ type: "purge" });
    });

    it("purges when a refused refresh ends the session", async () => {
      setAccessToken(jwt("acc-a"));
      const postMessage = stubWorker();
      vi.stubGlobal(
        "fetch",
        fetchServing(jwt("acc-a", "2"), { refresh: () => json(401, { message: "Oturum suresi doldu" }) })
      );

      await expect(apiClient.get("/tasks")).rejects.toMatchObject({ status: 401 });

      expect(postMessage).toHaveBeenCalledWith({ type: "purge" });
    });
  });
});
