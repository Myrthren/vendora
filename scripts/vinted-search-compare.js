#!/usr/bin/env node
// Vinted search: Apify actor vs the self-hosted Playwright browser.
//
// WHY THIS EXISTS
// Auto-buy already runs on the browser path, which proves it WORKS — but auto-buy
// only ever reads item.id. It never touches brand, condition, seller or photo, so
// it proves nothing about whether the browser path is good enough for /research,
// arbitrage or flip score. This script answers the only question that matters
// before dropping the third-party actor (kazkn~vinted-smart-scraper):
//
//   for the same query, do the two paths return equivalent data?
//
// Read-only. Nothing is written to Supabase, Apify or Vinted.
//
// USAGE
//   node scripts/vinted-search-compare.js "nike tn" "stone island jumper"
//   node scripts/vinted-search-compare.js --repeat 3 "carhartt jacket"
//   node scripts/vinted-search-compare.js --json > compare.json
//
// ENV
//   APIFY_API_TOKEN     required for the Apify side (skipped without it)
//   APIFY_VINTED_ACTOR  optional, defaults to the same value bot/index.js uses
//   PROXY_URL           required for the browser side — without a residential
//                       proxy DataDome blocks the server IP and you will measure
//                       the proxy, not the scraper
//
// Needs bot/node_modules present (playwright). Run from the repo root:
//   cd bot && npm install && cd .. && node scripts/vinted-search-compare.js "nike tn"

const path = require('path');

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
let repeat = 1;
const repeatAt = argv.indexOf('--repeat');
if (repeatAt !== -1) repeat = Math.max(1, parseInt(argv[repeatAt + 1], 10) || 1);

const keywords = argv.filter((a, i) =>
  !a.startsWith('--') && !(repeatAt !== -1 && i === repeatAt + 1)
);
if (!keywords.length) {
  // A deliberate spread: high-volume generic, brand-specific, and long-tail.
  // Coverage gaps show up on the long tail, not on "nike".
  keywords.push('nike tn', 'stone island jumper', 'vintage ralph lauren fleece 1/4 zip');
}

const log = (...a) => { if (!asJson) console.log(...a); };

// ── the two paths ─────────────────────────────────────────────────────────────

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const APIFY_VINTED_ACTOR = process.env.APIFY_VINTED_ACTOR || 'kazkn~vinted-smart-scraper';

// Faithful copy of apifyRunVinted (bot/index.js ~line 515), including the
// actor/task candidate fallback — if production silently falls back to a
// different endpoint, this must reproduce that, not paper over it.
async function apifyRunVinted(input, timeoutSec = 90) {
  if (!APIFY_TOKEN) return null;
  const rawId = APIFY_VINTED_ACTOR;
  const tildeId = rawId.replace('/', '~');
  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeoutSec + 5) * 1000),
  };
  const ids = [...new Set([
    tildeId,
    tildeId.endsWith('-task') ? tildeId : `${tildeId}-task`,
    'kazkn~vinted-smart-scraper',
  ])];
  const candidates = [];
  for (const id of ids) {
    candidates.push(`https://api.apify.com/v2/acts/${id}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutSec}`);
    candidates.push(`https://api.apify.com/v2/actor-tasks/${id}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutSec}`);
  }
  for (const url of candidates) {
    try {
      const res = await fetch(url, fetchOpts);
      if (res.status === 404) continue;
      if (!res.ok) { log(`   [apify] run failed (${res.status})`); continue; }
      const data = await res.json();
      if (Array.isArray(data)) {
        if (!url.includes(tildeId)) log(`   [apify] NOTE: fell back off the configured actor id`);
        return data;
      }
    } catch (e) {
      log('   [apify] run error:', e.message);
    }
  }
  return null;
}

// ── normalisation ─────────────────────────────────────────────────────────────
// Both sides are flattened to ONE shape so the diff is about the SOURCE, not
// about each caller's mapper. fromVintedRaw below is kept deliberately in sync
// with searchVinted's direct-API mapper in bot/index.js — if that one changes,
// change this one too, or the comparison stops reflecting production.

const SYM_GBP = String.fromCharCode(163);
const SYM_EUR = String.fromCharCode(8364);
const sym = (cur) => cur === 'GBP' ? SYM_GBP : cur === 'EUR' ? SYM_EUR : (cur ? cur + ' ' : SYM_GBP);

// Actor output — copied from mapApifyVintedItem (bot/index.js ~line 564).
function fromApify(i) {
  const photo = Array.isArray(i.photos) ? (i.photos[0] || '')
    : (i.photo || i.photoUrl || i.thumbnailUrl || '');
  const cur = (i.currency || '').toUpperCase();
  const num = parseFloat(i.price ?? i.priceNumeric ?? 0) || 0;
  return {
    id:         String(i.id || i.itemId || ''),
    title:      i.title || i.name || '',
    priceNum:   num,
    price:      num ? `${sym(cur)}${num.toFixed(2)}` : '—',
    currency:   cur || 'GBP',
    url:        i.url || i.itemUrl || '',
    brand:      i.brand || i.brandTitle || '',
    condition:  i.condition || i.status || '',
    photo,
    sellerName: i.seller?.username || '',
    sellerId:   String(i.seller?.id || ''),
    createdRaw: i.createdAt || i.created_at || null,
  };
}

// Raw Vinted /api/v2/catalog/items object — what vintedBrowserSearchItems
// returns untouched.
function fromVintedRaw(i) {
  const cur = String(i.total_item_price?.currency_code || i.currency || 'GBP').toUpperCase();
  const num = parseFloat(i.total_item_price?.amount ?? i.price?.amount ?? i.price ?? 0) || 0;
  return {
    id:         String(i.id || ''),
    title:      i.title || '',
    priceNum:   num,
    price:      num ? `${sym(cur)}${num.toFixed(2)}` : '—',
    currency:   cur,
    url:        i.url || '',
    brand:      i.brand_title || i.brand?.title || '',
    condition:  i.status || '',
    photo:      i.photo?.url || i.photos?.[0]?.url || '',
    sellerName: i.user?.login || '',
    sellerId:   String(i.user?.id || ''),
    // Vinted stamps the photo upload time; it is the closest thing the catalog
    // endpoint gives to a listing age. Treated as a hint, never as truth.
    createdRaw: i.photo?.high_resolution?.timestamp || i.created_at_ts || null,
  };
}

// ── metrics ───────────────────────────────────────────────────────────────────

const FIELDS = ['id', 'title', 'priceNum', 'url', 'brand', 'condition', 'photo', 'sellerName'];

function completeness(items) {
  const out = {};
  for (const f of FIELDS) {
    const filled = items.filter(x => {
      const v = x[f];
      return f === 'priceNum' ? Number(v) > 0 : !!String(v || '').trim();
    }).length;
    out[f] = items.length ? filled / items.length : 0;
  }
  return out;
}

function medianAgeHours(items) {
  const now = Date.now();
  const ages = items
    .map(x => {
      const t = x.createdRaw;
      if (!t) return null;
      // Accept epoch seconds, epoch ms, or ISO.
      const n = Number(t);
      const ms = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(t);
      return Number.isFinite(ms) ? (now - ms) / 36e5 : null;
    })
    .filter(v => v !== null && v >= 0)
    .sort((a, b) => a - b);
  if (!ages.length) return null;
  return ages[Math.floor(ages.length / 2)];
}

const pct = (v) => v === null ? ' n/a ' : (v * 100).toFixed(0).padStart(4) + '%';

// ── run ───────────────────────────────────────────────────────────────────────

(async () => {
  let vintedBrowser = null;
  try {
    vintedBrowser = require(path.join(__dirname, '..', 'bot', 'vinted-browser.js'));
  } catch (e) {
    log('Could not load bot/vinted-browser.js:', e.message);
  }

  const browserReady = !!vintedBrowser?.vintedBrowserSearchItems;
  if (!APIFY_TOKEN) log('! APIFY_API_TOKEN not set — Apify side will be SKIPPED\n');
  if (!browserReady) log('! Playwright unavailable — browser side will be SKIPPED (cd bot && npm install)\n');
  if (!process.env.PROXY_URL && browserReady) {
    log('! PROXY_URL not set — the browser hits Vinted from this machine\'s IP.');
    log('  DataDome will likely block it, and you will be measuring the proxy, not the scraper.\n');
  }
  if (!APIFY_TOKEN && !browserReady) {
    console.error('Neither path is runnable. Set APIFY_API_TOKEN and/or install bot deps.');
    process.exit(1);
  }

  const report = [];

  for (const keyword of keywords) {
    log(`\n${'='.repeat(72)}\n"${keyword}"\n${'='.repeat(72)}`);

    const runs = { apify: [], browser: [] };

    for (let n = 0; n < repeat; n++) {
      if (APIFY_TOKEN) {
        const t0 = Date.now();
        const raw = await apifyRunVinted(
          { mode: 'SEARCH', query: keyword, countries: ['uk'], maxItems: 20, includePhotos: true },
          90
        );
        runs.apify.push({
          ms: Date.now() - t0,
          items: Array.isArray(raw) ? raw.map(fromApify) : null,
        });
      }

      if (browserReady) {
        const t0 = Date.now();
        const { items, error } = await vintedBrowser.vintedBrowserSearchItems(keyword, null, 20);
        runs.browser.push({
          ms: Date.now() - t0,
          items: error ? null : (items || []).map(fromVintedRaw),
          error,
        });
      }
    }

    // Use the first successful run for content; average the latencies.
    const pick = (arr) => arr.find(r => r.items && r.items.length) || arr[0] || null;
    const a = pick(runs.apify);
    const b = pick(runs.browser);
    const avgMs = (arr) => arr.length ? Math.round(arr.reduce((s, r) => s + r.ms, 0) / arr.length) : null;

    const aItems = a?.items || [];
    const bItems = b?.items || [];

    if (a && !a.items) log('  Apify: FAILED (no dataset returned)');
    if (b?.error)     log(`  Browser: FAILED — ${b.error}`);

    const aIds = new Set(aItems.map(x => x.id).filter(Boolean));
    const bIds = new Set(bItems.map(x => x.id).filter(Boolean));
    const shared = [...aIds].filter(id => bIds.has(id));
    const union = new Set([...aIds, ...bIds]);

    // Price agreement on shared ids — the sharpest test for a silent mapping
    // bug. Same listing, same money, or one of the mappers is wrong.
    const aById = new Map(aItems.map(x => [x.id, x]));
    const bById = new Map(bItems.map(x => [x.id, x]));
    const priceDiffs = shared
      .map(id => ({ id, a: aById.get(id).priceNum, b: bById.get(id).priceNum }))
      .filter(p => Math.abs(p.a - p.b) > 0.011);

    const ca = completeness(aItems);
    const cb = completeness(bItems);

    log(`\n  ${'metric'.padEnd(22)} ${'apify'.padStart(10)} ${'browser'.padStart(10)}`);
    log(`  ${'-'.repeat(22)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);
    log(`  ${'items returned'.padEnd(22)} ${String(aItems.length).padStart(10)} ${String(bItems.length).padStart(10)}`);
    const ms = (v) => (v === null ? '—' : `${v}ms`);
    log(`  ${`latency avg (${repeat}x)`.padEnd(22)} ${ms(avgMs(runs.apify)).padStart(10)} ${ms(avgMs(runs.browser)).padStart(10)}`);
    const ma = medianAgeHours(aItems), mb = medianAgeHours(bItems);
    log(`  ${'median age (hours)'.padEnd(22)} ${(ma === null ? 'n/a' : ma.toFixed(1)).padStart(10)} ${(mb === null ? 'n/a' : mb.toFixed(1)).padStart(10)}`);
    log(`\n  field completeness`);
    for (const f of FIELDS) {
      const flag = (ca[f] - cb[f]) > 0.25 ? '  <-- browser gap' : (cb[f] - ca[f]) > 0.25 ? '  <-- apify gap' : '';
      log(`  ${('  ' + f).padEnd(22)} ${pct(ca[f])}      ${pct(cb[f])}${flag}`);
    }
    log(`\n  overlap`);
    log(`    shared item ids       ${shared.length} of ${union.size} unique (${union.size ? (shared.length / union.size * 100).toFixed(0) : 0}% Jaccard)`);
    log(`    apify-only            ${aIds.size - shared.length}`);
    log(`    browser-only          ${bIds.size - shared.length}`);
    log(`    price disagreements   ${priceDiffs.length}${priceDiffs.length ? '  <-- MAPPING BUG, investigate' : ''}`);
    for (const p of priceDiffs.slice(0, 5)) log(`      item ${p.id}: apify ${p.a} vs browser ${p.b}`);

    report.push({
      keyword,
      apify:   { count: aItems.length, avgMs: avgMs(runs.apify),   completeness: ca, medianAgeHours: ma, failed: !!(a && !a.items) },
      browser: { count: bItems.length, avgMs: avgMs(runs.browser), completeness: cb, medianAgeHours: mb, error: b?.error || null },
      overlap: { shared: shared.length, union: union.size, apifyOnly: aIds.size - shared.length, browserOnly: bIds.size - shared.length, priceDiffs },
    });
  }

  // ── verdict ─────────────────────────────────────────────────────────────────
  if (!asJson) {
    log(`\n${'='.repeat(72)}\nVERDICT\n${'='.repeat(72)}`);

    const ok = report.filter(r => r.apify.count && r.browser.count);
    if (!ok.length) {
      log('  Inconclusive — at least one path returned nothing on every keyword.');
      log('  Check APIFY_API_TOKEN and PROXY_URL before reading anything into this.');
    } else {
      const avgJaccard = ok.reduce((s, r) => s + r.overlap.shared / r.overlap.union, 0) / ok.length;
      const anyPriceBug = report.some(r => r.overlap.priceDiffs.length);
      const gaps = FIELDS.filter(f =>
        ok.some(r => (r.apify.completeness[f] - r.browser.completeness[f]) > 0.25)
      );

      log(`  keywords compared cleanly : ${ok.length}/${report.length}`);
      log(`  mean id overlap           : ${(avgJaccard * 100).toFixed(0)}%`);
      log(`  fields where browser lags : ${gaps.length ? gaps.join(', ') : 'none'}`);
      log(`  price disagreements       : ${anyPriceBug ? 'YES — resolve before trusting either' : 'none'}`);
      log('');
      if (anyPriceBug) {
        log('  -> DO NOT MIGRATE YET. A price mismatch on the same item id means one');
        log('     mapper is wrong. Fix that first; every downstream margin calc depends on it.');
      } else if (!gaps.length && avgJaccard >= 0.6) {
        log('  -> Browser path looks equivalent. Dropping the actor is defensible:');
        log('     rewire searchVinted to vintedBrowserSearchItems + fromVintedRaw,');
        log('     keep Apify as the fallback arm, and watch latency on the 14 call sites.');
      } else if (gaps.length) {
        log(`  -> PARTIAL. The browser path does not serve: ${gaps.join(', ')}.`);
        log('     Those feed /research, arbitrage and flip score. Either source them from');
        log('     the item detail endpoint or keep the actor for the paths that need them.');
      } else {
        log('  -> Low overlap. The two paths are seeing different inventory (ordering,');
        log('     geo, or pagination). Investigate before treating them as interchangeable.');
      }
    }
    log('');
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  try { await vintedBrowser?.closeVintedBrowser?.(); } catch {}
  process.exit(0);
})();
