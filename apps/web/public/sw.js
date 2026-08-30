/* eslint-env serviceworker */
// BreakPoint service worker — offline reads.
//
// Scope decision: cached GETs stay readable without a connection; writes still
// require the network. FRC venues have saturated wifi, so API reads are also
// given a short timeout — a slow network falls back to cache rather than hanging.
//
// The API origin is passed in at registration time (/sw.js?api=...) because a
// static file in public/ cannot read NEXT_PUBLIC_API_URL at build time.

const VERSION = "v2";
const SHELL_CACHE = `breakpoint-shell-${VERSION}`;
const RUNTIME_CACHE = `breakpoint-runtime-${VERSION}`;
// API responses live in one cache per account -- see apiCacheName below.
const API_CACHE_PREFIX = `breakpoint-api-${VERSION}-`;
const CURRENT_CACHES = [SHELL_CACHE, RUNTIME_CACHE];

const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

const API_BASE = new URL(self.location.href).searchParams.get("api") ?? "";
const API_TIMEOUT_MS = 5000;

// --- helpers ----------------------------------------------------------------

function isCacheable(response) {
  // Opaque (no-cors) and partial responses must never enter the cache.
  return response && response.status === 200 && response.type !== "opaque";
}

function isApiRequest(url) {
  return API_BASE !== "" && url.href.startsWith(API_BASE);
}

/**
 * Which cache an API response belongs in.
 *
 * The Cache API keys entries by URL alone -- request headers are not part of
 * the key -- so one cache shared by two accounts hands the second one the
 * first one's data at the first slow request. Putting the account in the cache
 * *name* separates them at the storage layer instead, which no timing can get
 * around: signing in does not have to race a purge message to be safe.
 *
 * The JWT is not verified here, and does not need to be: this is a partition
 * key, and a forged one only partitions differently. The token itself never
 * becomes part of a cache name -- one we cannot read goes to a shared bucket
 * rather than leaving a credential in CacheStorage.
 */
function apiCacheName(request) {
  const auth = request.headers.get("Authorization");
  if (!auth) return `${API_CACHE_PREFIX}anon`;

  try {
    const payload = auth.slice("Bearer ".length).split(".")[1];
    const { sub } = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return `${API_CACHE_PREFIX}${sub ?? "unknown"}`;
  } catch {
    return `${API_CACHE_PREFIX}unknown`;
  }
}

function isRscRequest(request, url) {
  // Next.js client navigations fetch RSC payloads from the same URL as the
  // document. Caching those under the same key would serve a payload where a
  // document is expected, so they are left to the network.
  return url.searchParams.has("_rsc") || request.headers.get("RSC") === "1";
}

async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- strategies -------------------------------------------------------------

async function apiNetworkFirst(request) {
  const cache = await caches.open(apiCacheName(request));
  try {
    const response = await fetchWithTimeout(request, API_TIMEOUT_MS);
    if (isCacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({
        statusCode: 503,
        error: "Service Unavailable",
        message: "You are offline and this data has not been cached yet.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function navigationStrategy(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    return offline ?? Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networked = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached ?? (await networked) ?? Response.error();
}

// --- lifecycle --------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("breakpoint-") &&
                !CURRENT_CACHES.includes(key) &&
                !key.startsWith(API_CACHE_PREFIX)
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Sent by the app whenever the signed-in account changes: signing in, signing
// out, a refresh the server refused, a session revoked from another device.
//
// Per-account cache names already keep one person from reading another's data,
// so this is not what makes the app safe -- it is what keeps a season's
// finances from sitting in CacheStorage on a shared pit laptop after the
// person who loaded them has gone. Every account's API cache goes.
//
// The shell and navigation caches stay: they hold the offline page, icons and
// page shells, which belong to nobody. Pages here render on the client and
// fetch their data from the API, so a cached document carries no account data.
async function purgeApiCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((key) => key.startsWith(API_CACHE_PREFIX)).map((key) => caches.delete(key))
  );
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "purge") return;
  event.waitUntil(purgeApiCaches());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Writes are never cached or replayed — offline writes are out of scope.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (isRscRequest(request, url)) return;

  if (isApiRequest(url)) {
    event.respondWith(apiNetworkFirst(request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationStrategy(request));
    return;
  }

  // Content-hashed build output never changes under the same URL.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
});
