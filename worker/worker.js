// Holdy – proxy de precios (Cloudflare Worker)
//
// Recibe  GET /quote?symbol=AAPL  desde Holdy, consulta Finnhub con la clave guardada
// como secreto (FINNHUB_KEY) y devuelve la misma respuesta de Finnhub: {c, d, dp, h, l, o, pc, t}.
// La clave nunca viaja al navegador ni está en este archivo.
// Si Finnhub no tiene el símbolo (ETFs europeos como VUAA o EQAC), se consulta Yahoo Finance como respaldo.

// Páginas autorizadas a usar este proxy desde un navegador (CORS).
// Si publicás Holdy en otra dirección, agregala acá.
const ALLOWED_ORIGINS = ["https://hernansson.github.io", "https://holdy.pages.dev"];

// ID de cliente de Google (OAuth, público). Se completa al crearlo en Google Cloud.
const GOOGLE_CLIENT_ID = "554911510319-s9etahete05ilh86dd2r2bfnilq1jgkm.apps.googleusercontent.com";

// Tiempo que se reutiliza un precio ya consultado, para no gastar el límite gratuito de Finnhub.
// Es una memoria por instancia del Worker: ayuda, pero Cloudflare puede reiniciarla en cualquier momento.
const TTL_MS = 60 * 1000;
const MAX_CACHED = 500;
const cache = new Map();
// EQAC (EQQQ Nasdaq-100 Acc en dólares) cotiza en la bolsa suiza (.SW), no en Londres.
const ALIAS = { EQAC: "EQAC.SW" };
const HIST_TTL_MS = 6 * 60 * 60 * 1000;
const histCache = new Map();

export default {
  // Todas las mañanas (cron en wrangler.toml): trae el reporte de IBKR de cada usuario conectado y lo deja listo.
  // Una sola tarea por hora (minuto 35); según la hora hace cada cosa. 11 y 14 UTC: IBKR · 12 UTC: cobros · 21 UTC (lun-vie): cierre.
  async scheduled(event, env, ctx) {
    const d = new Date(event.scheduledTime || Date.now()), h = d.getUTCHours(), wd = d.getUTCDay();
    if (h === 11 || h === 14) ctx.waitUntil(ibCron(env));
    if (h === 12) ctx.waitUntil(pushCobros(env));
    if (h === 21 && wd >= 1 && wd <= 5) ctx.waitUntil(pushClose(env)); // 18:35 de Argentina: ya cerró Wall Street todo el año
  },
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const originOk = !origin || ALLOWED_ORIGINS.includes(origin);
    const cors = { Vary: "Origin" };
    if (origin && originOk) cors["Access-Control-Allow-Origin"] = origin;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Holdy-Secret, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (!originOk) return json({ error: "origin_not_allowed" }, 403, cors);

    const url = new URL(request.url);
    if (url.pathname.startsWith("/p/")) return profile(request, env, url, cors, ctx);
    if (url.pathname.startsWith("/fx/")) return social(request, env, url, cors, ctx);
    if (url.pathname.startsWith("/auth/") || url.pathname === "/me/data" || url.pathname.startsWith("/me/ibkr") || url.pathname.startsWith("/me/push") || url.pathname === "/me/ask" || url.pathname === "/me/profile") return account(request, env, url, cors);
    if (url.pathname === "/push/inbox" && request.method === "POST") return pushInbox(request, env, cors);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
    if (url.pathname.startsWith("/av/")) return avatar(url, env, cors);
    if (url.pathname === "/history") return history(url, cors);
    if (url.pathname === "/divs") return divs(url, cors);
    if (url.pathname === "/push/key") return pushKey(env, cors);
    if (url.pathname === "/fx") return fxHistory(cors);
    if (url.pathname === "/insight") return insight(url, env, cors);
    if (url.pathname === "/search") return searchSym(url, env, cors);
    if (url.pathname !== "/quote") return json({ error: "not_found" }, 404, cors);

    const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return json({ error: "bad_symbol" }, 400, cors);
    if (!env.FINNHUB_KEY) return json({ error: "not_configured" }, 500, cors);

    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < TTL_MS) return json(hit.data, 200, cors, "HIT");

    const store = (data) => {
      cache.set(symbol, { at: Date.now(), data });
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
      return json(data, 200, cors, "MISS");
    };

    // Símbolos con punto (VUAA.L, VUAA.DE) son de otras bolsas: Finnhub gratis no los tiene, van directo a Yahoo.
    if (!symbol.includes(".")) {
      let upstream;
      try {
        upstream = await fetch(
          "https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(symbol) +
          "&token=" + encodeURIComponent(env.FINNHUB_KEY)
        );
      } catch (e) {
        return json({ error: "upstream_unreachable" }, 502, cors);
      }
      if (upstream.status === 429) return json({ error: "rate_limited" }, 429, cors);
      if (upstream.status === 401) return json({ error: "server_key_invalid" }, 503, cors);
      if (upstream.ok) {
        const data = await upstream.json();
        if (typeof data.c === "number" && data.c > 0) return store({ ...data, currency: "USD", source: "finnhub" });
      } else if (upstream.status !== 403) {
        return json({ error: "upstream_" + upstream.status }, 502, cors);
      }
    }

    // Respaldo: Yahoo Finance. Sin punto se prueba la bolsa de Londres (.L) y la suiza (.SW); VUAA cotiza en Londres y EQAC en Suiza, ambos en dólares.
    const candidates = symbol.includes(".") ? [symbol] : (ALIAS[symbol] ? [ALIAS[symbol]] : [symbol + ".L", symbol + ".SW"]);
    for (const c of candidates) {
      const q = await yahooQuote(c);
      if (q) return store(q);
    }
    return json({ c: 0, error: "no_price" }, 200, cors, "MISS");
  },
};

// Precio desde Yahoo Finance (no oficial). Devuelve el mismo formato que Finnhub más la moneda real de cotización.
async function yahooQuote(symbol) {
  try {
    const r = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=5d&interval=1d",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; Holdy/1.0)", "Accept": "application/json" } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!m || typeof m.regularMarketPrice !== "number") return null;
    let price = m.regularMarketPrice;
    let prev = typeof m.chartPreviousClose === "number" ? m.chartPreviousClose : (typeof m.previousClose === "number" ? m.previousClose : null);
    let cur = String(m.currency || "").trim();
    if (cur === "GBp" || cur === "GBX") { price /= 100; if (prev !== null) prev /= 100; cur = "GBP"; }
    cur = cur.toUpperCase();
    if (!(price > 0)) return null;
    const out = { c: price, currency: cur, source: "yahoo", t: typeof m.regularMarketTime === "number" ? m.regularMarketTime : 0 };
    if (prev !== null && prev > 0) { out.pc = prev; out.d = price - prev; out.dp = (price - prev) / prev * 100; }
    return out;
  } catch (e) {
    return null;
  }
}

function json(body, status, headers, cacheState) {
  const h = { "Content-Type": "application/json; charset=utf-8", ...headers };
  if (cacheState) h["X-Holdy-Cache"] = cacheState;
  return new Response(JSON.stringify(body), { status, headers: h });
}

// ---------- Perfiles compartidos por código ----------
// Requiere un KV namespace enlazado con el nombre HOLDY_KV.
//   GET    /p/CODIGO                      -> devuelve el perfil (lo puede leer cualquiera que tenga el código)
//   PUT    /p/CODIGO  + X-Holdy-Secret    -> crea o actualiza (solo quien tiene el secreto)
//   DELETE /p/CODIGO  + X-Holdy-Secret    -> deja de compartir
// El secreto se guarda solo como hash SHA-256.
const MAX_BODY = 64 * 1024;
const TTL_PROFILE = 60 * 60 * 24 * 365; // se renueva en cada actualización

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function profile(request, env, url, cors, ctx) {
  if (!env.HOLDY_KV) return json({ error: "sync_not_configured" }, 501, cors);
  const parts = url.pathname.slice(3).split("/"), code = decodeURIComponent(parts[0] || ""), sub = parts[1] || "";
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) return json({ error: "bad_code" }, 400, cors);
  const key = "p:" + code, vkey = "pv:" + code;
  const stored = await env.HOLDY_KV.get(key, "json");
  const nostore = { ...cors, "Cache-Control": "no-store" };

  if (request.method === "GET" && !sub) {
    if (!stored) return json({ error: "not_found" }, 404, nostore);
    // Quién mira: si viene con sesión de Holdy, se anota (nombre, email, última vez). El dueño puede quitarle el acceso.
    // Para ver una cartera compartida hay que haber entrado a Holdy (así se sabe quién mira y se puede quitar el acceso).
    {
      const u = await sessionUser(request, env);
      if (!u) return json({ error: "login_required" }, 401, nostore);
      {
        const pv = (await env.HOLDY_KV.get(vkey, "json")) || { v: {}, b: [] };
        if ((pv.b || []).includes(u.sub)) return json({ error: "revoked" }, 403, nostore);
        const now = Date.now(), cur = pv.v[u.sub];
        // Configuración de lo que ve: la suya, o la "por defecto" la primera vez (se copia y queda fija).
        const cfg = cleanCfg(cur && cur.c ? cur.c : (pv.d || {}), cur && cur.c ? null : now);
        if (cfg.x && now > cfg.x) return json({ error: "revoked", why: "expired" }, 403, nostore);
        if (!cur || now - cur.l > 60 * 60 * 1000 || cur.e !== u.email || !cur.c) {
          pv.v[u.sub] = { n: u.name || "", e: u.email || "", f: cur ? cur.f : now, l: now, c: cfg, k: (cur && cur.k) || (0.35 + Math.random() * 2.6) };
          await env.HOLDY_KV.put(vkey, JSON.stringify(pv), { expirationTtl: TTL_PROFILE });
        }
        return json({ data: viewFor(stored.data, cfg, pv.v[u.sub].k), updated: stored.updated }, 200, nostore);
      }
    }
  }

  const secret = request.headers.get("X-Holdy-Secret") || "";
  if (secret.length < 16 || secret.length > 100) return json({ error: "bad_secret" }, 400, cors);
  const hash = await sha256(secret);
  if (stored && stored.secretHash !== hash) return json({ error: "forbidden" }, 403, cors);

  // Solo el dueño (con el secreto): ver quién mira y quitarle el acceso a alguien.
  if (sub === "viewers" && request.method === "GET") {
    const pv = (await env.HOLDY_KV.get(vkey, "json")) || { v: {}, b: [] };
    const list = Object.keys(pv.v).map((k) => ({ id: k.slice(-12), n: pv.v[k].n, e: pv.v[k].e, f: pv.v[k].f, l: pv.v[k].l, c: cleanCfg(pv.v[k].c || pv.d || {}) })).sort((a, b) => b.l - a.l);
    return json({ viewers: list, blocked: (pv.b || []).length, def: cleanCfg(pv.d || {}) }, 200, nostore);
  }
  if (sub === "cfg" && request.method === "POST") {
    let b; try { b = JSON.parse(await request.text()); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
    const pv = (await env.HOLDY_KV.get(vkey, "json")) || { v: {}, b: [] };
    const inC = { ...((b && b.c) || {}), x: 0 };
    if (b && b.id === "default") pv.d = cleanCfg(inC);
    else {
      const full = Object.keys(pv.v).find((k) => k.slice(-12) === String((b && b.id) || ""));
      if (!full) return json({ error: "not_found" }, 404, nostore);
      const old = pv.v[full].c || {};
      // El vencimiento corre desde que lo elegís; si no cambiaste los días, se mantiene.
      pv.v[full].c = cleanCfg(+old.d === +inC.d && old.x ? { ...inC, x: old.x } : inC, Date.now());
    }
    await env.HOLDY_KV.put(vkey, JSON.stringify(pv), { expirationTtl: TTL_PROFILE });
    return json({ ok: true }, 200, nostore);
  }
  if (sub === "block" && request.method === "POST") {
    let b; try { b = JSON.parse(await request.text()); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
    const pv = (await env.HOLDY_KV.get(vkey, "json")) || { v: {}, b: [] };
    const full = Object.keys(pv.v).find((k) => k.slice(-12) === String((b && b.id) || ""));
    if (!full) return json({ error: "not_found" }, 404, nostore);
    delete pv.v[full]; pv.b = (pv.b || []).concat(full).slice(-200);
    await env.HOLDY_KV.put(vkey, JSON.stringify(pv), { expirationTtl: TTL_PROFILE });
    return json({ ok: true }, 200, nostore);
  }
  if (sub) return json({ error: "not_found" }, 404, cors);

  if (request.method === "DELETE") {
    if (stored) await env.HOLDY_KV.delete(key);
    await env.HOLDY_KV.delete(vkey);
    return json({ ok: true }, 200, cors);
  }
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: "too_large" }, 413, cors);
    let data;
    try { data = JSON.parse(text); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
    if (!data || data.v !== 2 || !Array.isArray(data.p) || data.p.length > 300) return json({ error: "bad_data" }, 400, cors);
    const updated = Date.now();
    // Dueño: si sube con sesión de Holdy se guarda quién es (para avisarle de comentarios y reacciones).
    const u = await sessionUser(request, env);
    const o = u ? { s: u.sub, n: await dispName(env, u) } : (stored && stored.o) || null;
    await env.HOLDY_KV.put(key, JSON.stringify({ secretHash: hash, data, updated, o }), { expirationTtl: TTL_PROFILE });
    // Movimientos nuevos (compras/ventas de los últimos 10 días que antes no estaban): aviso a quienes miran esta cartera.
    if (stored && stored.data && ctx) ctx.waitUntil(notifyMoves(env, code, stored.data, data, o).catch(() => {}));
    return json({ ok: true, updated }, 200, cors);
  }
  return json({ error: "method_not_allowed" }, 405, cors);
}

// ---------- Cuenta con Google y cartera sincronizada ----------
//   POST   /auth/google   {credential}        -> verifica el token de Google y devuelve una sesión propia
//   POST   /auth/logout   (Bearer sesión)     -> cierra la sesión
//   GET    /me/data       (Bearer sesión)     -> {doc, updated}
//   PUT    /me/data       (Bearer sesión)     -> {doc, base}; 409 si hay una versión más nueva
const SESSION_TTL = 60 * 60 * 24 * 30;
const MAX_DOC = 200 * 1024;
let certCache = { at: 0, keys: null };

function b64uToBytes(t) {
  t = t.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const s = atob(t), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function randHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function googleKeys(force) {
  if (!force && certCache.keys && Date.now() - certCache.at < 3600 * 1000) return certCache.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("certs");
  const j = await r.json();
  certCache = { at: Date.now(), keys: j.keys || [] };
  return certCache.keys;
}

// Verifica un ID token de Google (RS256): firma, emisor, destinatario y vencimiento.
async function verifyGoogle(token) {
  if (!GOOGLE_CLIENT_ID) throw new Error("not_configured");
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || token.length > 5000) throw new Error("bad_token");
  const dec = (p) => JSON.parse(new TextDecoder().decode(b64uToBytes(p)));
  const header = dec(parts[0]), p = dec(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("bad_token");
  let keys = await googleKeys(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await googleKeys(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("bad_token");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad_token");
  const now = Math.floor(Date.now() / 1000);
  if (p.iss !== "accounts.google.com" && p.iss !== "https://accounts.google.com") throw new Error("bad_token");
  if (p.aud !== GOOGLE_CLIENT_ID) throw new Error("bad_token");
  if (!(p.exp > now) || (p.iat && p.iat > now + 300)) throw new Error("expired");
  if (!p.sub || typeof p.sub !== "string") throw new Error("bad_token");
  return { sub: p.sub, email: p.email_verified ? String(p.email || "") : "", name: String(p.name || "").slice(0, 80) };
}

async function sessionUser(request, env) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") || "");
  if (!m) return null;
  const rec = await env.HOLDY_KV.get("s:" + (await sha256(m[1])), "json");
  return rec ? { sub: rec.sub, email: rec.email, name: rec.name, token: m[1] } : null;
}

async function account(request, env, url, cors) {
  if (!env.HOLDY_KV) return json({ error: "sync_not_configured" }, 501, cors);
  const nostore = { ...cors, "Cache-Control": "no-store" };

  if (url.pathname === "/auth/google" && request.method === "POST") {
    let body;
    try { body = JSON.parse(await request.text()); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
    let u;
    try { u = await verifyGoogle(body && body.credential); }
    catch (e) {
      const m = e && e.message;
      if (m === "not_configured") return json({ error: "login_not_configured" }, 501, cors);
      return json({ error: m === "expired" ? "expired" : "bad_token" }, 401, cors);
    }
    const session = randHex(32);
    await env.HOLDY_KV.put("s:" + (await sha256(session)), JSON.stringify(u), { expirationTtl: SESSION_TTL });
    return json({ session, email: u.email, name: u.name }, 200, nostore);
  }

  const user = await sessionUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401, nostore);

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    await env.HOLDY_KV.delete("s:" + (await sha256(user.token)));
    return json({ ok: true }, 200, nostore);
  }

  if (url.pathname === "/me/ibkr" || url.pathname === "/me/ibkr/sync") return ibkr(request, env, url, user, nostore);
  if (url.pathname.startsWith("/me/push")) return pushMe(request, env, url, user, nostore);
  if (url.pathname === "/me/ask" && request.method === "POST") return ask(request, env, nostore);
  if (url.pathname === "/me/profile") return meProfile(request, env, user, nostore);

  if (url.pathname === "/me/data") {
    const key = "u:" + user.sub;
    const stored = await env.HOLDY_KV.get(key, "json");
    if (request.method === "GET") {
      if (!stored) return json({ doc: null, updated: 0 }, 200, nostore);
      return json({ doc: stored.doc, updated: stored.updated }, 200, nostore);
    }
    if (request.method === "PUT") {
      const text = await request.text();
      if (text.length > MAX_DOC) return json({ error: "too_large" }, 413, cors);
      let body;
      try { body = JSON.parse(text); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
      if (!body || !body.doc || typeof body.doc !== "object" || !Array.isArray(body.doc.profiles) || body.doc.profiles.length > 50) return json({ error: "bad_data" }, 400, cors);
      const base = +body.base || 0;
      if (stored && stored.updated > base) return json({ error: "conflict", doc: stored.doc, updated: stored.updated }, 409, nostore);
      const updated = Math.max(Date.now(), (stored ? stored.updated : 0) + 1);
      await env.HOLDY_KV.put(key, JSON.stringify({ doc: body.doc, updated }));
      return json({ ok: true, updated }, 200, nostore);
    }
  }
  return json({ error: "not_found" }, 404, cors);
}

// ---------- Historial de precios (para comparar rendimientos) ----------
//   GET /history?symbols=AAPL,VUAA&from=2025-01-01  ->  { data: { AAPL: { currency, pts: [["2025-01-02", 243.1, 242.8], ...] } } }
// Por día: [fecha, cierre, cierre ajustado por dividendos y splits], desde Yahoo Finance (no oficial).
async function history(url, cors) {
  const syms = (url.searchParams.get("symbols") || "").toUpperCase().split(",").map((x) => x.trim()).filter(Boolean);
  if (!syms.length || syms.length > 20 || syms.some((x) => !/^[A-Z0-9.\-]{1,12}$/.test(x))) return json({ error: "bad_symbols" }, 400, cors);
  const from = url.searchParams.get("from") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return json({ error: "bad_from" }, 400, cors);
  const t0 = Date.parse(from + "T00:00:00Z");
  const floor = Date.now() - 5 * 365 * 86400000;
  const p1 = Math.floor(Math.max(t0 - 7 * 86400000, floor) / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const out = {};
  await Promise.all(syms.map(async (sym) => {
    const key = sym + "|" + new Date(p1 * 1000).toISOString().slice(0, 10);
    const hit = histCache.get(key);
    if (hit && Date.now() - hit.at < HIST_TTL_MS) { out[sym] = hit.data; return; }
    const cands = sym.includes(".") ? [sym] : (ALIAS[sym] ? [ALIAS[sym]] : [sym, sym + ".L", sym + ".SW"]);
    for (const c of cands) {
      const d = await yahooHistory(c, p1, p2);
      if (d) {
        histCache.set(key, { at: Date.now(), data: d });
        if (histCache.size > 300) histCache.delete(histCache.keys().next().value);
        out[sym] = d;
        return;
      }
    }
    out[sym] = null;
  }));
  return json({ data: out }, 200, cors);
}

async function yahooHistory(symbol, p1, p2) {
  try {
    const r = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?period1=" + p1 + "&period2=" + p2 + "&interval=1d",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; Holdy/1.0)", "Accept": "application/json" } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !Array.isArray(res.timestamp) || !res.indicators || !res.indicators.quote || !res.indicators.quote[0]) return null;
    const closes = res.indicators.quote[0].close || [];
    const adjs = (res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || [];
    const off = (res.meta && typeof res.meta.gmtoffset === "number") ? res.meta.gmtoffset : 0;
    let cur = String((res.meta && res.meta.currency) || "").trim();
    let k = 1;
    if (cur === "GBp" || cur === "GBX") { k = 0.01; cur = "GBP"; }
    const pts = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      const c = closes[i];
      if (typeof c !== "number" || !(c > 0)) continue;
      const a = (typeof adjs[i] === "number" && adjs[i] > 0) ? adjs[i] : c;
      pts.push([new Date((res.timestamp[i] + off) * 1000).toISOString().slice(0, 10), Math.round(c * k * 1e6) / 1e6, Math.round(a * k * 1e6) / 1e6]);
    }
    if (pts.length < 2) return null;
    return { currency: cur.toUpperCase(), pts };
  } catch (e) {
    return null;
  }
}

// Historial diario de dólar CCL y MEP (argentinadatos.com), por si el navegador no lo puede pedir directo.
let fxCache = null;
async function fxHistory(cors) {
  if (fxCache && Date.now() - fxCache.at < 6 * 60 * 60 * 1000) return json(fxCache.data, 200, cors, "HIT");
  try {
    const get = async (casa) => {
      const r = await fetch("https://api.argentinadatos.com/v1/cotizaciones/dolares/" + casa, { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error(String(r.status));
      const a = await r.json();
      return (Array.isArray(a) ? a : []).filter((x) => x && String(x.fecha) >= "2018-01-01").map((x) => ({ fecha: x.fecha, venta: x.venta, compra: x.compra }));
    };
    const [ccl, mep] = await Promise.all([get("contadoconliqui"), get("bolsa")]);
    const data = { ccl, mep };
    fxCache = { at: Date.now(), data };
    return json(data, 200, cors, "MISS");
  } catch (e) {
    return json({ error: "fx_unavailable" }, 502, cors);
  }
}

// ---------- /insight?symbol=AAPL: qué pasó con la acción ----------
// Junta noticias del último mes y la opinión de los analistas (Finnhub, plan gratis), el precio de un año (Yahoo)
// y le pide a Workers AI (cupo gratis diario de Cloudflare; binding "AI") un resumen en castellano.
// Se guarda 12 h en el KV (HOLDY_KV) para no repetir el trabajo.
const INS_TTL = 12 * 60 * 60;
const insMem = new Map();
// ETFs conocidos: qué siguen y con qué índice se comparan las noticias.
const ETF_INFO = {
  SPY: "Sigue al S&P 500: las 500 empresas más grandes de EE.UU.", VOO: "Sigue al S&P 500: las 500 empresas más grandes de EE.UU.",
  IVV: "Sigue al S&P 500: las 500 empresas más grandes de EE.UU.", VUAA: "Sigue al S&P 500 (versión que reinvierte los dividendos, cotiza en Londres).",
  CSPX: "Sigue al S&P 500 (versión que reinvierte los dividendos, cotiza en Londres).", QQQ: "Sigue al Nasdaq-100: las 100 empresas no financieras más grandes del Nasdaq, sobre todo tecnológicas.",
  EQAC: "Sigue al Nasdaq-100 (versión que reinvierte los dividendos, cotiza en Suiza).", DIA: "Sigue al Dow Jones: 30 empresas grandes y tradicionales de EE.UU.",
  IWM: "Sigue al Russell 2000: 2.000 empresas chicas de EE.UU.", VTI: "Sigue a todo el mercado de acciones de EE.UU.",
  XLF: "Sector financiero del S&P 500: bancos, aseguradoras y tarjetas.", XLK: "Sector tecnológico del S&P 500.", XLE: "Sector energético del S&P 500: petroleras y gas.",
  XLV: "Sector salud del S&P 500: laboratorios y empresas médicas.", XLY: "Consumo discrecional del S&P 500 (Amazon, Tesla, comercios).", XLP: "Consumo básico del S&P 500 (alimentos, supermercados).",
  XLI: "Sector industrial del S&P 500.", XLU: "Empresas de servicios públicos del S&P 500 (luz, gas, agua).", XLB: "Materiales del S&P 500 (químicas, minería).",
  XLRE: "Sector inmobiliario del S&P 500.", XLC: "Comunicaciones del S&P 500 (Alphabet, Meta, Netflix).", SMH: "Empresas de semiconductores (chips).",
  EEM: "Acciones de países emergentes.", EWZ: "Acciones de Brasil.", GLD: "Sigue al precio del oro.", SLV: "Sigue al precio de la plata.", ARKK: "Empresas de innovación elegidas por ARK Invest.",
  TLT: "Bonos del Tesoro de EE.UU. a más de 20 años.", IBIT: "Sigue al precio del bitcoin.",
};
const AI_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"];

async function insight(url, env, cors) {
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return json({ error: "bad_symbol" }, 400, cors);
  if (!env.FINNHUB_KEY) return json({ error: "not_configured" }, 500, cors);
  const day = new Date().toISOString().slice(0, 10);
  const key = "ins5:" + symbol + ":" + day;
  const mem = insMem.get(key);
  if (mem) return json(mem, 200, cors, "HIT");
  if (env.HOLDY_KV) {
    const kv = await env.HOLDY_KV.get(key, "json");
    if (kv) { insMem.set(key, kv); return json(kv, 200, cors, "HIT"); }
  }
  const fh = async (path) => {
    try {
      const r = await fetch("https://finnhub.io/api/v1/" + path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(env.FINNHUB_KEY));
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };
  const base = symbol.split(".")[0];
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  const ycands = symbol.includes(".") ? [symbol] : (ALIAS[symbol] ? [ALIAS[symbol]] : [symbol, symbol + ".L", symbol + ".SW"]);
  const [news, recs, prof, hist, gen] = await Promise.all([
    fh("company-news?symbol=" + base + "&from=" + from + "&to=" + day),
    fh("stock/recommendation?symbol=" + base),
    fh("stock/profile2?symbol=" + base),
    (async () => { for (const c of ycands) { const d = await yahooHistory(c, now - 372 * 86400, now + 86400); if (d) return d; } return null; })(),
    ETF_INFO[base] ? fh("news?category=general") : null,
  ]);
  // ETF: no es una empresa. Se usan las noticias generales del mercado (y las del ticker si hay).
  const etf = ETF_INFO[base] || ((!prof || !prof.name) && hist ? "Es un ETF o fondo que cotiza en bolsa." : "");

  // Precio: cambios y rango de 52 semanas.
  let px = null;
  if (hist && hist.pts.length > 5) {
    const pts = hist.pts, last = pts[pts.length - 1][1];
    const back = (days) => { const t = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); let v = pts[0][1]; for (const p of pts) { if (p[0] <= t) v = p[1]; else break; } return v; };
    const closes = pts.map((p) => p[1]);
    px = { last, cur: hist.currency, w1: last / back(7) - 1, m1: last / back(30) - 1, m3: last / back(91) - 1, y1: last / back(365) - 1,
      lo: Math.min(...closes), hi: Math.max(...closes), spark: pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1).map((p) => p[1]) };
  }

  // Analistas: el mes más reciente.
  let rec = null;
  if (Array.isArray(recs) && recs.length) {
    const r = recs.slice().sort((a, b) => (a.period < b.period ? 1 : -1))[0];
    const n = (r.strongBuy || 0) + (r.buy || 0) + (r.hold || 0) + (r.sell || 0) + (r.strongSell || 0);
    if (n > 0) rec = { period: r.period, sb: r.strongBuy || 0, b: r.buy || 0, h: r.hold || 0, s: r.sell || 0, ss: r.strongSell || 0, n };
  }

  // Noticias: sin repetidos, las más recientes primero.
  const seen = new Set();
  const cutoff = Date.now() / 1000 - 30 * 86400;
  // De las noticias generales, solo las de mercado y economía (no política internacional suelta).
  const MKT = /\b(stocks?|market|wall street|s&p|nasdaq|dow|fed|federal reserve|powell|rates?|inflation|cpi|ppi|jobs|payrolls|unemployment|gdp|recession|treasur|yields?|bonds?|earnings|tariffs?|oil|crude|dollar|economy|economic|equities|rally|sell-?off|index|etf|investors?|shares)\b/i;
  const pool = (Array.isArray(news) ? news : []).concat(etf && Array.isArray(gen) ? gen.filter((x) => x && x.datetime > cutoff && MKT.test((x.headline || "") + " " + (x.summary || ""))) : []);
  const items = pool.filter((x) => x && x.headline && x.url)
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
    .filter((x) => { const k = x.headline.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 40)
    .map((x) => ({ t: String(x.headline).slice(0, 220), s: String(x.summary || "").slice(0, 300), src: String(x.source || ""), d: new Date((x.datetime || 0) * 1000).toISOString().slice(0, 10), u: String(x.url) }));

  const out = { symbol, name: (prof && prof.name) || "", industry: (prof && prof.finnhubIndustry) || "", etf: etf || "", px, rec: etf ? null : rec, news: items.slice(0, 10).map(({ s, ...r }) => r), ai: null, day };

  // Resumen con IA (si el Worker tiene el binding "AI").
  if (env.AI && (items.length || px)) {
    const pct = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
    const ctx = [
      etf ? "ETF: " + symbol + ". " + etf + " Explicá qué movió al mercado o a ese índice/sector en el último mes, no a una empresa en particular." : "Empresa: " + (out.name || symbol) + " (" + symbol + ")" + (out.industry ? ", sector " + out.industry : ""),
      px ? "Precio: " + px.last.toFixed(2) + " " + px.cur + ". Cambio 1 semana " + pct(px.w1) + ", 1 mes " + pct(px.m1) + ", 3 meses " + pct(px.m3) + ", 1 año " + pct(px.y1) + ". Rango 52 semanas " + px.lo.toFixed(2) + " a " + px.hi.toFixed(2) + "." : "",
      rec ? "Analistas (" + rec.period + "): " + (rec.sb + rec.b) + " compra, " + rec.h + " mantener, " + (rec.s + rec.ss) + " venta, de " + rec.n + "." : "",
      "Noticias del último mes (fecha · título · resumen):",
      ...items.slice(0, 25).map((x) => "- " + x.d + " · " + x.t + (x.s ? " · " + x.s : "")),
    ].filter(Boolean).join("\n");
    const sys = "Sos un analista financiero que le explica a un inversor argentino, en castellano rioplatense simple y sin jerga, qué pasó con una acción. " +
      "Usá SOLO los datos que te doy; si no alcanzan para explicar un movimiento, decilo. No inventes cifras ni hechos. No recomiendes comprar ni vender. " +
      "Respondé SOLO con un JSON válido: {\"resumen\": \"3 a 5 oraciones: por qué subió o bajó en el último mes y qué está pasando con la empresa\", " +
      "\"aFavor\": [\"hasta 3 puntos positivos, cortos\"], \"enContra\": [\"hasta 3 riesgos o puntos negativos, cortos\"], " +
      "\"titulares\": [\"los primeros 8 títulos de noticias TRADUCIDOS al castellano (nunca en inglés), en el mismo orden\"]}. " +
      "Escribí los números al estilo argentino: coma decimal (3,3%) y US$ para los dólares.";
    for (const model of AI_MODELS) {
      try {
        const r = await env.AI.run(model, { messages: [{ role: "system", content: sys }, { role: "user", content: ctx }], max_tokens: 1100, temperature: 0.3 });
        const txt = typeof r === "string" ? r : (r && (typeof r.response === "string" ? r.response : JSON.stringify(r.response || "")));
        const ai = parseAi(txt);
        if (ai) { out.ai = { ...ai, model: model.split("/").pop() }; break; }
      } catch (e) { /* probamos el siguiente modelo */ }
    }
    // Si los títulos volvieron sin traducir, se piden aparte (una línea por título).
    const heads = out.news.slice(0, 8).map((x) => x.t);
    if (out.ai && heads.length && (!out.ai.titulares || out.ai.titulares.length < heads.length || out.ai.titulares.some((t, i) => t.trim().toLowerCase() === heads[i].trim().toLowerCase()))) {
      try {
        const r = await env.AI.run(AI_MODELS[0], { messages: [
          { role: "system", content: "Traducí al castellano rioplatense cada título de noticia financiera. Devolvé SOLO las traducciones, una por línea, en el mismo orden, sin numerar ni agregar nada." },
          { role: "user", content: heads.join("\n") } ], max_tokens: 600, temperature: 0.1 });
        const lines = String((r && r.response) || "").split("\n").map((l) => l.replace(/^\s*(\d+[.)-]|[-•*])\s*/, "").trim()).filter(Boolean);
        out.ai.titulares = lines.length === heads.length ? lines.map((l) => l.slice(0, 240)) : [];
      } catch (e) { out.ai.titulares = []; }
    }
  }
  insMem.set(key, out);
  if (insMem.size > 200) insMem.delete(insMem.keys().next().value);
  if (env.HOLDY_KV && (out.ai || !env.AI)) await env.HOLDY_KV.put(key, JSON.stringify(out), { expirationTtl: INS_TTL });
  return json(out, 200, cors, "MISS");
}

function parseAi(txt) {
  if (!txt) return null;
  let o = null;
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (m) { try { o = JSON.parse(m[0]); } catch (e) { o = null; } }
  const arr = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean).slice(0, 3) : []);
  if (o && typeof o.resumen === "string" && o.resumen.trim()) return { resumen: o.resumen.trim().slice(0, 1500), aFavor: arr(o.aFavor), enContra: arr(o.enContra),
    titulares: Array.isArray(o.titulares) ? o.titulares.slice(0, 8).map((x) => String(x).slice(0, 240)) : [] };
  const plain = String(txt).replace(/[{}"]/g, "").trim();
  return plain.length > 40 ? { resumen: plain.slice(0, 1500), aFavor: [], enContra: [] } : null;
}

// ---------- /search?q=nvidia: buscar acciones y ETFs de EE.UU. por nombre o ticker (Finnhub) ----------
const srchMem = new Map();
async function searchSym(url, env, cors) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 40);
  if (q.length < 1) return json({ result: [] }, 200, cors);
  if (!env.FINNHUB_KEY) return json({ error: "not_configured" }, 500, cors);
  const k = q.toLowerCase();
  const hit = srchMem.get(k);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return json(hit.data, 200, cors, "HIT");
  let j = null;
  try {
    const r = await fetch("https://finnhub.io/api/v1/search?q=" + encodeURIComponent(q) + "&exchange=US&token=" + encodeURIComponent(env.FINNHUB_KEY));
    if (r.status === 429) return json({ error: "rate_limited" }, 429, cors);
    j = r.ok ? await r.json() : null;
  } catch (e) { j = null; }
  if (!j) return json({ error: "upstream" }, 502, cors);
  const okType = /^(common stock|adr|etp|etf|reit|)$/i;
  const qu = q.toUpperCase();
  const res = (Array.isArray(j.result) ? j.result : [])
    .filter((x) => x && x.symbol && /^[A-Z][A-Z0-9\-]{0,9}$/.test(x.symbol) && okType.test(String(x.type || "")))
    .map((x) => ({ s: x.symbol, n: String(x.description || "").slice(0, 80), t: /etp|etf/i.test(String(x.type || "")) ? "ETF" : "" }))
    .sort((a, b) => (b.s === qu) - (a.s === qu) || a.s.length - b.s.length)
    .slice(0, 10);
  const data = { result: res };
  srchMem.set(k, { at: Date.now(), data });
  if (srchMem.size > 500) srchMem.delete(srchMem.keys().next().value);
  return json(data, 200, cors, "MISS");
}

// ---------- IBKR automático (Flex Web Service) ----------
// El usuario guarda su token de Flex Web Service y el número de su Flex Query (solo lectura de reportes).
// POST /me/ibkr/sync pide el reporte a IBKR y devuelve el CSV; la app lo importa igual que un archivo.
const IB_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const IB_ERR = {
  "1003": "IBKR todavía no tiene el reporte listo. Probá en un rato.", "1001": "IBKR no pudo generar el reporte ahora. Probá en un rato.",
  "1004": "El reporte está incompleto. Probá en un rato.", "1005": "IBKR no tiene datos para ese período.",
  "1010": "Tu cuenta no tiene permiso para el Flex Web Service.", "1011": "El servicio de reportes está deshabilitado en tu cuenta.",
  "1012": "El token de IBKR venció. Generá uno nuevo en IBKR y pegalo en Holdy.", "1013": "IBKR rechazó el pedido por la dirección de origen (sacá la restricción de IP del token).",
  "1014": "El número de Flex Query no es válido.", "1015": "El token de IBKR no es válido.", "1016": "La cuenta no es válida.",
  "1018": "Demasiados pedidos a IBKR. Probá en unos minutos.", "1020": "Pedido inválido a IBKR.", "1021": "IBKR no pudo entregar el reporte. Probá en un rato.",
};
const ibTag = (xml, t) => { const m = new RegExp("<" + t + ">([\\s\\S]*?)</" + t + ">").exec(xml); return m ? m[1].trim() : ""; };

async function ibkr(request, env, url, user, h) {
  const key = "ib:" + user.sub;
  const rec = await env.HOLDY_KV.get(key, "json");
  if (url.pathname === "/me/ibkr") {
    if (request.method === "GET") {
      if (!rec) return json({ connected: false }, 200, h);
      return json({ connected: true, query: rec.query, pid: rec.pid || "", tail: rec.token.slice(-4), last: rec.last || 0, err: rec.err || "" }, 200, h);
    }
    if (request.method === "DELETE") { await env.HOLDY_KV.delete(key); await env.HOLDY_KV.delete("ibc:" + user.sub); return json({ ok: true }, 200, h); }
    if (request.method === "PUT") {
      let b; try { b = JSON.parse(await request.text()); } catch (e) { return json({ error: "bad_json" }, 400, h); }
      const token = String((b && b.token) || "").replace(/\s+/g, ""), query = String((b && b.query) || "").replace(/\s+/g, ""), pid = String((b && b.pid) || "").slice(0, 40);
      if (!token && rec && /^\d{3,12}$/.test(query)) { // cambiar solo la query o el perfil
        await env.HOLDY_KV.put(key, JSON.stringify({ ...rec, query, pid })); await env.HOLDY_KV.delete("ibc:" + user.sub);
        return json({ ok: true }, 200, h);
      }
      if (!/^[A-Za-z0-9]{10,64}$/.test(token)) return json({ error: "bad_token" }, 400, h);
      if (!/^\d{3,12}$/.test(query)) return json({ error: "bad_query" }, 400, h);
      await env.HOLDY_KV.put(key, JSON.stringify({ token, query, pid, last: 0, err: "" }));
      await env.HOLDY_KV.delete("ibc:" + user.sub);
      return json({ ok: true }, 200, h);
    }
    return json({ error: "method_not_allowed" }, 405, h);
  }
  // /me/ibkr/sync — en dos pasos para no colgar el Worker:
  //   POST /me/ibkr/sync          → pide el reporte a IBKR (SendRequest) y devuelve {pending:true}  (o el CSV si hay uno reciente)
  //   POST /me/ibkr/sync?poll=1   → un intento de GetStatement: {pending:true} mientras IBKR lo arma, o {csv}
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, h);
  if (!rec) return json({ error: "not_connected" }, 404, h);
  const force = url.searchParams.get("force") === "1", poll = url.searchParams.get("poll") === "1";
  const put = async (patch) => { Object.assign(rec, patch); await env.HOLDY_KV.put(key, JSON.stringify(rec)); };
  const UA = { "User-Agent": "Holdy/1.0 (portfolio tracker)", "Accept": "*/*" };
  const fail = async (code, msg, status) => { await put({ err: msg, ref: "" }); return json({ error: "ibkr", code, msg }, status || 502, h); };
  if (!poll) {
    // Reporte ya traído (por la tarea de la mañana o un pedido reciente): "Actualizar ahora" solo lo reusa si tiene menos de 5 minutos.
    const cached = await env.HOLDY_KV.get("ibc:" + user.sub, "json");
    if (cached && (Date.now() - cached.at < (force ? 5 * 60 * 1000 : 20 * 3600 * 1000))) return json({ csv: cached.csv, at: cached.at, cached: true }, 200, h);
    let x = "", st = 0;
    try { const r = await fetch(IB_BASE + "/SendRequest?t=" + encodeURIComponent(rec.token) + "&q=" + encodeURIComponent(rec.query) + "&v=3", { headers: UA }); st = r.status; x = await r.text(); }
    catch (e) { return json({ error: "ibkr", msg: "No pude conectarme con IBKR." }, 502, h); }
    if (ibTag(x, "Status") !== "Success") {
      const code = ibTag(x, "ErrorCode");
      return fail(code, IB_ERR[code] || ("IBKR respondió: " + (ibTag(x, "ErrorMessage") || ("error " + st + " " + x.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)))));
    }
    const u = ibTag(x, "Url");
    await put({ ref: ibTag(x, "ReferenceCode"), refAt: Date.now(), getUrl: /^https:\/\/[a-z0-9.\-]+\.interactivebrokers\.com\//i.test(u) ? u : IB_BASE + "/GetStatement" });
    return json({ pending: true }, 200, h);
  }
  if (!rec.ref) return json({ error: "ibkr", code: "noref", msg: "No hay un pedido en curso. Probá de nuevo." }, 409, h);
  if (Date.now() - (rec.refAt || 0) > 10 * 60 * 1000) return fail("old", "El pedido a IBKR venció. Probá de nuevo.", 410);
  let t = "", st = 0;
  try { const r = await fetch((rec.getUrl || IB_BASE + "/GetStatement") + "?t=" + encodeURIComponent(rec.token) + "&q=" + encodeURIComponent(rec.ref) + "&v=3", { headers: UA }); st = r.status; t = await r.text(); }
  catch (e) { return json({ pending: true, note: "red" }, 200, h); }
  if (/<FlexStatementResponse/i.test(t) && /<ErrorCode>/i.test(t)) {
    const code = ibTag(t, "ErrorCode");
    if (code === "1019" || code === "1001" || code === "1021" || code === "1004") return json({ pending: true, code }, 200, h); // todavía armándose
    return fail(code, IB_ERR[code] || ("IBKR respondió: " + ibTag(t, "ErrorMessage")));
  }
  if (/^\s*<\?xml|<FlexQueryResponse/i.test(t)) return fail("xml", "Tu Flex Query está en formato XML. En IBKR editala y cambiá el formato a CSV.");
  if (/<html/i.test(t) || st >= 400) return fail("http" + st, "IBKR respondió con un error (" + st + "). Probá de nuevo en un rato.");
  if (t.length < 20) return json({ pending: true, note: "vacio" }, 200, h);
  const at = Date.now();
  if (t.length < 20000000) await env.HOLDY_KV.put("ibc:" + user.sub, JSON.stringify({ csv: t, at }), { expirationTtl: 6 * 3600 });
  await put({ last: at, err: "", ref: "" });
  return json({ csv: t, at }, 200, h);
}

// Tarea diaria: para cada usuario con IBKR conectado, pide el reporte y lo guarda en "ibc:<usuario>" (24 h).
async function ibCron(env) {
  if (!env.HOLDY_KV) return;
  const UA = { "User-Agent": "Holdy/1.0 (portfolio tracker)", "Accept": "*/*" };
  let cursor;
  do {
    const page = await env.HOLDY_KV.list({ prefix: "ib:", cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      const sub = k.name.slice(3), rec = await env.HOLDY_KV.get(k.name, "json");
      if (!rec || !rec.token) continue;
      try {
        const x = await (await fetch(IB_BASE + "/SendRequest?t=" + encodeURIComponent(rec.token) + "&q=" + encodeURIComponent(rec.query) + "&v=3", { headers: UA })).text();
        if (ibTag(x, "Status") !== "Success") { const c = ibTag(x, "ErrorCode"); rec.err = IB_ERR[c] || ("IBKR respondió: " + ibTag(x, "ErrorMessage")); await env.HOLDY_KV.put(k.name, JSON.stringify(rec));
          if (c === "1012" || c === "1015") await pushTo(env, sub, "ib", { title: "IBKR automático", body: rec.err, tag: "ib-err" }, "ib-err:" + c, 7 * 86400);
          continue; }
        const ref = ibTag(x, "ReferenceCode"), u = ibTag(x, "Url"), getUrl = /^https:\/\/[a-z0-9.\-]+\.interactivebrokers\.com\//i.test(u) ? u : IB_BASE + "/GetStatement";
        for (let i = 0; i < 24; i++) { // hasta ~2 minutos
          await new Promise((res) => setTimeout(res, 5000));
          const t = await (await fetch(getUrl + "?t=" + encodeURIComponent(rec.token) + "&q=" + encodeURIComponent(ref) + "&v=3", { headers: UA })).text();
          if (/<FlexStatementResponse/i.test(t) && /<ErrorCode>/i.test(t)) {
            const c = ibTag(t, "ErrorCode");
            if (c === "1019" || c === "1001" || c === "1021" || c === "1004") continue;
            rec.err = IB_ERR[c] || ("IBKR respondió: " + ibTag(t, "ErrorMessage")); await env.HOLDY_KV.put(k.name, JSON.stringify(rec)); break;
          }
          if (t.length > 20 && !/<html|^\s*<\?xml/i.test(t)) {
            const at = Date.now();
            // ¿Trajo operaciones o dividendos nuevos respecto del último reporte?
            const prev = await env.HOLDY_KV.get("ibc:" + sub, "json"), cnt = ibCount(t), pc = prev ? ibCount(prev.csv) : null;
            if (pc && (cnt.t > pc.t || cnt.d > pc.d)) {
              const parts = []; if (cnt.t > pc.t) parts.push((cnt.t - pc.t) + (cnt.t - pc.t === 1 ? " operación nueva" : " operaciones nuevas")); if (cnt.d > pc.d) parts.push((cnt.d - pc.d) + (cnt.d - pc.d === 1 ? " cobro de dividendo" : " cobros de dividendos"));
              await pushTo(env, sub, "ib", { title: "IBKR", body: "Llegaron " + parts.join(" y ") + ". Abrí Holdy para verlos.", tag: "ib-new" });
            }
            await env.HOLDY_KV.put("ibc:" + sub, JSON.stringify({ csv: t, at }), { expirationTtl: 26 * 3600 });
            rec.last = at; rec.err = ""; await env.HOLDY_KV.put(k.name, JSON.stringify(rec));
            break;
          }
        }
      } catch (e) { /* se reintenta mañana o cuando abra la app */ }
    }
  } while (cursor);
}

// ---------- Qué ve cada persona de una cartera compartida ----------
// c = { t: "all"|"acc"|"fi", b: -1 | código de broker, p: 1 solo porcentajes, s: 0 sin ventas, m: 0 sin plata sin invertir,
//       i: 0 sin dividendos ni cupones, d: días de acceso (0 = sin vencimiento), x: vence (ms) }
function cleanCfg(c, from) {
  c = c || {};
  const o = { t: ["all", "acc", "fi"].includes(c.t) ? c.t : "all", b: Number.isInteger(c.b) && c.b >= 0 && c.b < 10 ? c.b : -1,
    p: c.p ? 1 : 0, s: c.s === 0 ? 0 : 1, m: c.m === 0 ? 0 : 1, i: c.i === 0 ? 0 : 1, d: [0, 7, 30, 90].includes(+c.d) ? +c.d : 0, x: +c.x || 0 };
  if (from && o.d && !o.x) o.x = from + o.d * 86400000;
  if (!o.d) o.x = 0;
  return o;
}
// Arma la versión recortada de la cartera para quien mira. Con "solo porcentajes" todas las cantidades y montos se
// multiplican por un número secreto de esa persona: los % dan igual, los montos reales no se pueden deducir.
function viewFor(data, c, k) {
  if (!data || !Array.isArray(data.p)) return data;
  const full = c.t === "all" && c.b < 0 && !c.p && c.s && c.m && c.i;
  if (full) return data;
  const K = c.p ? k : 1, sc = (v) => (typeof v === "number" ? Math.round(v * K * 1e6) / 1e6 : v);
  const isFi = (r) => !!(r[10] && Array.isArray(r[10])) || /\{fci:[PD]\}/.test(String(r[7] || ""));
  const keep = (r) => Array.isArray(r) && (c.b < 0 || r[0] === c.b) && (c.t === "all" || (c.t === "fi") === isFi(r));
  const fix = (r) => {
    r = r.slice(); r[3] = sc(r[3]);
    if (Array.isArray(r[8])) r[8] = r[8].map((l) => { l = l.slice(); l[0] = sc(l[0]); if (l.length > 5) l[5] = sc(l[5]); return l; });
    if (Array.isArray(r[9]) && r[9].length > 4) { r[9] = r[9].slice(); r[9][4] = sc(r[9][4]); }
    if (Array.isArray(r[10])) { r[10] = r[10].slice(); if (Array.isArray(r[10][3])) r[10][3] = c.i ? r[10][3].map((x) => [x[0], sc(x[1])]) : []; }
    return r;
  };
  const o = { ...data };
  o.p = data.p.filter(keep).map(fix);
  o.c = c.s ? (data.c || []).filter(keep).map(fix) : [];
  o.sb = c.m ? (data.sb || []).filter((r) => c.b < 0 || r[0] === c.b).map((r) => { r = r.slice(); r[1] = sc(r[1]); return r; }) : [];
  o.m = c.m && c.b < 0 ? (data.m || []).map((r) => [r[0], sc(r[1])]) : [];
  o.dv = c.i && c.t !== "fi" ? (data.dv || []).filter((r) => c.b < 0 || r[0] === c.b).map((r) => { r = r.slice(); r[3] = sc(r[3]); return r; }) : [];
  o.f = { t: c.t, b: c.b, p: c.p, s: c.s, m: c.m, i: c.i, x: c.x };
  return o;
}

// ---------- /divs?symbols=AAPL,KO: dividendos por acción de los últimos 2 años (Yahoo), para estimar los próximos ----------
const divCache = new Map();
async function divs(url, cors) {
  const syms = (url.searchParams.get("symbols") || "").toUpperCase().split(",").map((x) => x.trim()).filter(Boolean);
  if (!syms.length || syms.length > 40 || syms.some((x) => !/^[A-Z0-9.\-]{1,12}$/.test(x))) return json({ error: "bad_symbols" }, 400, cors);
  const out = {};
  await Promise.all(syms.map(async (sym) => {
    const hit = divCache.get(sym);
    if (hit && Date.now() - hit.at < 12 * 3600 * 1000) { out[sym] = hit.d; return; }
    const cands = sym.includes(".") ? [sym] : (ALIAS[sym] ? [ALIAS[sym]] : [sym]);
    let d = [];
    for (const c of cands) {
      try {
        const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(c) + "?range=2y&interval=1mo&events=div",
          { headers: { "User-Agent": "Mozilla/5.0 (compatible; Holdy/1.0)", "Accept": "application/json" } });
        if (!r.ok) continue;
        const j = await r.json(), res = j && j.chart && j.chart.result && j.chart.result[0];
        const ev = res && res.events && res.events.dividends;
        if (ev) d = Object.values(ev).filter((x) => x && x.date && x.amount > 0).map((x) => [new Date(x.date * 1000).toISOString().slice(0, 10), Math.round(x.amount * 1e6) / 1e6]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        break;
      } catch (e) { /* sin datos */ }
    }
    divCache.set(sym, { at: Date.now(), d }); if (divCache.size > 500) divCache.delete(divCache.keys().next().value);
    out[sym] = d;
  }));
  return json({ data: out }, 200, cors);
}

// ---------- Avisos al celu (Web Push) ----------
// Sin contenido cifrado: el aviso "despierta" al service worker, que pide el texto a /push/inbox con su suscripción.
// La clave VAPID la genera el propio Worker la primera vez y queda en el KV.
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function vapid(env) {
  let k = await env.HOLDY_KV.get("vapid:key", "json");
  if (!k) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    k = { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await env.HOLDY_KV.put("vapid:key", JSON.stringify(k));
  }
  return k;
}
async function pushKey(env, cors) { if (!env.HOLDY_KV) return json({ error: "no_kv" }, 501, cors); const k = await vapid(env); return json({ key: k.pub }, 200, cors); }
async function vapidAuth(env, endpoint) {
  const k = await vapid(env), aud = new URL(endpoint).origin;
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://holdy.pages.dev" });
  const key = await crypto.subtle.importKey("jwk", k.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return "vapid t=" + unsigned + "." + b64u(sig) + ", k=" + k.pub;
}
// Manda un aviso a todos los celus de un usuario que tengan prendido ese tipo ("close" | "cob" | "ib").
// once: clave para no repetir el mismo aviso (con ttl en segundos).
async function pushTo(env, sub, kind, msg, once, ttl) {
  const rec = await env.HOLDY_KV.get("push:" + sub, "json");
  if (!rec || !rec.subs || !rec.subs.length || !(rec.prefs && (rec.prefs[kind] || (kind === "fr" && rec.prefs.fr === undefined)))) return 0;
  if (once) { const ok = await env.HOLDY_KV.get("pushonce:" + sub + ":" + once); if (ok) return 0; await env.HOLDY_KV.put("pushonce:" + sub + ":" + once, "1", { expirationTtl: ttl || 86400 * 2 }); }
  let sent = 0; const keep = [];
  for (const s of rec.subs) {
    const ik = "pin:" + await sha256(s.ep), box = (await env.HOLDY_KV.get(ik, "json")) || [];
    box.push({ ...msg, at: Date.now() }); await env.HOLDY_KV.put(ik, JSON.stringify(box.slice(-5)), { expirationTtl: 3 * 86400 });
    try {
      const r = await fetch(s.ep, { method: "POST", headers: { TTL: "43200", Urgency: "high", Authorization: await vapidAuth(env, s.ep), "Content-Length": "0" } });
      if (r.status === 404 || r.status === 410) continue; // suscripción vencida: se borra
      if (r.ok) sent++;
    } catch (e) { /* se reintenta en el próximo aviso */ }
    keep.push(s);
  }
  if (keep.length !== rec.subs.length) { rec.subs = keep; await env.HOLDY_KV.put("push:" + sub, JSON.stringify(rec)); }
  return sent;
}
async function pushInbox(request, env, cors) {
  let b; try { b = JSON.parse(await request.text()); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
  const ep = String((b && b.ep) || ""); if (!/^https:\/\//.test(ep) || ep.length > 1000) return json({ msgs: [] }, 200, cors);
  const ik = "pin:" + await sha256(ep), box = (await env.HOLDY_KV.get(ik, "json")) || [];
  if (box.length) await env.HOLDY_KV.delete(ik);
  return json({ msgs: box }, 200, { ...cors, "Cache-Control": "no-store" });
}
// /me/push: GET estado · PUT {sub:{endpoint}, prefs, agenda, pid} · DELETE {ep} · POST /me/push/test
async function pushMe(request, env, url, user, h) {
  const key = "push:" + user.sub, rec = (await env.HOLDY_KV.get(key, "json")) || { subs: [], prefs: { close: 1, cob: 1, ib: 1 }, agenda: [] };
  if (url.pathname === "/me/push/test" && request.method === "POST") {
    const n = await pushTo(env, user.sub, "test", { title: "Holdy", body: "Listo: los avisos llegan a este celu." });
    return json({ ok: true, sent: n }, 200, h);
  }
  if (request.method === "GET") return json({ prefs: rec.prefs, n: rec.subs.length }, 200, h);
  let b; try { b = JSON.parse(await request.text() || "{}"); } catch (e) { return json({ error: "bad_json" }, 400, h); }
  if (request.method === "DELETE") { const ep = String(b.ep || ""); rec.subs = rec.subs.filter((s) => s.ep !== ep); await env.HOLDY_KV.put(key, JSON.stringify(rec)); return json({ ok: true }, 200, h); }
  if (request.method === "PUT") {
    if (b.sub && /^https:\/\//.test(b.sub.endpoint || "") && b.sub.endpoint.length < 1000) { if (!rec.subs.some((s) => s.ep === b.sub.endpoint)) rec.subs = rec.subs.concat({ ep: b.sub.endpoint, at: Date.now() }).slice(-5); }
    if (b.prefs) rec.prefs = { close: b.prefs.close ? 1 : 0, cob: b.prefs.cob ? 1 : 0, ib: b.prefs.ib ? 1 : 0, fr: b.prefs.fr === 0 ? 0 : 1, test: 1 };
    rec.prefs.test = 1;
    if (Array.isArray(b.agenda)) rec.agenda = b.agenda.slice(0, 60).map((x) => ({ d: String(x.d || "").slice(0, 10), t: String(x.t || "").slice(0, 16), k: String(x.k || "").slice(0, 20), a: Math.round((+x.a || 0) * 100) / 100, cy: String(x.cy || "US$").slice(0, 4) })).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d));
    if (Array.isArray(b.pos)) rec.pos = b.pos.slice(0, 200).map((x) => ({ t: String(x.t || "").toUpperCase().slice(0, 12), q: +x.q || 0 })).filter((x) => /^[A-Z][A-Z0-9.\-]{0,11}$/.test(x.t) && x.q > 0);
    if (b.name) rec.name = String(b.name).slice(0, 40);
    await env.HOLDY_KV.put(key, JSON.stringify(rec));
    return json({ ok: true, n: rec.subs.length }, 200, h);
  }
  return json({ error: "method_not_allowed" }, 405, h);
}
async function pushUsers(env) { const out = []; let cursor; do { const p = await env.HOLDY_KV.list({ prefix: "push:", cursor }); cursor = p.list_complete ? undefined : p.cursor; p.keys.forEach((k) => out.push(k.name.slice(5))); } while (cursor); return out; }
const fmtUS = (n) => (n < 0 ? "−" : "") + "US$ " + Math.abs(n).toLocaleString("es-AR", { minimumFractionDigits: Math.abs(n) < 100 ? 2 : 0, maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });
// 9:00 de Argentina: lo que cobrás hoy (cupones y vencimientos de bonos, dividendos estimados), según la agenda que manda la app.
async function pushCobros(env) {
  const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  for (const sub of await pushUsers(env)) {
    const rec = await env.HOLDY_KV.get("push:" + sub, "json"); if (!rec || !rec.agenda) continue;
    const hoy = rec.agenda.filter((x) => x.d === today); if (!hoy.length) continue;
    const tot = hoy.reduce((a, x) => a + x.a, 0);
    const body = hoy.length === 1 ? "Hoy cobrás " + (hoy[0].k || "").toLowerCase() + " de " + hoy[0].t + " ≈ " + fmtUS(hoy[0].a) + "." : "Hoy cobrás " + hoy.map((x) => x.t).join(", ") + " ≈ " + fmtUS(tot) + " en total.";
    await pushTo(env, sub, "cob", { title: "Cobro de hoy", body, tag: "cob-" + today }, "cob:" + today);
  }
}
// 18:35 de Argentina (lun-vie): cómo cerraron hoy tus acciones (precio de Finnhub × tus cantidades).
async function pushClose(env) {
  const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10), qc = {};
  for (const sub of await pushUsers(env)) {
    const rec = await env.HOLDY_KV.get("push:" + sub, "json"); if (!rec || !rec.prefs || !rec.prefs.close || !rec.subs || !rec.subs.length || !rec.pos || !rec.pos.length) continue;
    let dAmt = 0, base = 0; const mv = [];
    for (const p of rec.pos) {
      if (!(p.t in qc)) { try { const r = await fetch("https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(p.t) + "&token=" + encodeURIComponent(env.FINNHUB_KEY)); const j = r.ok ? await r.json() : null; qc[p.t] = j && j.c > 0 && j.t && new Date(j.t * 1000).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? j : null; } catch (e) { qc[p.t] = null; } }
      const q = qc[p.t]; if (!q || typeof q.d !== "number" || !(q.pc > 0)) continue;
      dAmt += q.d * p.q; base += q.pc * p.q; mv.push({ t: p.t, dp: q.d / q.pc });
    }
    if (!(base > 0)) continue; // feriado o sin datos de hoy
    mv.sort((a, b) => b.dp - a.dp);
    const pc = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1).replace(".", ",") + "%";
    let body = "Tus acciones hoy: " + (dAmt >= 0 ? "+" : "") + fmtUS(dAmt) + " (" + pc(dAmt / base) + ").";
    if (mv.length > 1) body += " Subió más " + mv[0].t + " " + pc(mv[0].dp) + "; bajó más " + mv[mv.length - 1].t + " " + pc(mv[mv.length - 1].dp) + ".";
    await pushTo(env, sub, "close", { title: "Cierre del mercado", body, tag: "close-" + today }, "close:" + today);
  }
}
function ibCount(csv) { let t = 0, d = 0; String(csv || "").split("\n").forEach((l) => { if (/"(BUY|SELL)"/.test(l) && /"STK"/.test(l)) t++; if (/Dividends/.test(l) && /"DETAIL"/.test(l)) d++; }); return { t, d }; }

// ---------- Preguntale a tu cartera: la app manda sus números ya calculados y la IA solo los lee y redacta ----------
const ASK_MODELS = ["@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/meta/llama-3.1-8b-instruct"];
async function ask(request, env, cors) {
  if (!env.AI) return json({ error: "ai_not_configured" }, 501, cors);
  let b; try { b = JSON.parse(await request.text()); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
  const q = String((b && b.q) || "").trim().slice(0, 500), facts = String((b && b.facts) || "").slice(0, 30000);
  if (!q) return json({ error: "empty" }, 400, cors);
  const hist = Array.isArray(b.hist) ? b.hist.slice(-6).filter((m) => m && (m.r === "u" || m.r === "a")).map((m) => ({ role: m.r === "u" ? "user" : "assistant", content: String(m.t || "").slice(0, 1500) })) : [];
  const sys = "Sos el asistente de Holdy, una app donde un inversor argentino sigue su cartera. Respondé en castellano rioplatense, corto (1 a 4 oraciones) y claro. " +
    "Usá SOLO los datos de la cartera que siguen: no inventes números, fechas ni operaciones. Si la respuesta no está en los datos, decí que no tenés ese dato. " +
    "Copiá los montos tal cual aparecen (ya están en la moneda que el usuario eligió). No recomiendes comprar ni vender ni des consejos de inversión. " +
    "Si te preguntan algo que no es sobre su cartera, decí amablemente que solo podés responder sobre su cartera.\n\nDATOS DE LA CARTERA:\n" + facts;
  let lastErr = "";
  for (const model of ASK_MODELS) {
    try {
      const r = await env.AI.run(model, { messages: [{ role: "system", content: sys }, ...hist, { role: "user", content: q }], max_tokens: 400, temperature: 0.2 });
      const txt = String((r && (typeof r.response === "string" ? r.response : "")) || "").trim();
      if (txt) return json({ a: txt.slice(0, 2500) }, 200, cors);
    } catch (e) {
      lastErr = String((e && e.message) || e);
      // Se terminó la cuota gratis del día (10.000 neuronas): no tiene sentido probar otro modelo.
      if (/4006|free allocation|neurons|quota|limit/i.test(lastErr)) return json({ error: "limit" }, 429, cors);
    }
  }
  return json({ error: "ai_failed", detail: lastErr.slice(0, 200) }, 502, cors);
}

// ---------- Movimientos de amigos: avisos, comentarios y reacciones ----------
function movesOf(data, keepRow) {
  const out = new Map(), lim = Date.now() - 10 * 86400000;
  const add = (r, k, d) => { if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Date.parse(d) < lim) return; out.set(k + "|" + r[2] + "|" + d, { k, t: r[2], d, r }); };
  for (const r of (data && data.p) || []) { if (!Array.isArray(r) || (keepRow && !keepRow(r))) continue; for (const l of Array.isArray(r[8]) ? r[8] : []) add(r, "b", l && l[2]); }
  for (const r of (data && data.c) || []) { if (!Array.isArray(r) || (keepRow && !keepRow(r))) continue; for (const l of Array.isArray(r[8]) ? r[8] : []) add(r, "b", l && l[2]); if (Array.isArray(r[9])) add(r, "s", r[9][0]); }
  return out;
}
async function notifyMoves(env, code, oldData, newData, owner) {
  const before = movesOf(oldData), fresh = [...movesOf(newData).entries()].filter(([k]) => !before.has(k)).map(([, v]) => v);
  if (!fresh.length) return;
  const pv = (await env.HOLDY_KV.get("pv:" + code, "json")) || { v: {}, b: [] };
  const who = (owner && owner.n) || String(newData.n || "Un amigo");
  for (const sub of Object.keys(pv.v || {})) {
    if ((pv.b || []).includes(sub) || (owner && owner.s === sub)) continue;
    const c = cleanCfg(pv.v[sub].c || pv.d || {});
    if (c.x && Date.now() > c.x) continue;
    const isFi = (r) => !!(r[10] && Array.isArray(r[10])) || /\{fci:[PD]\}/.test(String(r[7] || ""));
    const vis = fresh.filter((m) => (c.b < 0 || m.r[0] === c.b) && (c.t === "all" || (c.t === "fi") === isFi(m.r)) && (m.k === "b" || c.s));
    if (!vis.length) continue;
    const txt = vis.slice(0, 3).map((m) => (m.k === "s" ? "vendió " : "compró ") + m.t).join(", ") + (vis.length > 3 ? " y " + (vis.length - 3) + " más" : "");
    await pushTo(env, sub, "fr", { title: who.split(" ")[0], body: txt.charAt(0).toUpperCase() + txt.slice(1), tag: "fr-" + code, u: "#feed" }, "fr:" + code + ":" + vis.map((m) => m.k + m.t + m.d).join(","), 20 * 86400);
  }
}
const FX_EMO = ["🔥", "👏", "😬", "🤔", "😂"];
// Perfil público de cada usuario (nombre que eligió y foto chiquita). Casi nunca cambia: se guarda en memoria 6 horas.
// La foto no viaja en cada consulta: va solo una "versión" corta y la app la baja de /av/<id>?v=<versión>, que el celu guarda para siempre.
// Si la persona cambia la foto, cambia la versión y recién ahí se descarga la nueva.
const PF = new Map();
async function getPf(env, sub) {
  const c = PF.get(sub); if (c && Date.now() - c.t < 6 * 3600000) return c.v;
  const v = (await env.HOLDY_KV.get("pf:" + sub, "json")) || {}; PF.set(sub, { v, t: Date.now() }); if (PF.size > 2000) PF.clear(); return v;
}
async function dispName(env, u) { const p = await getPf(env, u.sub); return p.n || u.name || "Alguien"; }
async function uid(sub) { return (await sha256("u|" + sub)).slice(0, 12); }
async function avatar(url, env, cors) {
  const id = url.pathname.slice(4); if (!/^[a-f0-9]{12}$/.test(id) || !env.HOLDY_KV) return new Response("", { status: 404, headers: cors });
  const d = await env.HOLDY_KV.get("av:" + id), m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(d || "");
  if (!m) return new Response("", { status: 404, headers: { ...cors, "Cache-Control": "public, max-age=300" } });
  const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  return new Response(bin, { headers: { ...cors, "Content-Type": m[1], "Cache-Control": "public, max-age=31536000, immutable" } });
}
async function meProfile(request, env, user, h) {
  if (request.method === "GET") { const p = await getPf(env, user.sub);
    if (p.ph && !p.pv) { p.pv = (await sha256(p.ph)).slice(0, 8); await env.HOLDY_KV.put("pf:" + user.sub, JSON.stringify(p)); await env.HOLDY_KV.put("av:" + (await uid(user.sub)), p.ph); } // fotos subidas antes de la versión con /av/ return json({ n: p.n || "", ph: p.ph || "", g: user.name || "" }, 200, h); }
  if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405, h);
  const text = await request.text(); if (text.length > 40000) return json({ error: "too_large" }, 413, h);
  let b; try { b = JSON.parse(text); } catch (e) { return json({ error: "bad_json" }, 400, h); }
  const n = String((b && b.n) || "").replace(/\s+/g, " ").trim().slice(0, 40), ph = String((b && b.ph) || "");
  if (ph && !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(ph)) return json({ error: "bad_photo" }, 400, h);
  const v = {}, id = await uid(user.sub); if (n) v.n = n; if (ph) { v.ph = ph; v.pv = (await sha256(ph)).slice(0, 8); }
  await env.HOLDY_KV.put("pf:" + user.sub, JSON.stringify(v)); PF.set(user.sub, { v, t: Date.now() });
  if (ph) await env.HOLDY_KV.put("av:" + id, ph); else await env.HOLDY_KV.delete("av:" + id);
  return json({ n: v.n || "", ph: v.ph || "", g: user.name || "" }, 200, h);
}
// GET /fx/<code>: reacciones y comentarios de los movimientos de esa cartera · POST {key, re} reacciona (o saca) · POST {key, t} comenta
async function social(request, env, url, cors, ctx) {
  const nostore = { ...cors, "Cache-Control": "no-store" };
  if (!env.HOLDY_KV) return json({ error: "sync_not_configured" }, 501, nostore);
  const code = decodeURIComponent(url.pathname.slice(4).split("/")[0] || "");
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) return json({ error: "bad_code" }, 400, nostore);
  const u = await sessionUser(request, env); if (!u) return json({ error: "unauthorized" }, 401, nostore);
  const stored = await env.HOLDY_KV.get("p:" + code, "json"); if (!stored) return json({ error: "not_found" }, 404, nostore);
  const pv = (await env.HOLDY_KV.get("pv:" + code, "json")) || { v: {}, b: [] };
  const isOwner = !!(stored.o && stored.o.s === u.sub), view = pv.v && pv.v[u.sub];
  if (!isOwner && (!view || (pv.b || []).includes(u.sub))) return json({ error: "forbidden" }, 403, nostore);
  const fk = "fx:" + code, doc = (await env.HOLDY_KV.get(fk, "json")) || { k: {} };
  // Nombre y foto actuales de cada persona (dueño y quienes comentaron), con un id opaco en vez del de Google.
  const out = async () => { const o = {}, subs = new Set(); if (stored.o) subs.add(stored.o.s);
    Object.values(doc.k).forEach((v) => (v.c || []).forEach((c) => subs.add(c.s)));
    const ids = {}, users = {};
    await Promise.all([...subs].map(async (s) => { const p = await getPf(env, s), id = await uid(s); ids[s] = id; users[id] = { n: p.n || "", v: p.ph ? p.pv || "1" : "" }; }));
    for (const [k, v] of Object.entries(doc.k)) o[k] = { r: Object.fromEntries(Object.entries(v.r || {}).filter(([, a]) => a.length).map(([e, a]) => [e, [a.length, a.includes(u.sub) ? 1 : 0]])),
      c: (v.c || []).map((c) => ({ i: c.i, n: (users[ids[c.s]] && users[ids[c.s]].n) || c.n, u: ids[c.s], t: c.t, a: c.a, me: c.s === u.sub ? 1 : 0, o: stored.o && c.s === stored.o.s ? 1 : 0 })) };
    return json({ k: o, owner: isOwner ? 1 : 0, ow: stored.o ? ids[stored.o.s] : "", us: users }, 200, nostore); };
  if (request.method === "GET") return out();
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, nostore);
  let b; try { b = JSON.parse(await request.text()); } catch (e) { return json({ error: "bad_json" }, 400, nostore); }
  const key = String((b && b.key) || "");
  if (!/^[bs]\|[A-Za-z0-9.^=_-]{1,20}\|\d{4}-\d{2}-\d{2}$/.test(key)) return json({ error: "bad_key" }, 400, nostore);
  const it = doc.k[key] || (doc.k[key] = { r: {}, c: [], at: 0 });
  const [kind, tk] = key.split("|"), what = (kind === "s" ? "venta de " : "compra de ") + tk;
  const myName = await dispName(env, u), me = myName.split(" ")[0];
  let notify = [], msg = null;
  if (b.re) {
    if (!FX_EMO.includes(b.re)) return json({ error: "bad_emoji" }, 400, nostore);
    const a = it.r[b.re] || (it.r[b.re] = []), i = a.indexOf(u.sub);
    if (i >= 0) a.splice(i, 1); else { a.push(u.sub); if (stored.o && stored.o.s !== u.sub) { notify = [stored.o.s]; msg = { title: me, body: "Reaccionó " + b.re + " a tu " + what, tag: "fx-" + code + key, u: "#feed" }; } }
  } else {
    const t = String(b.t || "").trim().slice(0, 300); if (!t) return json({ error: "empty" }, 400, nostore);
    it.c.push({ i: Math.random().toString(36).slice(2, 10), s: u.sub, n: myName, t, a: Date.now() }); it.c = it.c.slice(-60);
    const subs = new Set(it.c.map((c) => c.s)); if (stored.o) subs.add(stored.o.s); subs.delete(u.sub);
    notify = [...subs].filter((s) => (stored.o && s === stored.o.s) || (pv.v[s] && !(pv.b || []).includes(s)));
    msg = { title: me + " comentó", body: "“" + t.slice(0, 90) + "” · en " + (isOwner ? "su " : (stored.o && notify[0] === stored.o.s ? "tu " : "la ")) + what, tag: "fx-" + code + key, u: "#feed" };
  }
  it.at = Date.now();
  const keys = Object.keys(doc.k); if (keys.length > 200) keys.sort((x, y) => doc.k[x].at - doc.k[y].at).slice(0, keys.length - 200).forEach((k) => delete doc.k[k]);
  await env.HOLDY_KV.put(fk, JSON.stringify(doc), { expirationTtl: TTL_PROFILE });
  if (msg && notify.length && ctx) ctx.waitUntil(Promise.all(notify.map((s) => pushTo(env, s, "fr", msg).catch(() => 0))));
  return out();
}
