// bot/vinted-browser.js
// Playwright + stealth flow for Vinted to bypass DataDome.
//
// Why: Vinted's /api/v2/items (item creation) is protected by DataDome,
// which blocks datacenter IPs and odd TLS fingerprints. Doing everything
// through a real Chromium instance (routed through the user's residential
// proxy) lets us (a) solve DataDome naturally during login and (b) issue
// subsequent API calls from inside the page context so they carry the
// browser's TLS fingerprint + solved DataDome cookies.
//
// Public API (all async):
//   vintedBrowserLogin(username, password)                      → { access_token, refresh_token, platform_user_id, platform_username } | { error }
//   vintedBrowserUploadPhoto(accessToken, base64, mimeType)      → { photo_id } | { error }
//   vintedBrowserCreateListing(accessToken, listingData)         → { ok, listing_id, url } | { error }
//   vintedBrowserValidateToken(token)                            → { valid, username?, user_id?, error?, warning? }
//   closeVintedBrowser()                                         → releases the shared browser
//
// Module state: one persistent browserContext shared across calls. Cookies
// (including the solved DataDome cookie) persist across the process lifetime
// so we only pay the fingerprinting cost once.

let chromium = null;
let stealthApplied = false;
try {
  // playwright-extra + stealth plugin (preferred — best anti-detection)
  const pwExtra = require('playwright-extra');
  chromium = pwExtra.chromium;
  try {
    const stealth = require('puppeteer-extra-plugin-stealth')();
    chromium.use(stealth);
    stealthApplied = true;
  } catch (e) {
    console.warn('[vinted-browser] stealth plugin not loaded:', e.message);
  }
} catch (e) {
  // fallback to plain playwright if playwright-extra isn't installed
  try {
    chromium = require('playwright').chromium;
  } catch (e2) {
    console.warn('[vinted-browser] playwright not installed — Vinted browser flow disabled:', e2.message);
    chromium = null;
  }
}

const PROXY_URL = process.env.PROXY_URL || null;
// Direct CONNECT probe of PROXY_URL — names WHY a proxy is unusable. See bot/proxy-probe.js.
const proxyProbe = require('./proxy-probe');

// ─── shared browser state ─────────────────────────────────────────────────────
let _browser = null;
let _context = null;
let _launchingPromise = null;

function parseProxy(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      server:   `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch { return null; }
}

// Whether the last browser launch skipped the proxy due to a tunnel failure
let _proxySkipped = false;

// ─── proxy circuit breaker ────────────────────────────────────────────────────
// A dead proxy HANGS rather than refusing, so it shows up as a 25s goto timeout
// rather than ERR_TUNNEL_CONNECTION_FAILED. The login path already retried
// without the proxy, but only on the tunnel error and only for login — so a
// timing-out proxy took every Vinted feature down and stayed down until someone
// noticed and fixed the credentials by hand.
//
// After PROXY_FAIL_THRESHOLD consecutive failures to reach Vinted, drop the
// proxy and run direct for PROXY_COOLDOWN_MS, then try it again. Running from a
// datacenter IP risks DataDome, but a proxy that cannot connect is a guaranteed
// outage — degraded beats dead, and it recovers on its own when the proxy does.
const PROXY_FAIL_THRESHOLD = 2;
const PROXY_COOLDOWN_MS    = 30 * 60 * 1000;
let _proxyFailures     = 0;
let _proxyDisabledUntil = 0;

function proxyCurrentlyDisabled() {
  return _proxyDisabledUntil > Date.now();
}

// Called whenever Vinted could not be reached.
async function noteVintedUnreachable(reason) {
  if (!PROXY_URL || proxyCurrentlyDisabled()) return false;
  _proxyFailures++;
  if (_proxyFailures < PROXY_FAIL_THRESHOLD) return false;

  _proxyFailures = 0;
  _proxyDisabledUntil = Date.now() + PROXY_COOLDOWN_MS;
  _proxySkipped = true;
  console.warn(
    `[vinted-browser] Proxy unreachable ${PROXY_FAIL_THRESHOLD}x (${reason}). ` +
    `Dropping it for ${PROXY_COOLDOWN_MS / 60000} min and running direct. ` +
    `DataDome may block a datacenter IP — fix PROXY_URL to restore normal operation.`
  );
  // Force the next ensureBrowser() to relaunch without the proxy.
  await closeVintedBrowser();
  return true;
}

function noteVintedReachable() {
  _proxyFailures = 0;
}

// ─── proxy probe ──────────────────────────────────────────────────────────────
// The breaker above only learns the proxy is broken by failing real work, and
// its state is in memory: after every deploy, and at every 30-minute retry, two
// real Vinted runs time out before it trips again. The probe asks the proxy
// directly — one CONNECT to Vinted through PROXY_URL, a few seconds — so a
// broken proxy is dropped before anything uses it and put back as soon as it
// works, and the health endpoint says WHY (credentials rejected, plan expired,
// unreachable) instead of "timeout".
const PROBE_INTERVAL_MS = 10 * 60 * 1000;
let _lastProbe = null;
let _probing = null;

async function refreshProxyProbe() {
  if (!PROXY_URL) return null;
  if (_probing) return _probing;
  _probing = (async () => {
    const raw = await proxyProbe.probeProxy(PROXY_URL);
    const verdict = proxyProbe.classifyProbe(raw);
    const prev = _lastProbe;
    _lastProbe = { ok: verdict.ok, status: raw.status || null, reason: verdict.reason, ms: raw.ms, at: Date.now() };

    if (verdict.ok) {
      if (proxyCurrentlyDisabled() || (prev && !prev.ok)) console.log('[vinted-browser] Proxy probe passed — proxy enabled.');
      _proxyDisabledUntil = 0;
      _proxyFailures = 0;
      // A browser that launched direct keeps running direct until relaunched.
      // Closing it can fail an in-flight page, but only on this rare transition.
      if (_context && _proxySkipped) await closeVintedBrowser();
    } else {
      // Log on change only — a probe every 10 minutes repeating the same
      // failure would bury everything else in the Railway logs.
      if (!prev || prev.ok || prev.reason !== verdict.reason) {
        console.warn(`[vinted-browser] Proxy probe failed: ${verdict.reason}. Running direct until it passes.`);
      }
      const browserOnProxy = _context && !_proxySkipped;
      _proxyDisabledUntil = Date.now() + PROXY_COOLDOWN_MS;
      _proxySkipped = true;
      if (browserOnProxy) await closeVintedBrowser();
    }
    return _lastProbe;
  })();
  try { return await _probing; } finally { _probing = null; }
}

// Probe at boot, then every 10 minutes. ensureBrowser waits for the boot probe,
// so no launch after a deploy ever uses a proxy nobody has checked.
const _initialProbe = PROXY_URL
  ? refreshProxyProbe().catch(e => { console.warn('[vinted-browser] Initial proxy probe threw:', e.message); return null; })
  : Promise.resolve(null);
if (PROXY_URL) {
  const t = setInterval(() => { refreshProxyProbe().catch(() => {}); }, PROBE_INTERVAL_MS);
  if (t.unref) t.unref();
}

// Whether PROXY_URL should be used right now. index.js consults this for its
// undici ProxyAgent calls, so they stop timing out through a broken proxy too.
function proxyUsable() {
  return !!PROXY_URL && !proxyCurrentlyDisabled();
}

// For the health endpoint, so the state is visible without reading logs.
// proxyProbe carries a status code and a reason — never the URL or credentials.
function vintedBrowserStatus() {
  return {
    playwright:      !!chromium,
    stealth:         stealthApplied,
    proxyConfigured: !!PROXY_URL,
    proxyDisabled:   proxyCurrentlyDisabled(),
    proxyRetryAt:    proxyCurrentlyDisabled() ? _proxyDisabledUntil : null,
    consecutiveFails: _proxyFailures,
    proxyProbe:      _lastProbe,
  };
}

async function launchBrowser(useProxy = true) {
  const proxy = useProxy ? parseProxy(PROXY_URL) : null;
  console.log(`[vinted-browser] launching chromium (stealth=${stealthApplied}, proxy=${!!proxy})`);
  const browser = await chromium.launch({
    headless: true,
    proxy: proxy || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
  const context = await newVintedContext(browser);
  return { browser, context };
}

async function newVintedContext(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

// Anything that puts a MEMBER'S token in a cookie runs in a context of its own,
// closed when the call ends. The shared context (ensureBrowser) stays anonymous.
//
// WHY: setAuthCookie used to write into the shared context and nothing removed
// it. From 2026-09-14 19:05 every anonymous wardrobe read returned 401, because
// an expired member token was still sitting in the cookie jar and was sent with
// every request. Worse, two members' authenticated calls overlapping could
// overwrite each other's cookie — a purchase or listing made on the wrong
// Vinted account.
async function isolatedContext() {
  await ensureBrowser();
  return newVintedContext(_browser);
}

async function closeQuietly(ctx) {
  try { if (ctx) await ctx.close(); } catch {}
}

async function ensureBrowser() {
  if (!chromium) throw new Error('Playwright not installed');
  if (_context) return _context;
  if (_launchingPromise) return _launchingPromise;

  _launchingPromise = (async () => {
    // Never launch on an unchecked proxy: wait for the boot probe, and when a
    // cooldown has run out after a failed probe, probe again first instead of
    // spending real runs to find out it is still broken.
    await _initialProbe;
    if (PROXY_URL && _lastProbe && !_lastProbe.ok && !proxyCurrentlyDisabled()) await refreshProxyProbe();
    // Honour the circuit breaker: while the proxy is in cooldown, launch direct.
    const useProxy = !proxyCurrentlyDisabled();
    const { browser, context } = await launchBrowser(useProxy);
    _browser  = browser;
    _context  = context;
    _proxySkipped = !useProxy;
    return _context;
  })();

  try { return await _launchingPromise; }
  finally { _launchingPromise = null; }
}

async function closeVintedBrowser() {
  try { if (_context) await _context.close(); } catch {}
  try { if (_browser) await _browser.close(); } catch {}
  _context = null; _browser = null;
}

// Load Vinted's homepage and return the base URL we actually landed on.
// We do NOT follow geo-redirects (.co.uk → .fr) — we always use .co.uk as
// canonical. The proxy may route through France but the .co.uk site still
// serves the right content; locale redirects just break locale-specific URL paths.
// `strict` is for callers that have a fallback worth reaching.
//
// Swallowing the failure and returning the default URL anyway means the caller
// then runs page.evaluate against a page that never loaded; the fetch inside it
// fails, returns [], and the caller cannot tell that apart from "Vinted has no
// listings for this". Search then reports a successful empty result and the
// Apify fallback is never tried — a total outage that looks like a quiet day.
// Vinted's ANONYMOUS session: access_token_web is a JWT that expires 24h after
// it is issued, but the cookie holding it lives for 7 days (probed 2026-09-16:
// jwt lifetime 24.0h, cookie 168h). The shared context runs for days, so after
// its first 24 hours every request carried a dead token — and loading the
// homepage does NOT replace a cookie that is still present. That is the
// "wardrobe 401" that started exactly 24h after the 2026-09-13 19:00 launch.
//
// So before each page load on the SHARED context, drop the anonymous tokens
// once they are within the margin of expiry; the homepage then issues fresh
// ones. Isolated contexts carry a member's token and are left alone — clearing
// those would silently turn an authenticated call anonymous.
const ANON_TOKEN_MARGIN_MS = 60 * 60 * 1000;

function jwtExpiryMs(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp;
    return exp ? exp * 1000 : null;
  } catch { return null; }
}

async function refreshAnonSessionIfStale(ctx) {
  if (!ctx || ctx !== _context) return;
  try {
    const cookies = await ctx.cookies('https://www.vinted.co.uk');
    const access = cookies.find(c => c.name === 'access_token_web');
    if (!access) return;
    const exp = jwtExpiryMs(access.value);
    if (exp && exp - Date.now() > ANON_TOKEN_MARGIN_MS) return;
    await ctx.clearCookies({ name: 'access_token_web' });
    await ctx.clearCookies({ name: 'refresh_token_web' });
    console.log(`[vinted-browser] Anonymous session token ${exp && exp < Date.now() ? 'expired' : 'near expiry'} — cleared so the homepage issues a fresh one.`);
  } catch (e) {
    console.warn('[vinted-browser] Anonymous session check failed:', e.message);
  }
}

async function resolveVintedBase(page, strict = false) {
  await refreshAnonSessionIfStale(page.context());
  try {
    await page.goto('https://www.vinted.co.uk/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    noteVintedReachable();
    // Ignore geo-redirects — always use .co.uk so login URLs are predictable
    return 'https://www.vinted.co.uk';
  } catch (e) {
    if (e.message.includes('ERR_TUNNEL_CONNECTION_FAILED') || e.message.includes('ERR_PROXY_CONNECTION_FAILED')) {
      await noteVintedUnreachable('tunnel failed');
      throw new Error('PROXY_TUNNEL_FAILED:' + e.message);
    }
    console.warn('[vinted-browser] base resolve failed:', e.message);
    // A timeout is what a dead proxy actually looks like. Feed the breaker so
    // the next launch can drop the proxy instead of failing forever.
    await noteVintedUnreachable('goto timeout');
    if (strict) throw new Error('BASE_UNREACHABLE: could not load vinted.co.uk — ' + e.message);
    return 'https://www.vinted.co.uk';
  }
}

// ─── cookie helpers ──────────────────────────────────────────────────────────
async function cookieValue(ctx, name, domainMatch = 'vinted') {
  const cookies = await ctx.cookies();
  const c = cookies.find(c => c.name === name && c.domain.includes(domainMatch));
  return c?.value || '';
}

// Set the auth cookie for both .vinted.co.uk and the geo-resolved domain
async function setAuthCookie(ctx, token) {
  const domains = ['.vinted.co.uk', '.vinted.fr', '.vinted.de', '.vinted.es', '.vinted.pl', '.vinted.be', '.vinted.nl'];
  for (const d of domains) {
    await ctx.addCookies([{
      name: 'access_token_web',
      value: token,
      domain: d,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }]).catch(() => {});
  }
}

// ─── public: login ───────────────────────────────────────────────────────────
async function vintedBrowserLogin(username, password) {
  if (!chromium) return { error: 'Browser automation not available — playwright not installed.' };
  if (!username || !password) return { error: 'Username and password required.' };

  let page;
  let ctx;
  try {
    try {
      ctx = await isolatedContext();
      page = await ctx.newPage();
    } catch (e) {
      return { error: `Browser failed to launch: ${e.message}` };
    }

    let base;
    try {
      base = await resolveVintedBase(page);
    } catch (e) {
      if (e.message.startsWith('PROXY_TUNNEL_FAILED')) {
        // Proxy can't establish HTTPS tunnel — tear down and retry without proxy
        console.warn('[vinted-browser-login] Proxy tunnel failed — retrying without proxy');
        try { await page.close(); } catch {}
        await closeVintedBrowser();
        _proxySkipped = true;
        const { browser: b2, context: c2 } = await launchBrowser(false);
        _browser = b2; _context = c2;
        ctx = await newVintedContext(b2);
        page = await ctx.newPage();
        base = await resolveVintedBase(page).catch(() => 'https://www.vinted.co.uk');
        console.warn('[vinted-browser-login] Running WITHOUT proxy — DataDome may block login from this IP. Fix: set PROXY_URL to a residential proxy that supports HTTPS on port 443.');
      } else {
        throw e;
      }
    }
    console.log(`[vinted-browser-login] base=${base} (proxy_skipped=${_proxySkipped})`);

    // ── Load homepage so DataDome issues us a valid session cookie ──────────
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800);

    // ── Check for DataDome hard block ────────────────────────────────────────
    const blocked = await page.evaluate(() =>
      document.title?.toLowerCase().includes('blocked') ||
      !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="datadome"], [id*="dd-challenge"]')
    ).catch(() => false);
    if (blocked) {
      return { error: 'Vinted is blocking this server\'s IP (DataDome). A UK residential proxy is required — set PROXY_URL on Railway.' };
    }

    // ── Direct API login (no UI interaction needed) ───────────────────────────
    // Vinted's mobile/web API is called from inside the browser context so that
    // DataDome cookies + TLS fingerprint are carried automatically.
    // We try several known endpoint shapes in order.

    // Step 1: extract CSRF token — Vinted embeds it as "CSRF_TOKEN":"..." in page HTML
    const csrfToken = await page.evaluate(() => {
      try {
        // Primary: embedded in JS bundle as "CSRF_TOKEN":"<value>"
        const html = document.documentElement.innerHTML;
        const m = html.match(/"CSRF_TOKEN":"([^"]+)"/);
        if (m) return m[1];
        // Fallback: meta tag (older Vinted versions)
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) return meta.getAttribute('content');
        // Fallback: window globals
        return window._rails_csrf_token || window.__CSRF__ || null;
      } catch { return null; }
    }).catch(() => null);
    console.log(`[vinted-browser-login] csrf=${csrfToken ? csrfToken.slice(0,12) + '…' : 'not found'}`);

    const apiResult = await page.evaluate(async ({ user, pass, csrf }) => {
      const attempts = [];

      const post = async (url, body, contentType = 'application/json') => {
        const headers = { 'Content-Type': contentType, Accept: 'application/json' };
        if (csrf) headers['X-CSRF-Token'] = csrf;
        const r = await fetch(url, {
          method: 'POST', credentials: 'include', headers,
          body: contentType === 'application/json' ? JSON.stringify(body) : new URLSearchParams(body).toString(),
        });
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch { data = null; }
        return { status: r.status, data, raw: text.slice(0, 300) };
      };

      // ── 1. Vinted app-style JSON login (most likely to work) ────────────
      for (const payload of [
        { login: user, password: pass },
        { user: { login: user, password: pass } },
        { email: user, password: pass },
      ]) {
        try {
          const res = await post('/api/v2/users/login', payload);
          attempts.push({ ep: '/api/v2/users/login', status: res.status, error: res.data?.error_code || res.data?.error });
          const token = res.data?.user?.auth_token || res.data?.access_token || res.data?.token;
          if (token) return { ok: true, access_token: token, refresh_token: res.data?.user?.refresh_token || res.data?.refresh_token || '', user: res.data?.user };
          if (res.status === 401 || res.data?.error_code === 'invalid_credentials' || res.data?.error === 'invalid_grant') return { invalid_credentials: true, attempts };
        } catch (e) { attempts.push({ ep: '/api/v2/users/login', error: e.message }); }
      }

      // ── 2. OAuth token endpoint with CSRF header ─────────────────────────
      for (const cid of ['web', 'vinted-web-2', '']) {
        try {
          const res = await post('/oauth/token',
            { grant_type: 'password', username: user, password: pass, scope: 'user', ...(cid ? { client_id: cid } : {}) },
            'application/x-www-form-urlencoded'
          );
          attempts.push({ ep: '/oauth/token', cid, status: res.status, error: res.data?.error });
          if (res.data?.access_token) return { ok: true, access_token: res.data.access_token, refresh_token: res.data.refresh_token || '' };
          if (res.data?.error === 'invalid_grant') return { invalid_credentials: true, attempts };
        } catch (e) { attempts.push({ ep: '/oauth/token', cid, error: e.message }); }
      }

      return { api_failed: true, attempts };
    }, { user: username, pass: password, csrf: csrfToken });

    if (apiResult.invalid_credentials) {
      return { error: 'Incorrect Vinted username or password.' };
    }

    if (apiResult.api_failed) {
      console.warn('[vinted-browser-login] direct API failed, trying form-based login:', JSON.stringify(apiResult.attempts));

      // ── Fallback: form-based login with full React hydration wait ────────
      // Navigate to /login with networkidle — waits for React to fully render
      // the login modal before we look for form fields.
      try {
        await page.goto(`${base}/login`, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(1500);

        const formResult = await page.evaluate(async ({ user, pass }) => {
          const passEl = document.querySelector('input[type="password"], input[name="password"], input[autocomplete="current-password"]');
          if (!passEl) return { no_form: true };

          const userEl = document.querySelector('input[type="email"], input[name="username"], input[name="login"], input[name="email"], input[autocomplete="username"], input[autocomplete="email"]');
          if (!userEl) return { no_user_field: true };

          userEl.focus(); userEl.value = user;
          userEl.dispatchEvent(new Event('input', { bubbles: true }));
          userEl.dispatchEvent(new Event('change', { bubbles: true }));
          passEl.focus(); passEl.value = pass;
          passEl.dispatchEvent(new Event('input', { bubbles: true }));
          passEl.dispatchEvent(new Event('change', { bubbles: true }));

          const submitBtn = document.querySelector('button[type="submit"], [data-testid="submit-button"], form button');
          if (!submitBtn) return { no_submit: true };
          submitBtn.click();
          return { submitted: true };
        }, { user: username, pass: password });

        if (formResult.submitted) {
          // Wait for the auth cookie to be set after form submission
          await page.waitForTimeout(4000);
          const formToken = await cookieValue(ctx, 'access_token_web') || await cookieValue(ctx, '_vinted_fr_session');
          if (formToken) {
            console.log('[vinted-browser-login] form-based login succeeded');
            // Decode JWT for user ID — avoids a /users/me call that may not exist
            let formUserId = '', formUsername = username;
            try {
              const parts = formToken.split('.');
              if (parts.length === 3) {
                const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                formUserId   = String(p.user_id || p.sub || p.id || p.uid || '').replace(/\D/g, '');
                formUsername = p.username || p.login || p.preferred_username || username;
              }
            } catch {}
            return {
              access_token:      formToken,
              refresh_token:     await cookieValue(ctx, 'refresh_token_web') || '',
              platform_user_id:  formUserId,
              platform_username: formUsername,
            };
          }
        }
        const formTitle = await page.title().catch(() => '?');
        console.warn('[vinted-browser-login] form-based login also failed, title:', formTitle, 'result:', JSON.stringify(formResult));
      } catch (formErr) {
        console.warn('[vinted-browser-login] form-based fallback error:', formErr.message);
      }

      return { error: `Vinted login failed. API attempts: ${JSON.stringify(apiResult.attempts?.slice(0,2))}` };
    }

    // ── Extract user ID — JWT first, /users/me as confirmation ─────────────────
    // JWT payload always contains the numeric user ID — extract it without an
    // extra network hop. /users/me is only used to confirm the username.
    let jwtUserId = '';
    let jwtUsername = '';
    try {
      const parts = apiResult.access_token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        jwtUserId   = String(payload.user_id || payload.sub || payload.id || payload.uid || '').replace(/\D/g, '');
        jwtUsername = payload.username || payload.login || payload.preferred_username || '';
      }
    } catch {}
    console.log(`[vinted-browser-login] JWT user_id=${jwtUserId || 'not-found'}`);

    // Try /users/{id} if we got the ID from JWT (avoids /users/me which may 404)
    await setAuthCookie(ctx, apiResult.access_token);
    let confirmedUsername = jwtUsername || username;
    if (jwtUserId) {
      try {
        const me = await page.evaluate(async (uid) => {
          try {
            const r = await fetch(`/api/v2/users/${uid}`, { credentials: 'include', headers: { Accept: 'application/json' } });
            if (!r.ok) return null;
            const d = await r.json();
            return d?.user || d || null;
          } catch { return null; }
        }, jwtUserId);
        if (me?.login || me?.username) confirmedUsername = me.login || me.username;
      } catch {}
    }

    return {
      access_token:      apiResult.access_token,
      refresh_token:     apiResult.refresh_token || await cookieValue(ctx, 'refresh_token_web') || '',
      platform_user_id:  jwtUserId,
      platform_username: confirmedUsername,
    };
  } catch (e) {
    console.error('[vinted-browser-login] error:', e);
    return { error: e.message || 'Browser login failed' };
  } finally {
    try { if (page) await page.close(); } catch {}
    await closeQuietly(ctx);
  }
}

// ─── public: validate token ──────────────────────────────────────────────────
// Injects the provided token as an access_token_web cookie and hits /users/me.
async function vintedBrowserValidateToken(token) {
  if (!chromium) return { valid: null, warning: 'Browser unavailable — token saved unvalidated.' };
  let page;
  let ctx;
  try {
    ctx = await isolatedContext();
    await setAuthCookie(ctx, token);
    page = await ctx.newPage();
    const base = await resolveVintedBase(page);
    const res = await page.evaluate(async (base) => {
      try {
        const r = await fetch(`${base}/api/v2/users/me`, { credentials: 'include', headers: { 'Accept': 'application/json' } });
        const t = await r.text();
        try { return { status: r.status, data: JSON.parse(t) }; }
        catch { return { status: r.status, html: t.slice(0, 300) }; }
      } catch (e) { return { error: e.message }; }
    }, base);
    if (res.status === 200 && res.data) {
      const u = res.data.user || res.data;
      return { valid: true, username: u.login || u.username || '', user_id: String(u.id || '') };
    }
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: 'Token invalid or expired.' };
    }
    return { valid: null, warning: `Vinted returned ${res.status || 'no-status'} during validation — token saved.` };
  } catch (e) {
    return { valid: null, warning: `Validation error: ${e.message}` };
  } finally {
    try { if (page) await page.close(); } catch {}
    await closeQuietly(ctx);
  }
}

// ─── public: upload photo ────────────────────────────────────────────────────
async function vintedBrowserUploadPhoto(accessToken, base64, mimeType = 'image/jpeg') {
  if (!chromium) return { error: 'Browser unavailable' };
  let page;
  let ctx;
  try {
    ctx = await isolatedContext();
    await setAuthCookie(ctx, accessToken);
    page = await ctx.newPage();
    const base = await resolveVintedBase(page);

    const result = await page.evaluate(async ({ base, b64, mime }) => {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        const fd = new FormData();
        fd.append('photo[image_type]', 'user_items');
        fd.append('photo[orientation]', '0');
        fd.append('photo[image]', blob, 'photo.jpg');
        const r = await fetch(`${base}/api/v2/photos`, {
          method: 'POST', body: fd, credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        const t = await r.text();
        let d; try { d = JSON.parse(t); } catch { return { status: r.status, html: t.slice(0, 200) }; }
        return { status: r.status, data: d };
      } catch (e) { return { error: e.message }; }
    }, { base, b64: base64, mime: mimeType });

    if (result.error) return { error: result.error };
    if (result.html)  return { error: `Vinted photo upload blocked (${result.status}): ${result.html}` };
    if (result.status >= 400) return { error: `Vinted photo upload failed (${result.status})` };
    const id = result.data?.id || result.data?.photo?.id;
    if (!id) return { error: 'Vinted photo upload returned no id' };
    return { photo_id: id };
  } catch (e) {
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
    await closeQuietly(ctx);
  }
}

// ─── public: create listing ──────────────────────────────────────────────────
async function vintedBrowserCreateListing(accessToken, listingData) {
  if (!chromium) return { error: 'Browser unavailable' };
  const {
    title, description = '', price, condition, photo_ids = [],
    brand = '', size = '',
    vinted_catalog_id = null, vinted_package_size_id = 2,
  } = listingData;
  const condMap = {
    'New with tags': 6, 'New without tags': 1,
    'Like New': 2, 'Like New — barely worn': 2,
    'Very Good': 3, 'Very Good — minor signs of wear': 3,
    'Good': 4, 'Good — visible signs of wear': 4,
    'Acceptable': 5, 'Acceptable — heavily worn': 5,
  };
  const brandLine = [brand && `Brand: ${brand}`, size && `Size: ${size}`].filter(Boolean).join(' · ');
  const fullDesc  = brandLine ? `${brandLine}\n\n${description}`.trim() : description;
  const body = {
    title,
    description: fullDesc,
    price: String(parseFloat(price).toFixed(2)),
    currency: 'GBP',
    catalog_id: vinted_catalog_id || 1,
    status_id: condMap[condition] || 3,
    package_size_id: vinted_package_size_id || 2,
  };
  if (photo_ids.length) body.photos = photo_ids.map(id => ({ id }));

  let page;
  let ctx;
  try {
    ctx = await isolatedContext();
    await setAuthCookie(ctx, accessToken);
    page = await ctx.newPage();
    const base = await resolveVintedBase(page);

    const result = await page.evaluate(async ({ base, body }) => {
      try {
        const r = await fetch(`${base}/api/v2/items`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body),
        });
        const t = await r.text();
        let d; try { d = JSON.parse(t); } catch { return { status: r.status, html: t.slice(0, 400) }; }
        return { status: r.status, data: d };
      } catch (e) { return { error: e.message }; }
    }, { base, body });

    if (result.error) return { error: result.error };
    if (result.html) {
      if (/captcha-delivery|datadome/i.test(result.html)) {
        return { error: 'Vinted DataDome challenge on item creation — proxy IP flagged. Try a different residential proxy region.' };
      }
      return { error: `Vinted item creation failed (${result.status}): ${result.html}` };
    }
    if (result.status >= 400) {
      const err = result.data?.message || result.data?.error || `HTTP ${result.status}`;
      if (/unauthenticated|invalid_auth/i.test(err)) {
        return { error: 'Your Vinted session has expired. Reconnect your Vinted account.' };
      }
      return { error: `Vinted error (${result.status}): ${err}` };
    }
    const item = result.data?.item || result.data;
    return {
      ok: true,
      listing_id: String(item.id || ''),
      url: item.url || `${base}/items/${item.id}`,
    };
  } catch (e) {
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
    await closeQuietly(ctx);
  }
}

// ─── public: fetch analytics ─────────────────────────────────────────────────
// Uses the stored access_token to pull profile stats + active listings from
// Vinted's API from inside the browser context (bypasses DataDome).
// Returns { meRes, itemsRes } where both are { ok, status, data } objects.
async function vintedBrowserFetchAnalytics(accessToken, userId) {
  if (!chromium) return { error: 'Browser unavailable' };
  let page;
  let ctx;
  try {
    ctx = await isolatedContext();

    // Set cookie for the .co.uk domain first, then we'll resolve the real base
    await ctx.addCookies([{
      name: 'access_token_web',
      value: accessToken,
      domain: '.vinted.co.uk',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }]).catch(() => {});

    page = await ctx.newPage();
    const base = await resolveVintedBase(page);

    // Re-set cookie for the resolved domain (may differ from .co.uk)
    try {
      const resolvedHost = new URL(base).hostname;
      const cookieDomain = '.' + resolvedHost;
      if (cookieDomain !== '.www.vinted.co.uk') {
        await ctx.addCookies([{
          name: 'access_token_web',
          value: accessToken,
          domain: cookieDomain,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        }]).catch(() => {});
      }
    } catch {}

    const result = await page.evaluate(async ({ base, uid }) => {
      async function apiFetch(url) {
        try {
          const r = await fetch(url, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
          });
          const t = await r.text();
          try { return { ok: r.ok, status: r.status, data: JSON.parse(t) }; }
          catch { return { ok: false, status: r.status, html: t.slice(0, 300) }; }
        } catch (e) { return { error: e.message }; }
      }

      const targetId = uid || 'me';
      const [meRes, itemsRes] = await Promise.all([
        apiFetch(`${base}/api/v2/users/me`),
        apiFetch(`${base}/api/v2/users/${targetId}/items?per_page=96&page=1&order=newest_first`),
      ]);

      return { meRes, itemsRes, base };
    }, { base, uid: userId || '' });

    return result;
  } catch (e) {
    console.error('[vinted-browser-analytics] error:', e);
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
    await closeQuietly(ctx);
  }
}

// Look up a Vinted user by username via browser context (DataDome bypassed).
// Returns { id, login }  — user found with numeric ID
//         { exists }     — user page loaded but ID not extractable (has 0 listings)
//         { not_found }  — user definitively does not exist
//         { error }      — browser unavailable or network failure
async function vintedBrowserLookupUser(username) {
  if (!chromium) return { error: 'Browser unavailable' };
  let page;
  try {
    const ctx = await ensureBrowser();
    page = await ctx.newPage();
    const base = await resolveVintedBase(page);
    const clean = username.toLowerCase();

    // Step 1: Try user search API from inside browser context (DataDome bypassed).
    // Vinted returns an array of users matching the search_text query.
    const apiResult = await page.evaluate(async ({ base, clean }) => {
      for (const url of [
        `${base}/api/v2/users?search_text=${encodeURIComponent(clean)}&per_page=20`,
        `${base}/api/v2/users?login=${encodeURIComponent(clean)}&per_page=5`,
      ]) {
        try {
          const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
          if (!r.ok) continue;
          const d = await r.json();
          const list = Array.isArray(d) ? d : (d.users || d.members || d.items || []);
          const hit = list.find(u =>
            (u.login || u.username || '').toLowerCase() === clean
          );
          if (hit) return { id: String(hit.id), login: hit.login || hit.username || clean };
        } catch {}
      }
      return null;
    }, { base, clean });

    if (apiResult?.id) {
      console.log(`[vinted-lookup] API found @${clean} → id ${apiResult.id}`);
      return apiResult;
    }

    // Step 2: Navigate to the member page and check if it's real.
    // A non-existent user redirects away from /member/{username}.
    console.log(`[vinted-lookup] API miss, navigating to member page for @${clean}`);
    await page.goto(`${base}/member/${encodeURIComponent(username)}/items`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await page.waitForTimeout(2000);

    const finalUrl = page.url().toLowerCase();
    // If Vinted redirected to login, 404, or homepage → user doesn't exist
    if (
      finalUrl.includes('/login') ||
      finalUrl.includes('not_found') ||
      finalUrl.includes('/users/') ||
      (!finalUrl.includes('/member/') && !finalUrl.includes(clean))
    ) {
      console.log(`[vinted-lookup] @${clean} not found (redirected to ${finalUrl})`);
      return { not_found: true };
    }

    // Member page loaded — try to extract user ID from Next.js embedded state
    const pageId = await page.evaluate((clean) => {
      try {
        const nd = window.__NEXT_DATA__;
        if (nd) {
          const str = JSON.stringify(nd);
          // Find "id":12345,"login":"username" pattern
          const re = new RegExp('"id":(\\d+),"login":"' + clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i');
          const m = re.exec(str);
          if (m) return m[1];
        }
      } catch {}
      // Also scan all <script> tags for embedded user ID
      try {
        for (const s of document.querySelectorAll('script')) {
          const txt = s.textContent || '';
          if (!txt.includes(clean)) continue;
          const m = new RegExp('"id":(\\d+)[^}]*"login":"' + clean + '"', 'i').exec(txt);
          if (m) return m[1];
        }
      } catch {}
      return null;
    }, clean);

    if (pageId) {
      console.log(`[vinted-lookup] @${clean} found via page state → id ${pageId}`);
      return { id: pageId, login: username };
    }

    // Page is for this user but couldn't extract ID (e.g., 0 listings, no state embed)
    console.log(`[vinted-lookup] @${clean} page loaded but ID not extracted`);
    return { exists: true, login: username };
  } catch (e) {
    console.warn('[vinted-lookup] error:', e.message);
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}

// Fetch a public Vinted item via the browser — bypasses DataDome.
// Approach: navigate directly to the item URL (so DataDome solves naturally),
// wait for the page to render, then call /api/v2/items/{id} from inside the
// resolved page context so it carries the solved cookies + fingerprint.
// Falls back to scraping the rendered DOM if the API call still fails.
// Accepts either an item ID or a full Vinted URL. Returns { ok, data } | { error }.
async function vintedBrowserFetchItem(itemIdOrUrl) {
  if (!chromium) return { error: 'Browser unavailable' };
  let itemId = String(itemIdOrUrl || '');
  const m = itemId.match(/\/items\/(\d+)/);
  if (m) itemId = m[1];
  if (!/^\d+$/.test(itemId)) return { error: 'Invalid item id' };

  const tryBase = async (base) => {
    let page;
    try {
      const ctx = await ensureBrowser();
      page = await ctx.newPage();

      // Block heavy assets to speed up, but keep scripts (DataDome runs in JS).
      await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'media' || t === 'font') return route.abort();
        return route.continue();
      });

      const itemUrl = `${base}/items/${itemId}`;
      const resp = await page.goto(itemUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!resp) return { error: 'no response' };

      // If DataDome challenge page, wait a moment for auto-solve then reload.
      try {
        const blocked = await page.evaluate(() =>
          document.title?.toLowerCase().includes('blocked') ||
          !!document.querySelector('iframe[src*="datadome"], [id*="dd-challenge"]')
        );
        if (blocked) {
          await page.waitForTimeout(4000);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
      } catch {}

      // Small settle so any XHRs / hydration finish.
      await page.waitForTimeout(1200);

      // 1) Preferred: call the public item API from inside this page context.
      const apiData = await page.evaluate(async ({ base, id }) => {
        try {
          const r = await fetch(`${base}/api/v2/items/${id}`, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
          });
          const t = await r.text();
          try { return { ok: r.ok, status: r.status, data: JSON.parse(t) }; }
          catch { return { ok: false, status: r.status, htmlHead: t.slice(0, 200) }; }
        } catch (e) { return { error: e.message }; }
      }, { base, id: itemId });

      if (apiData?.ok && apiData.data?.item) return apiData;

      // 2) Fallback: scrape the rendered DOM — Vinted uses stable test-ids.
      const domData = await page.evaluate(() => {
        const pick = (sels) => {
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el) return (el.textContent || el.content || '').trim();
          }
          return '';
        };
        const pickAll = (sel) => Array.from(document.querySelectorAll(sel));

        const title       = pick(['[data-testid="item-page-title"]', 'h1', 'meta[property="og:title"]']);
        const description = pick(['[itemprop="description"]', '[data-testid="item-description"] *', 'meta[property="og:description"]']);
        const price       = pick(['[data-testid="item-price"]', '[itemprop="price"]', 'meta[property="product:price:amount"]']);
        const brand       = pick(['[itemprop="brand"]', '[data-testid="item-attributes-brand"] [data-testid*="value"]']);
        const size        = pick(['[data-testid="item-attributes-size"] [data-testid*="value"]', '[itemprop="size"]']);
        const condition   = pick(['[data-testid="item-attributes-status"] [data-testid*="value"]']);
        const photos      = pickAll('[data-testid^="item-photo"] img, [class*="PhotoGallery"] img').length;
        return {
          title:       title.slice(0, 200),
          description: description.slice(0, 2000),
          price,
          brand,
          size,
          condition,
          photos,
        };
      });

      if (domData?.title) {
        return { ok: true, data: { item: {
          title:       domData.title,
          description: domData.description,
          price:       domData.price ? { amount: domData.price.replace(/[^\d.]/g, '') } : undefined,
          brand:       domData.brand,
          size:        domData.size,
          status:      domData.condition,
          photos:      new Array(domData.photos || 0),
        } } };
      }

      return { ok: false, status: apiData?.status || 0, error: 'no data extractable' };
    } catch (e) {
      return { error: e.message };
    } finally {
      try { if (page) await page.close(); } catch {}
    }
  };

  // Try the locale the URL hints at first (if caller passed a URL), else .co.uk.
  let primary = 'https://www.vinted.co.uk';
  try {
    if (typeof itemIdOrUrl === 'string' && itemIdOrUrl.startsWith('http')) {
      primary = new URL(itemIdOrUrl).origin;
    }
  } catch {}
  const first = await tryBase(primary);
  if (first?.ok) return first;

  // If that base got geo-redirected / blocked, try the default .co.uk once more.
  if (primary !== 'https://www.vinted.co.uk') {
    const second = await tryBase('https://www.vinted.co.uk');
    if (second?.ok) return second;
    return second;
  }
  return first;
}

// ─── public: refresh access token ────────────────────────────────────────────
// Uses the stored refresh_token_web to silently obtain a new access token.
// Calls Vinted's oauth endpoint from inside the established browser context
// so DataDome is already solved — no residential proxy needed for this step.
// Returns { access_token, refresh_token?, expires_in } | { error }
async function refreshVintedAccessToken(refreshToken) {
  if (!chromium) return { error: 'Browser unavailable' };
  if (!refreshToken) return { error: 'No refresh token provided' };
  let page;
  let ctx;
  try {
    ctx = await isolatedContext();
    page = await ctx.newPage();
    const base = await resolveVintedBase(page);

    // Inject the refresh token as a cookie so the page context is aware of it
    const domain = '.' + new URL(base).hostname.replace(/^www\./, '');
    await ctx.addCookies([{
      name: 'refresh_token_web', value: refreshToken,
      domain, path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
    }]).catch(() => {});

    // Call the token endpoint from inside the browser (DataDome already solved,
    // correct TLS fingerprint and cookies are in place).
    const result = await page.evaluate(async ({ base, rt }) => {
      try {
        const r = await fetch(`${base}/oauth/token`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: rt,
            client_id: 'web',
            scope: 'user',
          }).toString(),
        });
        const text = await r.text();
        try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
        catch { return { ok: false, status: r.status, raw: text.slice(0, 300) }; }
      } catch (e) { return { error: e.message }; }
    }, { base, rt: refreshToken });

    if (result.error) return { error: result.error };

    if (!result.ok) {
      // If the endpoint itself returned a non-2xx, try reading the cookie —
      // some Vinted builds set access_token_web via Set-Cookie rather than body.
      const cookies = await ctx.cookies();
      const atCookie = cookies.find(c => c.name === 'access_token_web' && c.domain.includes('vinted'));
      if (atCookie?.value) {
        console.log('[vinted-refresh] Got new token from Set-Cookie fallback');
        return { access_token: atCookie.value, expires_in: 2592000 };
      }
      return { error: `Token refresh failed (${result.status}): ${result.raw || JSON.stringify(result.data)?.slice(0, 200)}` };
    }

    const newAccess = result.data?.access_token;
    if (!newAccess) return { error: 'Refresh endpoint returned no access_token' };

    console.log('[vinted-refresh] Token refreshed successfully');
    return {
      access_token:  newAccess,
      refresh_token: result.data?.refresh_token || refreshToken, // Vinted may rotate it
      expires_in:    result.data?.expires_in || 2592000,         // default 30 days
    };
  } catch (e) {
    console.error('[vinted-refresh] Error:', e.message);
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
    await closeQuietly(ctx);
  }
}

// ─── public: fast keyword search (for auto-buy polling) ──────────────────────
// Calls Vinted's catalog API from inside the established browser context —
// DataDome is already solved so this is much faster than spinning up Apify.
// Used by the 2-minute auto-buy cron to detect new listings near-instantly.
// Returns { items: Array } | { items: [], error: string }
// `order` defaults to newest_first, which every alert and feed path relies on.
// The Offer Finder passes 'relevance': fresh listings are the worst offer
// candidates, since their sellers have not yet seen the list price fail.
// svc-catalogue items no longer carry brand_title / size_title / status at the
// top level, and `url` is a relative path. They moved into item_box:
//   first_line  → brand                  ("Nike")
//   second_line → "size · condition"     ("13 years / 158 cm · Very good")
// Every caller (deal feed, niche, alerts, auto-buy, Offer Finder, /scan) reads
// the old field names, so they are restored here rather than in each caller.
// Labels follow the context locale, which is en-GB — offers.isKidSize expects
// English sizes. Existing top-level values win if Vinted ever sends them again.
// In practice the labels have come back in FRENCH even to an en-GB context
// ("13 ans / 158 cm · Neuf sans étiquette"), so both languages are recognised
// here and in offers.isKidSize.
const CONDITIONS_EN = new Set([
  'new with tags', 'new without tags', 'very good', 'good', 'satisfactory',
  'neuf avec étiquette', 'neuf sans étiquette', 'très bon état', 'bon état', 'satisfaisant',
]);

function normaliseCatalogItem(i) {
  if (!i || typeof i !== 'object') return i;
  const box = i.item_box || {};
  const parts = String(box.second_line || '').split(' · ').map(s => s.trim()).filter(Boolean);
  let size = '', condition = '';
  if (parts.length >= 2) { size = parts[0]; condition = parts[parts.length - 1]; }
  else if (parts.length === 1) {
    if (CONDITIONS_EN.has(parts[0].toLowerCase())) condition = parts[0]; else size = parts[0];
  }
  const url = i.url && !/^https?:/i.test(i.url) ? `https://www.vinted.co.uk${i.url.startsWith('/') ? '' : '/'}${i.url}` : i.url;
  return {
    ...i,
    url:         url || (i.id ? `https://www.vinted.co.uk/items/${i.id}` : ''),
    brand_title: i.brand_title || box.first_line || '',
    size_title:  i.size_title || size,
    status:      i.status || condition,
  };
}

async function vintedBrowserSearchItems(keyword, maxPrice = null, perPage = 20, order = 'newest_first') {
  if (!chromium) return { items: [], error: 'Browser unavailable' };
  let page;
  try {
    const ctx = await ensureBrowser();
    page = await ctx.newPage();
    // Strict: search has an Apify fallback, and reaching it beats reporting a
    // fabricated empty result.
    const base = await resolveVintedBase(page, true);

    const items = await page.evaluate(async ({ keyword, maxPrice, perPage, order }) => {
      const params = new URLSearchParams({
        page:        '1',
        search_text: keyword,
        order,
        per_page:    String(perPage),
        currency:    'GBP',
        country_id:  '7', // UK
      });
      if (maxPrice) params.set('price_to', String(maxPrice));
      // A blocked or failed request is reported as an error, not as an empty
      // result: callers cannot otherwise tell "Vinted blocked us" from "nothing
      // matches", and a block would look like a quiet day.
      //
      // ENDPOINT MOVED 2026-09-14 ~12:10 UTC: /api/v2/catalog/items now 404s
      // (confirmed from a normal UK browser, not only from Railway). The site's
      // own search calls api.vinted.co.uk/svc-catalogue/items, found by watching
      // the catalog page's requests. Same cookies, same query params.
      try {
        const r = await fetch(`https://api.vinted.co.uk/svc-catalogue/items?${params}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) return { error: `Vinted search returned HTTP ${r.status}` };
        const d = await r.json();
        return { items: d.items || d.item || d.data || [] };
      } catch (e) { return { error: `Vinted search request failed: ${e.message}` }; }
    }, { keyword, maxPrice, perPage, order });

    if (items?.error) return { items: [], error: items.error };
    return { items: Array.isArray(items?.items) ? items.items.map(normaliseCatalogItem) : [] };
  } catch (e) {
    return { items: [], error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}

// Pure purchase rules — availability, price ceiling. See bot/autobuy.js.
const autobuy = require('./autobuy');

// ─── public: buy item (auto-buy) ──────────────────────────────────────────────
// Attempts to purchase a Vinted item on behalf of a connected user via the
// internal Vinted transactions API, called from inside the browser context.
//
// REQUIREMENTS for success:
//   • User must have a payment method saved in their Vinted account.
//   • User must have a shipping address saved in their Vinted account.
//   • The item must still be available (not already sold).
//
// Returns { ok, transaction_id, total } | { error }
// `maxPrice` is the alert's ceiling, rechecked here against the live item —
// the search filter alone is not a spending limit.
// Returns { ok, transaction_id, status, total } | { error, skipped? } where
// `skipped: true` means the rules declined the purchase, not that it failed.
async function vintedBrowserBuyItem(accessToken, itemId, { maxPrice = null } = {}) {
  if (!chromium) return { error: 'Browser unavailable' };
  if (!accessToken) return { error: 'No access token — reconnect your Vinted account' };
  if (!itemId) return { error: 'No item ID provided' };
  const id = String(itemId);
  if (!/^\d+$/.test(id)) return { error: 'Invalid item ID' };
  let page;
  let ctx;
  try {
    ctx = await isolatedContext();
    await setAuthCookie(ctx, accessToken);
    page = await ctx.newPage();
    // Strict: a purchase must never run against a page that did not load.
    const base = await resolveVintedBase(page, true);

    // One authenticated request from inside the page (DataDome already solved).
    const api = (path, opts = {}) => page.evaluate(async ({ base, path, opts }) => {
      const r = await fetch(`${base}${path}`, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...opts,
      });
      const text = await r.text();
      try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
      catch { return { ok: false, status: r.status, raw: text.slice(0, 300) }; }
    }, { base, path, opts });

    // 1. Fetch the item and decide IN NODE with autobuy.checkBuyable, where the
    //    rules are unit tested. Availability comes from Vinted's is_closed /
    //    is_reserved / is_hidden flags — never from `status`, which is condition.
    const itemRes = await api(`/api/v2/items/${id}`);
    if (!itemRes.ok) return { error: `Item fetch failed (${itemRes.status})` };
    const item = itemRes.data?.item || itemRes.data;
    const verdict = autobuy.checkBuyable(item, { maxPrice });
    if (!verdict.ok) return { error: verdict.reason, skipped: true };

    // 2. Shipping options for this item
    const shipRes = await api(`/api/v2/items/${id}/shipping_options`);
    const shippingOptions = shipRes.data?.shipping_options || shipRes.data?.options || [];
    const shipping = shippingOptions[0]; // cheapest/first option

    // 3. Initiate the transaction
    const txPayload = {
      transaction: {
        item_id: Number(id),
        ...(shipping?.id ? { shipping_option_id: Number(shipping.id) } : {}),
      },
    };
    const txRes = await api('/api/v2/transactions', {
      method: 'POST',
      body: JSON.stringify(txPayload),
    });

    if (!txRes.ok) {
      const msg = String(txRes.data?.message || txRes.data?.error || txRes.raw || `HTTP ${txRes.status}`);
      // Surface payment-not-configured errors clearly
      if (/payment|card|wallet/i.test(msg)) {
        return { error: `Purchase failed — no payment method configured in your Vinted account. Add one in the Vinted app first. (${msg.slice(0, 100)})` };
      }
      return { error: `Purchase failed (${txRes.status}): ${msg.slice(0, 200)}` };
    }

    const tx = txRes.data?.transaction || txRes.data;
    const result = {
      ok:             true,
      transaction_id: String(tx?.id || ''),
      status:         tx?.status || 'created',
      total:          tx?.total_price?.amount ?? tx?.total_price ?? verdict.total,
    };

    return result;
  } catch (e) {
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
    await closeQuietly(ctx);
  }
}

// ─── public: fetch a seller's active listings (no token required) ────────────
// Loads the public catalog page filtered by seller_ids[] through the shared
// Playwright browser context (DataDome already solved). Intercepts the XHR
// requests Vinted's own frontend makes so we get the real item data — no Apify.
// Falls back to extracting __NEXT_DATA__ if network interception misses.
// Returns { items: Array } | { items: [], error: string }
async function vintedBrowserFetchPublicUserItems(sellerId) {
  if (!chromium) return { items: [], error: 'Browser unavailable' };
  const id = String(sellerId || '').trim();
  if (!/^\d+$/.test(id)) return { items: [], error: 'Numeric seller ID required' };

  let page;
  const capturedItems = [];

  try {
    const ctx = await ensureBrowser();
    page = await ctx.newPage();

    // Intercept API responses — capture whatever Vinted's frontend fetches
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/api/v2/')) return;
      if (!url.includes('item') && !url.includes('catalog')) return;
      try {
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const body = await response.json().catch(() => null);
        if (!body) return;
        const arr = body.items || body.data || [];
        if (Array.isArray(arr) && arr.length > 0) {
          capturedItems.push(...arr);
        }
      } catch {}
    });

    const base = await resolveVintedBase(page);
    const catalogUrl = `${base}/catalog?seller_ids[]=${id}&order=newest_first&per_page=96`;
    console.log(`[vinted-browser-items] loading catalog for seller ${id}`);

    await page.goto(catalogUrl, { waitUntil: 'networkidle', timeout: 40000 }).catch(() =>
      page.goto(catalogUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    );
    // Give any late XHRs a moment to land
    await page.waitForTimeout(3000);

    if (capturedItems.length > 0) {
      console.log(`[vinted-browser-items] network intercept: ${capturedItems.length} items for seller ${id}`);
      return { items: capturedItems };
    }

    // Fallback: pull from Next.js embedded page state
    const nextItems = await page.evaluate(() => {
      try {
        const nd = window.__NEXT_DATA__;
        if (!nd) return [];
        const p = nd.props?.pageProps;
        return (
          p?.items ||
          p?.catalogItems?.catalogItems ||
          p?.initialState?.catalog?.items ||
          p?.catalog?.items ||
          []
        );
      } catch { return []; }
    });

    if (nextItems.length > 0) {
      console.log(`[vinted-browser-items] __NEXT_DATA__: ${nextItems.length} items for seller ${id}`);
      return { items: nextItems };
    }

    console.warn(`[vinted-browser-items] no items found for seller ${id}`);
    return { items: [] };
  } catch (e) {
    console.warn('[vinted-browser-items] error:', e.message);
    return { items: [], error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}

// ─── public: a seller's wardrobe, reduced to availability (no token required) ─
// Powers the deal-feed track record. /api/v2/items/{id} 404s without a session
// for live and nonexistent items alike, so it cannot say whether a find is
// gone; the public wardrobe can (probed 2026-09-13). Sold items are absent from
// it, so `complete` matters: only a wardrobe read to its last page proves an
// item is missing rather than on a page we did not fetch.
//
// Returns { items: { [id]: { closed, reserved, hidden } }, complete } | { error }
async function vintedBrowserWardrobeStatus(sellerId, maxPages = 3) {
  if (!chromium) return { error: 'Browser unavailable' };
  const id = String(sellerId || '').trim();
  if (!/^\d+$/.test(id)) return { error: 'Numeric seller ID required' };
  let page;
  try {
    const ctx = await ensureBrowser();
    page = await ctx.newPage();
    // Strict: an unloaded page would make every item look missing, and a
    // missing item is recorded as gone. That must be an error, not a result.
    const base = await resolveVintedBase(page, true);

    return await page.evaluate(async ({ base, id, maxPages }) => {
      const items = {};
      for (let p = 1; p <= maxPages; p++) {
        let d;
        try {
          const r = await fetch(`${base}/api/v2/wardrobe/${id}/items?per_page=96&page=${p}&order=newest_first`, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
          });
          if (!r.ok) return { error: `wardrobe ${r.status}` };
          d = await r.json();
        } catch (e) {
          // A DataDome challenge comes back as HTML and lands here.
          return { error: `wardrobe unreadable: ${e.message}` };
        }
        const list = Array.isArray(d?.items) ? d.items : null;
        if (!list) return { error: 'wardrobe response had no items array' };
        for (const x of list) {
          items[String(x.id)] = { closed: !!x.is_closed, reserved: !!x.is_reserved, hidden: !!x.is_hidden };
        }
        if (list.length < 96) return { items, complete: true };
      }
      return { items, complete: false };
    }, { base, id, maxPages });
  } catch (e) {
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}

module.exports = {
  proxyUsable,
  refreshProxyProbe,
  vintedBrowserWardrobeStatus,
  vintedBrowserLogin,
  vintedBrowserLookupUser,
  vintedBrowserFetchPublicUserItems,
  vintedBrowserUploadPhoto,
  vintedBrowserCreateListing,
  vintedBrowserValidateToken,
  vintedBrowserFetchAnalytics,
  vintedBrowserFetchItem,
  refreshVintedAccessToken,
  vintedBrowserSearchItems,
  vintedBrowserStatus,
  vintedBrowserBuyItem,
  closeVintedBrowser,
};
