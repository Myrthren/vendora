'use strict';

// A small Fetch/Express-shaped adapter lets the existing, tested feature
// modules run as Netlify functions without loading or starting the Discord bot.
function createRouter() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'patch']) app[method] = (path, handler) => routes.push({ method: method.toUpperCase(), parts: path.split('/'), handler });
  async function handle(request, context = {}) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    const target = pathname.startsWith('/price-guides') ? pathname.replace('/price-guides', '/public/price-guides') : pathname;
    const parts = target.split('/');
    const verb = request.method === 'HEAD' ? 'GET' : request.method;
    const methods = new Set();
    let found, params;
    for (const route of routes) {
      if (route.parts.length !== parts.length) continue;
      const mapped = {};
      let match;
      try { match = route.parts.every((part, i) => part.startsWith(':') ? (mapped[part.slice(1)] = decodeURIComponent(parts[i]), true) : part === parts[i]); }
      catch { return Response.json({ error: 'Invalid URL.' }, { status: 400 }); }
      if (!match) continue;
      methods.add(route.method);
      if (route.method === verb) { found = route; params = mapped; break; }
    }
    if (!found) return Response.json({ error: methods.size ? 'Method not allowed' : 'Not found' }, { status: methods.size ? 405 : 404, headers: { 'Cache-Control': 'no-store', ...(methods.size ? { Allow: [...methods].join(', ') } : {}) } });
    let body = {};
    if (['POST', 'PATCH'].includes(request.method)) {
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return Response.json({ error: 'Use JSON for this request.' }, { status: 415 });
      // Limit the stream as well as Content-Length; a forged/missing length
      // cannot make a function buffer an arbitrarily large chat request.
      const reader = request.body?.getReader();
      let size = 0; const chunks = [];
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 16384) { await reader.cancel(); return Response.json({ error: 'Request too large.' }, { status: 413 }); }
        chunks.push(Buffer.from(value));
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Use a JSON object.' }, { status: 400 });
    }
    const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    let status = 200, payload = '', sent = false;
    const req = { headers: Object.fromEntries(request.headers), params, body, ip: context.ip || 'unknown' };
    const res = {
      get headersSent() { return sent; },
      set(name, value) { headers.set(name, String(value)); return this; },
      status(code) { status = code; return this; },
      type(value) { headers.set('Content-Type', value === 'html' ? 'text/html; charset=utf-8' : value); return this; },
      json(value) { headers.set('Content-Type', 'application/json; charset=utf-8'); payload = JSON.stringify(value); sent = true; return this; },
      send(value) { payload = String(value); sent = true; return this; },
    };
    try { await found.handler(req, res); }
    catch { if (!sent) { status = 503; res.json({ error: 'This service is temporarily unavailable. Please try again shortly.' }); } }
    if (!sent) { status = 503; res.json({ error: 'This service did not return a response.' }); }
    return new Response(request.method === 'HEAD' ? null : payload, { status, headers });
  }
  return { app, handle };
}
module.exports = { createRouter };
