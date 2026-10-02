/* FlowFi service worker (#1330): stale-while-revalidate for static assets,
 * fonts and API GETs so streams stay viewable read-only when offline. */
const VERSION = "v1";
const STATIC_CACHE = `flowfi-static-${VERSION}`;
const API_CACHE = `flowfi-api-${VERSION}`;
const PAGES_CACHE = `flowfi-pages-${VERSION}`;
const KNOWN = [STATIC_CACHE, API_CACHE, PAGES_CACHE];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES_CACHE)
      .then((c) => c.addAll(["/", "/dashboard"]).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("flowfi-") && !KNOWN.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function notifySynced() {
  const clients = await self.clients.matchAll();
  for (const c of clients) c.postMessage({ type: "flowfi-synced", at: Date.now() });
}

function staleWhileRevalidate(request, cacheName, { announce = false } = {}) {
  return caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(request);
    const network = fetch(request)
      .then((response) => {
        if (response && response.ok) {
          cache.put(request, response.clone());
          if (announce) notifySynced();
        }
        return response;
      })
      .catch(() => undefined);
    if (cached) {
      network.catch(() => undefined);
      return cached;
    }
    return (await network) || Response.error();
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return;

  // Never cache event streams, auth or wallet traffic.
  if (request.headers.get("accept") === "text/event-stream") return;
  if (/\/(auth|events\/subscribe|sse)/.test(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(PAGES_CACHE).then((c) => c.put(request, copy));
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match("/dashboard")) || (await caches.match("/")) || Response.error()),
    );
    return;
  }

  const isApi = /\/v1\/(streams|users|stats|events)/.test(url.pathname) || url.pathname.startsWith("/api/");
  if (isApi) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE, { announce: true }));
    return;
  }

  const isStatic =
    url.origin === self.location.origin
      ? url.pathname.startsWith("/_next/static/") || /\.(?:png|svg|ico|webp|woff2?|css|js)$/.test(url.pathname)
      : /fonts\.(?:googleapis|gstatic)\.com$/.test(url.hostname);
  if (isStatic) event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});
