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
  async fetch(request, env) {
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
    if (url.pathname.startsWith("/p/")) return profile(request, env, url, cors);
    if (url.pathname.startsWith("/auth/") || url.pathname === "/me/data") return account(request, env, url, cors);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
    if (url.pathname === "/history") return history(url, cors);
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

async function profile(request, env, url, cors) {
  if (!env.HOLDY_KV) return json({ error: "sync_not_configured" }, 501, cors);
  const code = decodeURIComponent(url.pathname.slice(3));
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) return json({ error: "bad_code" }, 400, cors);
  const key = "p:" + code;
  const stored = await env.HOLDY_KV.get(key, "json");

  if (request.method === "GET") {
    if (!stored) return json({ error: "not_found" }, 404, { ...cors, "Cache-Control": "no-store" });
    return json({ data: stored.data, updated: stored.updated }, 200, { ...cors, "Cache-Control": "no-store" });
  }

  const secret = request.headers.get("X-Holdy-Secret") || "";
  if (secret.length < 16 || secret.length > 100) return json({ error: "bad_secret" }, 400, cors);
  const hash = await sha256(secret);
  if (stored && stored.secretHash !== hash) return json({ error: "forbidden" }, 403, cors);

  if (request.method === "DELETE") {
    if (stored) await env.HOLDY_KV.delete(key);
    return json({ ok: true }, 200, cors);
  }
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: "too_large" }, 413, cors);
    let data;
    try { data = JSON.parse(text); } catch (e) { return json({ error: "bad_json" }, 400, cors); }
    if (!data || data.v !== 2 || !Array.isArray(data.p) || data.p.length > 300) return json({ error: "bad_data" }, 400, cors);
    const updated = Date.now();
    await env.HOLDY_KV.put(key, JSON.stringify({ secretHash: hash, data, updated }), { expirationTtl: TTL_PROFILE });
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
//   GET /history?symbols=AAPL,VUAA&from=2025-01-01  ->  { data: { AAPL: { currency, pts: [["2025-01-02", 243.1], ...] } } }
// Cierres diarios sin ajustar por dividendos, desde Yahoo Finance (no oficial).
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
    const off = (res.meta && typeof res.meta.gmtoffset === "number") ? res.meta.gmtoffset : 0;
    let cur = String((res.meta && res.meta.currency) || "").trim();
    let k = 1;
    if (cur === "GBp" || cur === "GBX") { k = 0.01; cur = "GBP"; }
    const pts = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      const c = closes[i];
      if (typeof c !== "number" || !(c > 0)) continue;
      pts.push([new Date((res.timestamp[i] + off) * 1000).toISOString().slice(0, 10), Math.round(c * k * 1e6) / 1e6]);
    }
    if (pts.length < 2) return null;
    return { currency: cur.toUpperCase(), pts };
  } catch (e) {
    return null;
  }
}
