import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service worker is a plain file in public/, so it is loaded into a mock
 * ServiceWorkerGlobalScope here. This is the only way to exercise the offline
 * behaviour without a browser — and caching bugs are otherwise invisible until
 * they reach production.
 */

const SW_SOURCE = readFileSync(
  join(__dirname, "..", "public", "sw.js"),
  "utf8"
);

const API_BASE = "http://localhost:4000";

/** An access token the worker can read an account id out of, as the API's are. */
const jwt = (sub: string) =>
  `header.${btoa(JSON.stringify({ sub })).replace(/=/g, "")}.signature`;

const bearer = (sub: string) => ({ Authorization: `Bearer ${jwt(sub)}` });

type Handler = (event: any) => void;

function createCacheStorage() {
  const caches = new Map<string, Map<string, Response>>();

  const cacheFor = (name: string) => {
    if (!caches.has(name)) caches.set(name, new Map());
    return caches.get(name)!;
  };

  const keyOf = (request: any) =>
    typeof request === "string" ? request : request.url;

  const wrap = (name: string) => ({
    match: async (request: any) => {
      const hit = cacheFor(name).get(keyOf(request));
      return hit ? hit.clone() : undefined;
    },
    put: async (request: any, response: Response) => {
      cacheFor(name).set(keyOf(request), response);
    },
    addAll: async (urls: string[]) => {
      for (const url of urls) {
        cacheFor(name).set(url, new Response("precached", { status: 200 }));
      }
    },
  });

  return {
    api: {
      open: async (name: string) => wrap(name),
      match: async (request: any) => {
        for (const [name] of caches) {
          const hit = await wrap(name).match(request);
          if (hit) return hit;
        }
        return undefined;
      },
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
    },
    raw: caches,
  };
}

function loadServiceWorker(fetchImpl: any) {
  const handlers = new Map<string, Handler>();
  const cacheStorage = createCacheStorage();

  const self: any = {
    location: { href: `https://app.example/sw.js?api=${encodeURIComponent(API_BASE)}`, origin: "https://app.example" },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
  };

  const sandbox: any = {
    self,
    caches: cacheStorage.api,
    fetch: fetchImpl,
    Response,
    Request,
    Headers,
    URL,
    AbortController,
    atob,
    setTimeout,
    clearTimeout,
    console,
    Promise,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);

  return { handlers, cacheStorage, self };
}

/** Dispatches a fetch event and returns the response, or null if not intercepted. */
async function dispatchFetch(
  handlers: Map<string, Handler>,
  request: { url: string; method?: string; mode?: string; headers?: Record<string, string> }
): Promise<Response | null> {
  let responded: Promise<Response> | null = null;
  const headers = request.headers ?? {};

  handlers.get("fetch")!({
    request: {
      url: request.url,
      method: request.method ?? "GET",
      mode: request.mode ?? "no-cors",
      headers: { get: (name: string) => headers[name] ?? headers[name.toUpperCase()] ?? null },
    },
    respondWith: (promise: Promise<Response>) => {
      responded = promise;
    },
  });

  return responded ? await responded : null;
}

describe("service worker", () => {
  let online: any;

  beforeEach(() => {
    online = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "m1", name: "Ada" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("caches API reads so they survive going offline", async () => {
    const { handlers } = loadServiceWorker(online);
    const url = `${API_BASE}/members`;

    const first = await dispatchFetch(handlers, { url });
    expect(first).not.toBeNull();
    expect(await first!.json()).toEqual([{ id: "m1", name: "Ada" }]);
    expect(online).toHaveBeenCalledOnce();

    // Same worker instance, network now fails: the cached copy must come back.
    const offlineHandlers = handlers;
    online.mockRejectedValue(new Error("network down"));

    const second = await dispatchFetch(offlineHandlers, { url });
    expect(second!.status).toBe(200);
    expect(await second!.json()).toEqual([{ id: "m1", name: "Ada" }]);
  });

  it("returns a 503 for uncached API reads while offline", async () => {
    const offline = vi.fn().mockRejectedValue(new Error("network down"));
    const { handlers } = loadServiceWorker(offline);

    const response = await dispatchFetch(handlers, { url: `${API_BASE}/tasks` });

    expect(response!.status).toBe(503);
    expect(await response!.json()).toMatchObject({ statusCode: 503 });
  });

  it("never intercepts writes", async () => {
    const { handlers } = loadServiceWorker(online);

    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await dispatchFetch(handlers, {
        url: `${API_BASE}/members`,
        method,
      });
      expect(response, `${method} must reach the network untouched`).toBeNull();
    }
    expect(online).not.toHaveBeenCalled();
  });

  it("leaves Next.js RSC payload requests to the network", async () => {
    const { handlers } = loadServiceWorker(online);

    const withParam = await dispatchFetch(handlers, {
      url: "https://app.example/members?_rsc=abc123",
      mode: "navigate",
    });
    const withHeader = await dispatchFetch(handlers, {
      url: "https://app.example/members",
      mode: "navigate",
      headers: { RSC: "1" },
    });

    expect(withParam).toBeNull();
    expect(withHeader).toBeNull();
  });

  it("falls back to the offline page for an uncached navigation", async () => {
    const offline = vi.fn().mockRejectedValue(new Error("network down"));
    const { handlers } = loadServiceWorker(offline);

    // Populate the shell cache the way install does.
    await handlers.get("install")!({ waitUntil: (p: Promise<unknown>) => p });

    const response = await dispatchFetch(handlers, {
      url: "https://app.example/members",
      mode: "navigate",
    });

    expect(response).not.toBeNull();
    expect(await response!.text()).toBe("precached");
  });

  it("drops caches from older versions on activate", async () => {
    const { handlers, cacheStorage } = loadServiceWorker(online);
    cacheStorage.raw.set("breakpoint-shell-v1", new Map());
    cacheStorage.raw.set("breakpoint-api-v1-acc-a", new Map());
    cacheStorage.raw.set("unrelated-cache", new Map());

    await handlers.get("activate")!({ waitUntil: (p: Promise<unknown>) => p });

    const remaining = await cacheStorage.api.keys();
    expect(remaining).not.toContain("breakpoint-shell-v1");
    expect(remaining).not.toContain("breakpoint-api-v1-acc-a");
    // Caches belonging to other apps must be left alone.
    expect(remaining).toContain("unrelated-cache");
  });

  // The Cache API keys entries by URL alone -- the Authorization header is not
  // part of the key -- so a single API cache hands the next person to sign in
  // on a shared laptop the previous one's data. The account goes in the cache
  // name instead, which no timing can get around.
  describe("per-account API caches", () => {
    it("never lets one account read another's cached response for the same URL", async () => {
      const { handlers } = loadServiceWorker(online);
      const url = `${API_BASE}/finance/entries`;

      const mine = await dispatchFetch(handlers, { url, headers: bearer("acc-a") });
      expect(await mine!.json()).toEqual([{ id: "m1", name: "Ada" }]);

      // Slow venue wifi: the API times out and the worker falls back to cache.
      online.mockRejectedValue(new Error("network down"));

      const theirs = await dispatchFetch(handlers, { url, headers: bearer("acc-b") });
      expect(theirs!.status).toBe(503);

      // The owner still gets their own copy -- separation, not a purge.
      const again = await dispatchFetch(handlers, { url, headers: bearer("acc-a") });
      expect(await again!.json()).toEqual([{ id: "m1", name: "Ada" }]);
    });

    it("keeps a request without a token out of every account's cache", async () => {
      const { handlers, cacheStorage } = loadServiceWorker(online);

      await dispatchFetch(handlers, { url: `${API_BASE}/health` });

      expect(await cacheStorage.api.keys()).toEqual(["breakpoint-api-v2-anon"]);
    });
  });

  // The app sends this whenever the signed-in account changes: signing out,
  // signing in, a refresh the server refused, a session revoked elsewhere.
  describe("purge", () => {
    // Awaiting waitUntil, not the handler: the worker keeps the browser alive
    // through the promise it registers there, and the deletion happens in it.
    async function dispatchPurge(handlers: Map<string, Handler>) {
      let pending: Promise<unknown> = Promise.resolve();
      handlers.get("message")!({
        data: { type: "purge" },
        waitUntil: (p: Promise<unknown>) => {
          pending = p;
        },
      });
      await pending;
    }

    it("drops every account's cached API responses", async () => {
      const { handlers, cacheStorage } = loadServiceWorker(online);
      const url = `${API_BASE}/accounts`;

      await dispatchFetch(handlers, { url, headers: bearer("acc-a") });
      await dispatchFetch(handlers, { url, headers: bearer("acc-b") });
      expect(await cacheStorage.api.keys()).toEqual([
        "breakpoint-api-v2-acc-a",
        "breakpoint-api-v2-acc-b",
      ]);

      await dispatchPurge(handlers);
      expect(await cacheStorage.api.keys()).toEqual([]);

      // And the next offline read finds nothing rather than stale data.
      online.mockRejectedValue(new Error("network down"));
      const afterPurge = await dispatchFetch(handlers, { url, headers: bearer("acc-a") });
      expect(afterPurge!.status).toBe(503);
    });

    it("keeps the shell and navigation caches, which belong to nobody", async () => {
      const { handlers, cacheStorage } = loadServiceWorker(online);
      await handlers.get("install")!({ waitUntil: (p: Promise<unknown>) => p });
      await dispatchFetch(handlers, { url: "https://app.example/members", mode: "navigate" });

      await dispatchPurge(handlers);

      const remaining = await cacheStorage.api.keys();
      expect(remaining).toContain("breakpoint-shell-v2");
      expect(remaining).toContain("breakpoint-runtime-v2");
    });

    it("ignores messages it does not recognise", async () => {
      const { handlers, cacheStorage } = loadServiceWorker(online);
      await dispatchFetch(handlers, { url: `${API_BASE}/accounts`, headers: bearer("acc-a") });

      await handlers.get("message")!({
        data: { type: "something-else" },
        waitUntil: (p: Promise<unknown>) => p,
      });

      expect(await cacheStorage.api.keys()).toContain("breakpoint-api-v2-acc-a");
    });
  });
});
