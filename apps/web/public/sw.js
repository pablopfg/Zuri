// Zuri's service worker. It exists so the app can be installed and, from
// step 11b, to show push notices. It caches nothing and has no fetch handler:
// every page and every API answer comes from the network, so a signed-out or
// shared device never shows private data from a cache.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Only a page of this app, never an address from outside ("/x", not "//x" nor "/\\x"). */
const internal = (link) => (typeof link === "string" && /^\/(?![/\\])[A-Za-z0-9/_-]*$/.test(link) ? link : "/");
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

// The server encrypted the message for this browser alone (RFC 8291); the
// browser opened it before this runs. Title and body are plain text: a
// notification never renders HTML. High and critical notices stay on screen.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = text(data.title, 120) || "Zuri";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: text(data.body, 600),
      tag: text(data.id, 64) || undefined,
      icon: "/icon-192.png",
      badge: "/favicon-32.png",
      requireInteraction: data.sticky === true,
      data: { link: internal(data.link) },
    }),
  );
});

// A tap opens the page the notice points to, in a window of the app already
// open when there is one. No action buttons: a security alert is answered in
// the app or on another channel, never from the notification (spec, step 13).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(internal(event.notification.data?.link), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ("navigate" in open) await open.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
