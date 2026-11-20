// Filament service worker: lets the home screen app open even with a weak signal.
// Always asks the network first, skipping the browser's HTTP cache (GitHub Pages allows 10 minutes),
// so a new release shows up right away; falls back to the last copy when offline.
// Bump CACHE with VERSION in index.html on every release; the new worker takes over and the page reloads.
const CACHE = "filament-2026-11-20-c";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-180.png", "./icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "no-store" })))).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith("/filamentinventory/")) return;
  e.respondWith(fetch(e.request.url, { cache: "no-store", credentials: "same-origin" })
    .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match("./index.html"))));
});
