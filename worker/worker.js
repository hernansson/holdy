// Holdy – proxy de precios (Cloudflare Worker)
//
// Recibe  GET /quote?symbol=AAPL  desde Holdy, consulta Finnhub con la clave guardada
// como secreto (FINNHUB_KEY) y devuelve la misma respuesta de Finnhub: {c, d, dp, h, l, o, pc, t}.
// La clave nunca viaja al navegador ni está en este archivo.

// Páginas autorizadas a usar este proxy desde un navegador (CORS).
// Si publicás Holdy en otra dirección, agregala acá.
const ALLOWED_ORIGINS = ["https://hernansson.github.io"];

// Tiempo que se reutiliza un precio ya consultado, para no gastar el límite gratuito de Finnhub.
// Es una memoria por instancia del Worker: ayuda, pero Cloudflare puede reiniciarla en cualquier momento.
const TTL_MS = 60 * 1000;
const MAX_CACHED = 500;
const cache = new Map();

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
          "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Holdy-Secret",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (!originOk) return json({ error: "origin_not_allowed" }, 403, cors);

    const url = new URL(request.url);
    if (url.pathname.startsWith("/p/")) return profile(request, env, url, cors);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
    if (url.pathname !== "/quote") return json({ error: "not_found" }, 404, cors);

    const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return json({ error: "bad_symbol" }, 400, cors);
    if (!env.FINNHUB_KEY) return json({ error: "not_configured" }, 500, cors);

    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < TTL_MS) return json(hit.data, 200, cors, "HIT");

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
    if (upstream.status === 401 || upstream.status === 403) return json({ error: "server_key_invalid" }, 503, cors);
    if (!upstream.ok) return json({ error: "upstream_" + upstream.status }, 502, cors);

    const data = await upstream.json();
    if (typeof data.c === "number" && data.c > 0) {
      cache.set(symbol, { at: Date.now(), data });
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    }
    return json(data, 200, cors, "MISS");
  },
};

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
