import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient, getAccessToken, setAccessToken } from "./api-client";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

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
});
