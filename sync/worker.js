// Holdy – servidor de perfiles compartidos por código (Cloudflare Worker + KV)
//
// Guarda una copia de un perfil bajo un código para que otra persona lo vea y se actualice sola.
// Requiere un KV namespace enlazado con el nombre HOLDY_KV (wrangler.jsonc lo crea solo al desplegar).

// Páginas autorizadas a usar este servidor desde un navegador (CORS).
const ALLOWED_ORIGINS = ["https://hernansson.github.io"];

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
    return json({ error: "not_found" }, 404, cors);
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
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
