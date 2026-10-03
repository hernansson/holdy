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
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
    if (!originOk) return json({ error: "origin_not_allowed" }, 403, cors);

    const url = new URL(request.url);
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
