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

async function ensureBrowser() {
  if (!chromium) throw new Error('Playwright not installed');
  if (_context) return _context;
  if (_launchingPromise) return _launchingPromise;

  _launchingPromise = (async () => {
    const proxy = parseProxy(PROXY_URL);
    console.log(`[vinted-browser] launching chromium (stealth=${stealthApplied}, proxy=${!!proxy})`);
    _browser = await chromium.launch({
      headless: true,
      proxy: proxy || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });
    _context = await _browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
    });
    // Hide webdriver flag on all pages in this context
    await _context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
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

// ─── public: login ───────────────────────────────────────────────────────────
async function vintedBrowserLogin(username, password) {
  if (!chromium) return { error: 'Browser automation not available — playwright not installed.' };
  if (!username || !password) return { error: 'Username and password required.' };

  let page;
  try {
    const ctx = await ensureBrowser();
    page = await ctx.newPage();

    const base = await resolveVintedBase(page);
    console.log(`[vinted-browser-login] base=${base}`);

    // Go to login page — Vinted opens login as a modal on /
    await page.goto(`${base}/member/general/login`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
      // fallback: click login button on home
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.click('[data-testid="header--login-button"]', { timeout: 10000 }).catch(() => {});
    });

    // Dismiss any cookie banner
    await page.click('#onetrust-accept-btn-handler', { timeout: 3000 }).catch(() => {});

    // Open email/username login tab if present
    await page.click('[data-testid="auth-select-type--login"]', { timeout: 5000 }).catch(() => {});
    await page.click('text=/log in with email|email login/i', { timeout: 3000 }).catch(() => {});

    // Fill form — try both selector shapes (Vinted has rotated them)
    const userSel = 'input[name="username"], input[name="login"], input[type="email"]';
    const passSel = 'input[name="password"], input[type="password"]';
    await page.waitForSelector(userSel, { timeout: 15000 });
    await page.fill(userSel, username);
    await page.fill(passSel, password);
    await page.click('button[type="submit"], [data-testid="auth-submit"]', { timeout: 5000 });

    // Wait for either success (redirect away from /login) or error
    await page.waitForURL(u => !String(u).includes('/login') && !String(u).includes('/member/general'), { timeout: 25000 }).catch(() => {});

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
    await ctx.addCookies([{
      name: 'access_token_web',
      value: token,
      domain: '.vinted.co.uk',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }]);
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
    // Ensure the access_token_web cookie is set (idempotent)
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
  const condMap = { 'New with tags': 6, 'Like New': 2, 'Very Good': 3, 'Good': 4, 'Acceptable': 5 };
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

module.exports = {
  vintedBrowserLogin,
  vintedBrowserUploadPhoto,
  vintedBrowserCreateListing,
  vintedBrowserValidateToken,
  closeVintedBrowser,
};
