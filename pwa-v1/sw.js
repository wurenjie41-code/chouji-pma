const scopeNamespace = new URL(self.registration.scope).pathname.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "root";
const CACHE_PREFIX = `chouji-shell-${scopeNamespace}-`;
const CACHE_NAME = `${CACHE_PREFIX}v1-15`;
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./src/app.js", "./src/intake.js", "./src/receipt.js", "./src/game-icons.js", "./src/storage.js", "./src/styles.css", "./icons/icon.svg", "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const vendor = new URL('./vendor/', self.registration.scope);
    const isVendor = url.pathname.startsWith(vendor.pathname);
    const modelCache = isVendor ? await caches.open('chouji-ocr-models-v1') : cache;
    const cached = await modelCache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok && isVendor) await modelCache.put(event.request, response.clone());
    return response;
  })());
});

