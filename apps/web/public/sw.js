/* eslint-env serviceworker */
// BreakPoint service worker — offline reads.
//
// Scope decision: cached GETs stay readable without a connection; writes still
// require the network. FRC venues have saturated wifi, so API reads are also
// given a short timeout — a slow network falls back to cache rather than hanging.
//
// The API origin is passed in at registration time (/sw.js?api=...) because a
// static file in public/ cannot read NEXT_PUBLIC_API_URL at build time.

const VERSION = "v1";
const SHELL_CACHE = `breakpoint-shell-${VERSION}`;
const RUNTIME_CACHE = `breakpoint-runtime-${VERSION}`;
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
  const cache = await caches.open(RUNTIME_CACHE);
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
            .filter((key) => key.startsWith("breakpoint-") && !CURRENT_CACHES.includes(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
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
