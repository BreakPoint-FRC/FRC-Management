import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiClient,
  clearSession,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from "./api-client";

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
  const refresh =
    options.refresh ?? (async () => json(200, { accessToken: token, refreshToken: "rt-next" }));

  return vi.fn(async (url: string, init: any) => {
    if (url === REFRESH_URL) return refresh();
    return init.headers.Authorization === `Bearer ${token}`
      ? json(200, { path: url })
      : json(401, { message: "Oturum acmaniz gerekiyor" });
  });
}

/** A signed-in session. Both tokens are needed: a refresh spends the second. */
function signedIn(access: string, refresh = "rt-1") {
  setAccessToken(access);
  setRefreshToken(refresh);
}

describe("apiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
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

  it("sends the access token and no credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("token-abc");

    await apiClient.get("/tasks");

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer token-abc");
    // Nothing rides on a cookie any more, so the request must not ask the
    // browser to attach one. Both tokens live in memory and travel explicitly.
    expect(init.credentials).toBeUndefined();
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
      .mockResolvedValueOnce(json(200, { accessToken: "fresh-token", refreshToken: "rt-2" }))
      .mockResolvedValueOnce(json(200, { items: [1] }));
    vi.stubGlobal("fetch", fetchMock);
    signedIn("stale-token");

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
    signedIn("stale-token");

    await expect(apiClient.get("/tasks")).rejects.toMatchObject({ status: 401 });
    expect(getAccessToken()).toBeNull();
  });

  it("omits the JSON content-type when there is no body", async () => {
    // Fastify refuses a request that announces JSON and sends nothing, so a
    // bodyless POST that set the header would 400. Activating a season and
    // adding a role hierarchy edge both take no body at all.
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.post("/seasons/season-1/activate");

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

  describe("a session that lives only in memory", () => {
    it("sends the refresh token in the body and keeps the rotated one", async () => {
      // The server revokes a refresh token as it spends it, so dropping the
      // replacement would make the next refresh look like a stolen token being
      // replayed -- which revokes every session the account has.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(json(401, { message: "Oturum acmaniz gerekiyor" }))
        .mockResolvedValueOnce(json(200, { accessToken: "fresh-token", refreshToken: "rt-2" }))
        .mockResolvedValueOnce(json(200, { items: [] }));
      vi.stubGlobal("fetch", fetchMock);
      signedIn("stale-token", "rt-1");

      await apiClient.get("/tasks");

      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ refreshToken: "rt-1" });
      expect(getRefreshToken()).toBe("rt-2");
    });

    it("does not reach the network with no refresh token to spend", async () => {
      // What a reload looks like: the tab that held the tokens is gone and
      // nothing was written to the disk, so there is nothing to restore. The
      // 401 stands on its own rather than starting a pointless round trip.
      const fetchMock = vi.fn().mockResolvedValue(json(401, { message: "Oturum acmaniz gerekiyor" }));
      vi.stubGlobal("fetch", fetchMock);
      setAccessToken("stale-token");

      await expect(apiClient.get("/tasks")).rejects.toMatchObject({ status: 401 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.filter(([url]: any[]) => url === REFRESH_URL)).toHaveLength(0);
    });
  });

  describe("no connection", () => {
    it("reports a dead connection as such rather than as an unknown failure", async () => {
      // There is no offline mode here at all, so this is the one message that
      // tells the user the app is fine and the venue wifi is not.
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

      await expect(apiClient.get("/tasks")).rejects.toMatchObject({
        status: 0,
        message: "Internet baglantisi yok",
      });
    });

    it("still reports what the server said when there is a server to answer", async () => {
      // A 500 is not a connection problem, and calling it one would send
      // someone to look at the wifi while the API is down.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(500, { message: "Sunucu hatasi" })));

      await expect(apiClient.get("/tasks")).rejects.toMatchObject({ status: 500 });
    });
  });

  describe("concurrent refreshes", () => {
    // Refresh tokens rotate, and the API treats a second use of one as theft:
    // it revokes every session for the account. A page firing several requests
    // at once must therefore produce exactly one rotation, or it signs the user
    // out of every device they own.
    it("collapses a burst of 401s into a single refresh", async () => {
      const fetchMock = fetchServing(jwt("acc-a", "2"));
      vi.stubGlobal("fetch", fetchMock);
      signedIn(jwt("acc-a", "1"));

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
      signedIn(jwt("acc-a", "1"));

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
        if (url === REFRESH_URL) return json(200, { accessToken: fresh, refreshToken: "rt-2" });
        if (url.endsWith("/members") && init.headers.Authorization !== `Bearer ${fresh}`) {
          return late.promise;
        }
        return init.headers.Authorization === `Bearer ${fresh}`
          ? json(200, { path: url })
          : json(401, { message: "Oturum acmaniz gerekiyor" });
      });
      vi.stubGlobal("fetch", fetchMock);
      signedIn(jwt("acc-a", "1"));

      const members = apiClient.get("/members");
      await apiClient.get("/tasks");
      late.resolve(json(401, { message: "Oturum acmaniz gerekiyor" }));

      await expect(members).resolves.toEqual({ path: "http://localhost:4000/members" });
      expect(fetchMock.mock.calls.filter(([url]) => url === REFRESH_URL)).toHaveLength(1);
    });

    it("rejects the whole burst and clears the session when the refresh is refused", async () => {
      const fetchMock = fetchServing(jwt("acc-a", "2"), {
        refresh: () => json(401, { message: "Oturum guvenlik nedeniyle sonlandirildi" }),
      });
      vi.stubGlobal("fetch", fetchMock);
      signedIn(jwt("acc-a", "1"));

      const results = await Promise.allSettled([apiClient.get("/tasks"), apiClient.get("/members")]);

      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(fetchMock.mock.calls.filter(([url]) => url === REFRESH_URL)).toHaveLength(1);
      expect(getAccessToken()).toBeNull();
      // The refresh token goes too, or the next request would spend one the
      // server has already refused.
      expect(getRefreshToken()).toBeNull();
    });

    it("leaves the session alone when the refresh cannot reach the network", async () => {
      // Losing wifi in a pit is not the server saying no. Clearing the tokens
      // here would turn a dead spot into a forced sign-in -- and with nothing
      // stored on the device, that sign-in could not be undone by a reload.
      const fetchMock = fetchServing(jwt("acc-a", "2"), {
        refresh: () => Promise.reject(new TypeError("Failed to fetch")),
      });
      vi.stubGlobal("fetch", fetchMock);
      signedIn(jwt("acc-a", "1"));

      await expect(apiClient.get("/tasks")).rejects.toThrow("Internet baglantisi yok");
      expect(getAccessToken()).toBe(jwt("acc-a", "1"));
      expect(getRefreshToken()).toBe("rt-1");
    });
  });
});
