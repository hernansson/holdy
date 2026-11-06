// Service worker: guarda la app para que abra sin conexión.
// Las consultas de precios (otro dominio) NO se guardan: siempre van a la red.
const CACHE = "holdy-v323";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "badge-96.png"];

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
    // Oportunidad: una ráfaga de notificaciones separadas (cada una suena y vibra), para que no pase desapercibida.
    for (const m of msgs) {
      if (!(m.burst > 1)) continue;
      const n = Math.min(m.burst, 25);
      for (let i = 1; i <= n; i++) {
        await self.registration.showNotification(i === 1 ? m.title : "🚨 OPORTUNIDAD " + i + "/" + n, { body: m.body || "", tag: (m.tag || "op") + "-" + i, renotify: true, silent: false, requireInteraction: i === 1, vibrate: [500, 150, 500, 150, 900], icon: "icon-192.png", badge: "badge-96.png", data: { url: "./" + (m.u || "") } });
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    msgs = msgs.filter((m) => !(m.burst > 1));
    await Promise.all(msgs.slice(-3).map((m) => self.registration.showNotification(m.title || "Holdy", { body: m.body || "", tag: m.tag || undefined, renotify: !!m.tag, silent: false, requireInteraction: !!m.ri, vibrate: m.lv === 2 ? [600, 200, 600, 200, 600, 200, 600, 200, 1200] : m.lv === 1 ? [300, 120, 300, 120, 300] : [180, 90, 180], icon: "icon-192.png", badge: "badge-96.png", data: { url: "./" + (m.u || "") } })));
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // Tocar una de la ráfaga de oportunidad borra las demás.
  const tg = e.notification.tag || "";
  if (/^cauop-/.test(tg)) { const pre = tg.replace(/-\d+$/, "-"); e.waitUntil(self.registration.getNotifications().then((l) => l.forEach((n) => { if ((n.tag || "").indexOf(pre) === 0) n.close(); }))); }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const url = (e.notification.data && e.notification.data.url) || "./";
    for (const c of list) { if ("focus" in c) { if (url !== "./" && "navigate" in c) return c.navigate(url).then((w) => (w || c).focus()).catch(() => c.focus()); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
