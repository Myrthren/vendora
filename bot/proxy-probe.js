// ── Proxy probe ───────────────────────────────────────────────────────────────
// Asks the configured proxy to open a tunnel to Vinted and reports exactly what
// came back — one CONNECT, a few seconds, no browser.
//
// WHY (2026-09-13): the proxy "hangs" diagnosis was incomplete. Probed from
// outside, proxy.smartproxy.net:3120 (real IP 212.102.56.56) answers an
// unauthenticated CONNECT with "407 Proxy Authentication Required" in ~90ms —
// the server is alive. Chromium, given credentials the proxy rejects, does not
// surface a clean error; navigation just runs into its 25s timeout. So "the
// proxy hangs" and "the proxy rejects our credentials" looked identical, and
// the circuit breaker could only ever say "timeout". This asks the question
// directly and names the failure.
//
// Also worth knowing when testing locally: Virgin Media's resolver
// (194.168.4.100) answers *.smartproxy.net / gate.smartproxy.com with
// 81.99.162.48, which hangs — an ISP-side block. Google DNS gives the real IPs.
// Railway does not use that resolver.
//
// Pure helpers plus one socket function. Never logs or returns credentials.

const net = require('net');
const tls = require('tls');

function parseStatusLine(buf) {
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(String(buf || ''));
  return m ? Number(m[1]) : null;
}

// Raw probe result → { ok, reason }. The reason is written for the owner
// reading the health endpoint, so it says what to check, not just what failed.
function classifyProbe(r) {
  if (!r) return { ok: false, reason: 'No probe result' };
  if (r.status === 200) return { ok: true, reason: 'Proxy opened a tunnel to Vinted' };
  if (r.status === 407) {
    return { ok: false, reason: 'Proxy rejected the credentials in PROXY_URL: wrong username or password, or the proxy plan has expired or run out of traffic' };
  }
  if (r.status === 402) return { ok: false, reason: 'Proxy says payment is required: the plan has expired or run out of traffic' };
  if (r.status === 403) return { ok: false, reason: 'Proxy refused the request: this server may not be whitelisted, or the plan does not allow this site' };
  if (r.status >= 500 && r.status < 600) return { ok: false, reason: `Proxy is up but could not reach Vinted (HTTP ${r.status})` };
  if (r.status) return { ok: false, reason: `Proxy answered HTTP ${r.status}` };
  if (r.error === 'INVALID_URL') return { ok: false, reason: 'PROXY_URL is not a valid URL' };
  if (r.error === 'ENOTFOUND' || r.error === 'EAI_AGAIN') return { ok: false, reason: 'The proxy hostname in PROXY_URL does not resolve' };
  if (r.error === 'ECONNREFUSED') return { ok: false, reason: 'The proxy host refused the connection: check the port in PROXY_URL' };
  if (r.timedOut && r.stage === 'connect') return { ok: false, reason: 'Could not reach the proxy host at all (network, firewall or a dead host)' };
  if (r.timedOut) return { ok: false, reason: 'Proxy accepted the connection but never answered' };
  if (r.error) return { ok: false, reason: `Proxy connection failed (${r.error})` };
  return { ok: false, reason: 'Proxy closed the connection without answering' };
}

// → { status?, error?, timedOut?, stage: 'parse'|'connect'|'reply', ms }
function probeProxy(proxyUrl, { target = 'www.vinted.co.uk:443', timeoutMs = 8000 } = {}) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(proxyUrl); } catch { return resolve({ error: 'INVALID_URL', stage: 'parse', ms: 0 }); }

    const secure = u.protocol === 'https:';
    const port = Number(u.port) || (secure ? 443 : 80);
    const auth = u.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')}\r\n`
      : '';

    const t0 = Date.now();
    let stage = 'connect';
    let buf = '';
    let settled = false;

    const opts = { host: u.hostname, port };
    const sock = secure ? tls.connect({ ...opts, servername: u.hostname }) : net.connect(opts);

    const done = extra => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ stage, ms: Date.now() - t0, ...extra });
    };
    const timer = setTimeout(() => done({ timedOut: true }), timeoutMs);

    sock.once(secure ? 'secureConnect' : 'connect', () => {
      stage = 'reply';
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    sock.on('data', d => {
      buf += d;
      if (buf.includes('\r\n')) done({ status: parseStatusLine(buf) });
    });
    sock.on('error', e => done({ error: e.code || e.message }));
    sock.on('close', () => done({}));
  });
}

module.exports = { parseStatusLine, classifyProbe, probeProxy };
