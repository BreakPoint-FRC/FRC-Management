/**
 * Tells the service worker to drop every account's cached API responses.
 *
 * The worker keys its API cache by account, so two people sharing a laptop
 * cannot read each other's data even if this message never arrives. Dropping
 * the caches anyway is the second half of that: cached data outlives the
 * session it belongs to otherwise, and a laptop left in the pit is not a
 * trusted place to leave a season's finances.
 *
 * Called from `setAccessToken` whenever the signed-in account changes -- which
 * covers signing out, signing in, a refresh the server refused, and a session
 * revoked from elsewhere. A token rotating for the same account is not a
 * change, so ordinary fifteen-minute refreshes leave the offline cache alone.
 */
export function purgeApiCache(): void {
  if (typeof navigator === "undefined") return;
  navigator.serviceWorker?.controller?.postMessage({ type: "purge" });
}
