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
  return { browser, context };
}

async function ensureBrowser() {
  if (!chromium) throw new Error('Playwright not installed');
  if (_context) return _context;
  if (_launchingPromise) return _launchingPromise;

  _launchingPromise = (async () => {
    const { browser, context } = await launchBrowser(true);
    _browser  = browser;
    _context  = context;
    _proxySkipped = false;
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

// Resolve the right domain (proxy may redirect .co.uk → .fr etc.)
async function resolveVintedBase(page) {
  try {
    await page.goto('https://www.vinted.co.uk/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    return new URL(page.url()).origin;
  } catch (e) {
    if (e.message.includes('ERR_TUNNEL_CONNECTION_FAILED') || e.message.includes('ERR_PROXY_CONNECTION_FAILED')) {
      throw new Error('PROXY_TUNNEL_FAILED:' + e.message);
    }
    console.warn('[vinted-browser] base resolve failed:', e.message);
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
  try {
    let ctx;
    try {
      ctx = await ensureBrowser();
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
        page = await c2.newPage();
        base = await resolveVintedBase(page).catch(() => 'https://www.vinted.co.uk');
        console.warn('[vinted-browser-login] Running WITHOUT proxy — DataDome may block login from this IP. Fix: set PROXY_URL to a residential proxy that supports HTTPS on port 443.');
      } else {
        throw e;
      }
    }
    console.log(`[vinted-browser-login] base=${base} (proxy_skipped=${_proxySkipped})`);

    // ── Navigate to login page ───────────────────────────────────────────────
    // Try the direct login URL first; fall back to clicking the header button
    const loginUrls = [
      `${base}/login`,
      `${base}/member/general/login`,
    ];
    let landed = false;
    for (const url of loginUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        landed = true;
        break;
      } catch {}
    }
    if (!landed) {
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.click('[data-testid="header--login-button"]', { timeout: 10000 }).catch(() => {});
    }

    // ── Dismiss cookie banner ────────────────────────────────────────────────
    await page.click('#onetrust-accept-btn-handler', { timeout: 4000 }).catch(() => {});
    await page.click('[data-testid="cookie-banner-accept"]', { timeout: 2000 }).catch(() => {});

    // ── Check for DataDome block immediately after landing ───────────────────
    const blockedEarly = await page.evaluate(() =>
      document.title?.toLowerCase().includes('blocked') ||
      !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="datadome"], [id*="dd-challenge"]')
    ).catch(() => false);
    if (blockedEarly) {
      return { error: 'Vinted is blocking this server\'s IP (DataDome). A residential proxy is required. Set PROXY_URL on Railway to a UK residential proxy, e.g. http://user:pass@host:443' };
    }

    // ── Open email login tab if Vinted is showing a provider-select screen ───
    // Vinted sometimes shows "Log in with Facebook / Google / Email" tabs.
    await page.click('[data-testid="auth-select-type--login"]', { timeout: 4000 }).catch(() => {});
    // Click "Log in with email" button/link if present
    for (const sel of [
      'button:has-text("Log in with email")',
      'button:has-text("Email")',
      'a:has-text("Log in with email")',
      '[data-testid="auth-login-with-email"]',
    ]) {
      const hit = await page.$(sel);
      if (hit) { await hit.click(); break; }
    }

    // ── Wait for the credential form ─────────────────────────────────────────
    // Vinted has used many different attribute shapes — try all known ones.
    // Also handle the case where they embed the form inside a dialog/modal.
    const USER_SELS = [
      'input[name="username"]',
      'input[name="login"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
      '[data-testid="username_or_email-input"] input',
      '[data-testid="email-input"] input',
      'form input[type="text"]:first-of-type',
    ];
    const PASS_SELS = [
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      '[data-testid="password-input"] input',
    ];

    // Wait up to 20s for any password field — it's the most distinctive
    let passField = null;
    for (let attempt = 0; attempt < 40 && !passField; attempt++) {
      for (const sel of PASS_SELS) {
        passField = await page.$(sel);
        if (passField) break;
      }
      if (!passField) await page.waitForTimeout(500);
    }
    if (!passField) {
      // Snapshot the page title to help diagnose
      const title = await page.title().catch(() => '?');
      return { error: `Vinted login form not found (page: "${title}"). Vinted may have changed their login UI — this usually means DataDome served a different page, or the selectors need updating.` };
    }

    // Find the username/email field — try each selector, pick the first visible one
    let userField = null;
    for (const sel of USER_SELS) {
      userField = await page.$(sel);
      if (userField) break;
    }
    if (!userField) {
      return { error: 'Vinted login username field not found — login UI may have changed.' };
    }

    await userField.fill(username);
    await passField.fill(password);

    // ── Submit ────────────────────────────────────────────────────────────────
    const SUBMIT_SELS = [
      'button[type="submit"]',
      '[data-testid="auth-submit"]',
      '[data-testid="submit-button"]',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'form button',
    ];
    let submitted = false;
    for (const sel of SUBMIT_SELS) {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); submitted = true; break; }
    }
    if (!submitted) return { error: 'Could not find Vinted login submit button.' };

    // ── Wait for redirect out of login pages ─────────────────────────────────
    await page.waitForURL(
      u => !String(u).includes('/login') && !String(u).includes('/member/general'),
      { timeout: 25000 }
    ).catch(() => {});

    // If DataDome captcha appeared in an iframe, fail — user needs to switch proxy country
    const captcha = await page.$('iframe[src*="captcha-delivery"], iframe[src*="datadome"]');
    if (captcha) {
      return { error: 'Vinted captcha challenge appeared — proxy IP is flagged. Try a different proxy region.' };
    }

    // Pull auth cookies
    const authToken = await cookieValue(ctx, 'access_token_web') ||
                      await cookieValue(ctx, '_vinted_fr_session');
    // The real API bearer lives in access_token_web cookie
    const refreshToken = await cookieValue(ctx, 'refresh_token_web');

    if (!authToken) {
      return { error: 'Vinted login did not produce an access token — check credentials or try again.' };
    }

    // Fetch /api/v2/users/me from inside the page to confirm + grab username
    const me = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v2/users/me', { credentials: 'include', headers: { 'Accept': 'application/json' } });
        if (!r.ok) return { ok: false, status: r.status };
        return { ok: true, data: await r.json() };
      } catch (e) { return { ok: false, error: e.message }; }
    });

    const u = me?.data?.user || me?.data || {};
    return {
      access_token:      authToken,
      refresh_token:     refreshToken || '',
      platform_user_id:  String(u.id || ''),
      platform_username: u.login || u.username || username,
    };
  } catch (e) {
    console.error('[vinted-browser-login] error:', e);
    return { error: e.message || 'Browser login failed' };
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}

// ─── public: validate token ──────────────────────────────────────────────────
// Injects the provided token as an access_token_web cookie and hits /users/me.
async function vintedBrowserValidateToken(token) {
  if (!chromium) return { valid: null, warning: 'Browser unavailable — token saved unvalidated.' };
  let page;
  try {
    const ctx = await ensureBrowser();
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
  }
}

// ─── public: upload photo ────────────────────────────────────────────────────
async function vintedBrowserUploadPhoto(accessToken, base64, mimeType = 'image/jpeg') {
  if (!chromium) return { error: 'Browser unavailable' };
  let page;
  try {
    const ctx = await ensureBrowser();
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
  try {
    const ctx = await ensureBrowser();
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
  }
}

// ─── public: fetch analytics ─────────────────────────────────────────────────
// Uses the stored access_token to pull profile stats + active listings from
// Vinted's API from inside the browser context (bypasses DataDome).
// Returns { meRes, itemsRes } where both are { ok, status, data } objects.
async function vintedBrowserFetchAnalytics(accessToken, userId) {
  if (!chromium) return { error: 'Browser unavailable' };
  let page;
  try {
    const ctx = await ensureBrowser();

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
  try {
    const ctx = await ensureBrowser();
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
        const r = await fetch(`${base}/api/v2/oauth/token`, {
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
  }
}

// ─── public: fast keyword search (for auto-buy polling) ──────────────────────
// Calls Vinted's catalog API from inside the established browser context —
// DataDome is already solved so this is much faster than spinning up Apify.
// Used by the 2-minute auto-buy cron to detect new listings near-instantly.
// Returns { items: Array } | { items: [], error: string }
async function vintedBrowserSearchItems(keyword, maxPrice = null, perPage = 20) {
  if (!chromium) return { items: [], error: 'Browser unavailable' };
  let page;
  try {
    const ctx = await ensureBrowser();
    page = await ctx.newPage();
    const base = await resolveVintedBase(page);

    const items = await page.evaluate(async ({ base, keyword, maxPrice, perPage }) => {
      const params = new URLSearchParams({
        search_text: keyword,
        order:       'newest_first',
        per_page:    String(perPage),
        currency:    'GBP',
        country_id:  '7', // UK
      });
      if (maxPrice) params.set('price_to', String(maxPrice));
      try {
        const r = await fetch(`${base}/api/v2/catalog/items?${params}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) return [];
        const d = await r.json();
        return d.items || d.item || d.data || [];
      } catch { return []; }
    }, { base, keyword, maxPrice, perPage });

    return { items: Array.isArray(items) ? items : [] };
  } catch (e) {
    return { items: [], error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}

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
async function vintedBrowserBuyItem(accessToken, itemId) {
  if (!chromium) return { error: 'Browser unavailable' };
  if (!accessToken) return { error: 'No access token — reconnect your Vinted account' };
  if (!itemId) return { error: 'No item ID provided' };
  let page;
  try {
    const ctx = await ensureBrowser();
    await setAuthCookie(ctx, accessToken);
    page = await ctx.newPage();
    const base = await resolveVintedBase(page);

    const result = await page.evaluate(async ({ base, itemId }) => {
      async function api(path, opts = {}) {
        const r = await fetch(`${base}${path}`, {
          credentials: 'include',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          ...opts,
        });
        const text = await r.text();
        try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
        catch { return { ok: false, status: r.status, raw: text.slice(0, 300) }; }
      }

      // 1. Verify item is still available
      const itemRes = await api(`/api/v2/items/${itemId}`);
      if (!itemRes.ok) return { error: `Item fetch failed (${itemRes.status})` };
      const item = itemRes.data?.item || itemRes.data;
      if (!item) return { error: 'Item data not found in response' };
      // Vinted uses status = 'available' (string) or status_id = 1 (int)
      const avail = item.status === 'available' || item.status === 1 || item.status_id === 1;
      if (!avail) return { error: `Item is no longer available (status: ${item.status})` };

      // 2. Get shipping options for this item
      const shipRes = await api(`/api/v2/items/${itemId}/shipping_options`);
      const shippingOptions = shipRes.data?.shipping_options || shipRes.data?.options || [];
      const shipping = shippingOptions[0]; // cheapest/first option

      // 3. Initiate the transaction
      const txPayload = {
        transaction: {
          item_id: Number(itemId),
          ...(shipping?.id ? { shipping_option_id: Number(shipping.id) } : {}),
        },
      };
      const txRes = await api('/api/v2/transactions', {
        method: 'POST',
        body: JSON.stringify(txPayload),
      });

      if (!txRes.ok) {
        const msg = txRes.data?.message || txRes.data?.error || txRes.raw || `HTTP ${txRes.status}`;
        // Surface payment-not-configured errors clearly
        if (/payment|card|wallet/i.test(msg)) {
          return { error: `Purchase failed — no payment method configured in your Vinted account. Add one in the Vinted app first. (${msg.slice(0, 100)})` };
        }
        return { error: `Purchase failed (${txRes.status}): ${msg.slice(0, 200)}` };
      }

      const tx = txRes.data?.transaction || txRes.data;
      return {
        ok:             true,
        transaction_id: String(tx?.id || ''),
        status:         tx?.status || 'created',
        total:          tx?.total_price || item.price?.amount || '?',
      };
    }, { base, itemId: String(itemId) });

    return result;
  } catch (e) {
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch {}
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

module.exports = {
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
  vintedBrowserBuyItem,
  closeVintedBrowser,
};
