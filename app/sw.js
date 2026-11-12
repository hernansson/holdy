// Service worker: guarda la app para que abra sin conexión.
// Las consultas de precios (otro dominio) NO se guardan: siempre van a la red.
const CACHE = "holdy-v342";
const SEEN = "holdy-push"; // hasta qué aviso ya se mostró (no se borra al actualizar)
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "badge-96.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SEEN).map((k) => caches.delete(k))))
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

// Avisos (Web Push): el texto viene cifrado dentro del aviso. Si viene vacío (celu registrado antes), se lo pedimos
// al servidor con esta suscripción; el buzón no se vacía, así que guardamos hasta cuál ya mostramos (si llegan
// varios avisos seguidos, cada uno muestra el suyo en vez de "Tenés un aviso nuevo").
// Al tocar un aviso, la app abre con lo que decía (#n=…) y muestra una hoja con lo necesario.
const link = (m) => "./#n=" + encodeURIComponent(JSON.stringify({ k: m.k || "", t: m.title || "", b: m.body || "", u: m.u || "", g: m.tag || "", x: m.x || null }));
const PUSH_BASE = "https://lingering-wind-a188.hernan-ss.workers.dev";
const seenGet = async () => { try { const r = await (await caches.open(SEEN)).match("seen"); return r ? +(await r.text()) || 0 : 0; } catch (err) { return 0; } };
const seenSet = async (at) => { try { await (await caches.open(SEEN)).put("seen", new Response(String(at))); } catch (err) { /* nada */ } };
let pushChain = Promise.resolve(); // de a un aviso por vez, para no mostrar dos veces el mismo
self.addEventListener("push", (e) => {
  let data = null; try { data = e.data ? e.data.json() : null; } catch (err) { data = null; }
  pushChain = pushChain.then(() => showPush(data)).catch(() => {});
  e.waitUntil(pushChain);
});
async function showPush(data) {
  let msgs = [], quiet = false;
  const seen = await seenGet();
  if (data && (data.title || data.body)) {
    msgs = [data]; quiet = !!(data.at && data.at <= seen); // repetido: se muestra igual, sin sonar
    if (data.at > seen) await seenSet(data.at);
  } else {
    let box = [];
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) { const r = await fetch(PUSH_BASE + "/push/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ep: sub.endpoint, v: 2 }) }); const j = await r.json(); box = j.msgs || []; }
    } catch (err) { /* sin conexión */ }
    msgs = box.filter((m) => !(m.at <= seen));
    const top = box.reduce((n, m) => Math.max(n, m.at || 0), 0); if (top > seen) await seenSet(top);
    // Nada nuevo (el texto todavía no llegó al servidor de esta zona): se vuelve a mostrar el último, sin sonar, en el mismo lugar.
    if (!msgs.length && box.length) { msgs = [box[box.length - 1]]; quiet = true; }
  }
  if (!msgs.length) msgs = [{ title: "Holdy", body: "Tenés un aviso nuevo. Abrí Holdy para verlo.", tag: "holdy-generic" }];
  if (quiet) msgs = msgs.map((m) => ({ ...m, burst: 0, tag: m.tag || "h" + (m.at || 0) }));
  // Oportunidad: una ráfaga de notificaciones separadas (cada una suena y vibra), para que no pase desapercibida.
  for (const m of msgs) {
    if (!(m.burst > 1)) continue;
    const n = Math.min(m.burst, 25);
    for (let i = 1; i <= n; i++) {
      await self.registration.showNotification(i === 1 ? m.title : "🚨 OPORTUNIDAD " + i + "/" + n, { body: m.body || "", tag: (m.tag || "op") + "-" + i, renotify: true, silent: false, requireInteraction: i === 1, vibrate: [500, 150, 500, 150, 900], icon: "icon-192.png", badge: "badge-96.png", data: { url: link(m) } });
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  msgs = msgs.filter((m) => !(m.burst > 1));
  await Promise.all(msgs.slice(-5).map((m) => self.registration.showNotification(m.title || "Holdy", { body: m.body || "", tag: m.tag || undefined, renotify: !!m.tag && !quiet, silent: quiet, requireInteraction: !!m.ri, vibrate: m.lv === 2 ? [600, 200, 600, 200, 600, 200, 600, 200, 1200] : m.lv === 1 ? [300, 120, 300, 120, 300] : [180, 90, 180], icon: "icon-192.png", badge: "badge-96.png", data: { url: link(m) } })));
}
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
