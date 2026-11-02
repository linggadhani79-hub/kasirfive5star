// Router mini bergaya Express untuk Cloudflare Workers.
// Handler dipanggil berurutan: (req) => nilai. Nilai pertama yang bukan undefined menjadi respons
// (objek → JSON, Response → apa adanya). Lempar error dengan .status untuk respons error.
export class Router {
  constructor() {
    this.routes = [];
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
      this[m] = (path, ...handlers) => this.add(m.toUpperCase(), path, handlers);
    }
  }

  add(method, path, handlers) {
    const keys = [];
    const pattern = path.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'));
    this.routes.push({ method, re: new RegExp(`^${pattern}$`), keys, handlers });
  }

  async handle(request, path) {
    const url = new URL(request.url);
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    try {
      let methodMismatch = false;
      for (const r of this.routes) {
        const m = path.match(r.re);
        if (!m) continue;
        if (r.method !== request.method) {
          methodMismatch = true;
          continue;
        }
        let body = {};
        if (!['GET', 'HEAD'].includes(request.method)) {
          const text = await request.text();
          if (text.length > 1_500_000) return json({ error: 'Data terlalu besar' }, 413);
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              return json({ error: 'Format JSON tidak valid' }, 400);
            }
          }
        }
        const req = {
          method: request.method,
          params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
          query: Object.fromEntries(url.searchParams),
          body,
          ip: request.headers.get('cf-connecting-ip') || 'local',
          origin: url.origin,
          get: (h) => request.headers.get(h),
        };
        for (const h of r.handlers) {
          const out = await h(req);
          if (out instanceof Response) return out;
          if (out !== undefined) return json(out);
        }
        return json({ ok: true });
      }
      return json({ error: methodMismatch ? 'Metode tidak diizinkan' : 'Endpoint tidak ditemukan' }, methodMismatch ? 405 : 404);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err?.stack || err);
      return json({ error: status >= 500 ? 'Terjadi kesalahan server' : err.message }, status);
    }
  }
}
