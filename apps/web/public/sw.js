// HelloBox service worker: shows push notifications for new mail and opens the
// conversation when one is clicked. It caches nothing.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "HelloBox", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "New mail", {
      body: data.body || "",
      icon: "/android-chrome-192x192.png",
      badge: "/android-chrome-192x192.png",
      tag: data.tag || "hellobox",
      renotify: true,
      data: { url: data.url || "/inbox" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // The link carries the conversation's workspace (/inbox?workspace=…&thread=…), and the
  // inbox switches to it on load. Keep only its path and query, on this worker's own
  // origin: the server writes APP_URL's host, which isn't always the host this browser
  // uses (127.0.0.1 vs localhost, www or not). Comparing hosts made those clicks do
  // nothing, so the browser just raised the tab already open in another workspace.
  // Resolving on our own origin also means a push can never send anyone elsewhere.
  let target;
  try {
    const link = new URL(event.notification.data?.url || "/inbox", self.location.origin);
    target = new URL(link.pathname + link.search + link.hash, self.location.origin);
  } catch {
    target = new URL("/inbox", self.location.origin);
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      // Reuse an open HelloBox tab with a full page load, which reads the link's
      // workspace and switches to it. navigate() only works on tabs this worker
      // controls, so anything else opens a new tab rather than doing nothing.
      const open = windows.find((client) => new URL(client.url).origin === target.origin && "navigate" in client);
      const fresh = () => self.clients.openWindow(target.href);
      if (!open) return fresh();
      return open
        .navigate(target.href)
        .then((client) => (client ? client.focus() : fresh()))
        .catch(fresh);
    }),
  );
});
