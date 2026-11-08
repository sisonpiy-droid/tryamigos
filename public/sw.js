/* Try Amigos's service worker. It does one thing: show a Muse's text when the
 * server pushes one, and open that Muse's conversation when it is tapped.
 * No caching, no offline mode -- this is not a cache.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "Try Amigos";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/solo", interactionId: data.interactionId || null },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/solo", self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    /* Try Amigos already open: bring it forward and tell it where to go, rather than
       opening a second copy beside it. */
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        c.postMessage({ type: "muse-open", url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
