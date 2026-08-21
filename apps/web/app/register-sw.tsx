"use client";

import { useEffect } from "react";

// Registered only in production: in dev the service worker would serve stale
// chunks and fight Next's hot reload.
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // The API origin travels as a query param so the worker knows which
    // cross-origin GETs to cache for offline reads. Changing it produces a
    // different worker URL, which correctly triggers an update.
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";
    const swUrl = `/sw.js?api=${encodeURIComponent(apiBase)}`;

    navigator.serviceWorker.register(swUrl).catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  }, []);

  return null;
}
