// Service worker: guarda la app para que abra sin conexión.
// Las consultas de precios (otro dominio) NO se guardan: siempre van a la red.
const CACHE = "holdy-v209";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // precios: directo a la red
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
  );
});

// Avisos (Web Push): el aviso llega sin texto; se lo pedimos al servidor con esta suscripción y se muestra.
const PUSH_BASE = "https://lingering-wind-a188.hernan-ss.workers.dev";
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let msgs = [];
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) { const r = await fetch(PUSH_BASE + "/push/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ep: sub.endpoint }) }); const j = await r.json(); msgs = j.msgs || []; }
    } catch (err) { /* sin conexión */ }
    if (!msgs.length) msgs = [{ title: "Holdy", body: "Tenés un aviso nuevo." }];
    await Promise.all(msgs.slice(-3).map((m) => self.registration.showNotification(m.title || "Holdy", { body: m.body || "", tag: m.tag || undefined, icon: "icon-192.png", badge: "icon-192.png", data: { url: "./" } })));
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow("./");
  }));
});
