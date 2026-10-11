/* EventSync India service worker.
 *
 *  - App shell (pages, JS, CSS, icons): cached on install and refreshed in the background, so the
 *    installed app opens with no connection.
 *  - /api/events (the event feed): network-first with a short timeout, falling back to the last cached
 *    response. If there is no cached response either, the page falls back to its Dexie/IndexedDB copy
 *    (see app/page.tsx).
 *  - /api/checkin/sync is never cached or intercepted: the app queues check-ins in IndexedDB and
 *    retries on its own, with idempotent server-side deduplication.
 *
 * Registered only in production builds (see app/page.tsx) to avoid caching stale dev chunks.
 */
const VERSION = "v2";
const SHELL_CACHE = `eventsync-shell-${VERSION}`;
const DATA_CACHE = `eventsync-data-${VERSION}`;
const SHELL_ASSETS = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(asset))),
      ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/* Network first; on failure or timeout serve the cache (or an explicit offline response). */
async function networkFirst(
  request,
  cacheName,
  timeoutMs,
  fallbackUrl,
  offlineAsJson,
) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetchWithTimeout(request, timeoutMs);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached =
      (await cache.match(request)) ||
      (fallbackUrl ? await cache.match(fallbackUrl) : undefined);
    if (cached) return cached;
    return offlineAsJson
      ? new Response(JSON.stringify({ error: "offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      : new Response("You're offline and this page isn't saved yet.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
  }
}

/* Serve from cache immediately and refresh it in the background. */
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  return fresh || new Response("", { status: 504 });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === "/api/events") {
    event.respondWith(networkFirst(request, DATA_CACHE, 4000, null, true));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, 3000, "/", false));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, request));
});
