/*
 * The phone's app shell.
 *
 * Without this, every cold tap on the home-screen icon blocks on fetching the
 * whole bundle from the Mac over the tailnet, and a Mac that is asleep gives
 * Safari's "cannot connect" page instead of an app. Here the shell paints from
 * cache first and the network catches up behind it, so an unreachable host
 * shows Argmax saying it is reconnecting — which is the honest signal, and one
 * the page already knows how to render.
 *
 * Registered only from the mobile entry, and only in a secure context: service
 * workers need one, so over plain HTTP this file is never installed. See
 * docs/remote.md.
 */
const CACHE = "argmax-shell-v3";

/* Unhashed, so they are named here rather than discovered. Everything else is
   content-hashed and gets cached the first time it is asked for. */
const SHELL = ["/mobile.html", "/manifest.webmanifest", "/argmax-icon.png"];

/**
 * The scripts and stylesheets `mobile.html` loads eagerly, read out of the
 * document itself.
 *
 * They have to be taken at install, not left to the fetch handler: the
 * navigation that registers a worker is not controlled by it, so nothing else
 * would ever pull them in. Installing and then losing the host — which is the
 * whole case this exists for — otherwise left a cached document whose scripts
 * were all misses, and a white screen. Lazy chunks stay out; they are fetched
 * on demand and the review screen already survives a missing one.
 */
function entryAssets(html) {
  const urls = new Set();
  // Vite writes these relative (`./assets/…`), so both spellings are accepted
  // and resolved against the document rather than assumed absolute.
  for (const match of html.matchAll(/(?:src|href)="(\.?\/assets\/[^"]+)"/g)) {
    urls.add(new URL(match[1], self.location.origin + "/mobile.html").pathname);
  }
  return [...urls];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` so an install never adopts whatever the HTTP cache is holding.
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })));
      const document = await cache.match("/mobile.html");
      if (document) {
        const assets = entryAssets(await document.text());
        // Individually: one asset the server has dropped must not fail the
        // whole install and leave the phone with no shell at all.
        await Promise.all(
          assets.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => undefined))
        );
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/** Hashed build output. A new build means a new URL, so a hit can never be stale. */
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/");
}

/**
 * The bridge itself: RPC, the WebSocket upgrade, attachments and workspace
 * assets. All of it is authenticated and live, and none of it may be served
 * from a cache.
 */
function isBridge(url) {
  return url.pathname.startsWith("/api/");
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Paint from cache, refresh behind it. The revalidation is deliberately not
 * awaited: waiting on a sleeping Mac is the delay this exists to remove.
 * A chunk the refreshed document no longer references is handled by
 * importChunk.ts, which reloads once when its hash is gone.
 */
async function shellFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const response = await network;
  if (response) return response;
  // First run with no cache and no host: let the browser report it.
  return Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isBridge(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(shellFirst(new Request("/mobile.html", { cache: "no-store" })));
    return;
  }
  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});
