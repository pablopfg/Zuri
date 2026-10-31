// Zuri's service worker. It exists so the app can be installed (and, from
// step 11, to show push notices). It caches nothing and has no fetch handler:
// every page and every API answer comes from the network, so a signed-out or
// shared device never shows private data from a cache.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
