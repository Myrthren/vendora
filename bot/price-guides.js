'use strict';

const { marketEvidence, median, DAY, round } = require('./price-data');
const ORIGIN = 'https://vendora.site';
const TRIAL = 'https://discord.gg/ZVrDuxjQFM';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const money = value => `£${Number(value).toFixed(Number(value) % 1 ? 2 : 0)}`;
const name = value => value.replace(/\b\w/g, c => c.toUpperCase());
const eligible = e => e.fresh && e.days.length >= 7 && !e.mixed;
function londonMonday(now) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
function buildWeeklyCards(daily, now = Date.now()) {
  const monday = londonMonday(now);
  const end = Date.parse(monday) - DAY;
  const start = end - 6 * DAY;
  return marketEvidence(daily, now).flatMap(e => {
    const week = e.days.filter(d => Date.parse(d.day) >= start && Date.parse(d.day) <= end);
    if (week.length < 4) return [];
    return [{ slug: e.slug, keyword: e.keyword, week: monday,
      from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10),
      median: round(median(week.map(d => d.median))), p25: round(median(week.map(d => d.p25))),
      p75: round(median(week.map(d => d.p75))), observedDays: week.length,
      observations: week.reduce((n, d) => n + d.observations, 0) }];
  });
}
function shell({ title, description, path, content, index = true, data = null, schemas = [] }) {
  const canonical = `${ORIGIN}${path}`;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="${index ? 'index,follow' : 'noindex,follow'}">
<link rel="canonical" href="${esc(canonical)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:type" content="website"><meta property="og:image" content="${ORIGIN}/vendora-enhanced.png">
<link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/assets/price-guides.css">
${schemas.map(s => `<script type="application/ld+json">${json(s)}</script>`).join('')}</head><body>
<header><a class="brand" href="/">VENDORA<span> / VENDEX</span></a><nav aria-label="Main"><a href="/vendex">Market index</a><a href="/price-guides">Price guides</a><a href="/vendora-login">Sign in</a></nav></header>
<main>${content}</main><footer><a href="/">Vendora</a><p>Vinted UK asking prices. Independent research; Vendora is not affiliated with Vinted.</p><a href="/vendora-privacy">Privacy</a></footer>
${data ? `<script id="guide-data" type="application/json">${json(data)}</script><script src="/assets/price-guides.js" defer></script>` : ''}</body></html>`;
}
function cta() {
  return `<section class="trial"><div><p class="eyebrow">PUT THE RESEARCH TO WORK</p><h2>Find your next resale opportunity.</h2><p>Try Vendora's Pro tools in Discord for 7 days. No card needed. The trial covers Discord; the dashboard comes with a paid plan.</p></div><a class="button" href="${TRIAL}" target="_blank" rel="noopener">Start your free Discord trial ↗</a></section>`;
}
function hub(evidence) {
  const cards = evidence.filter(eligible).sort((a, b) => a.keyword.localeCompare(b.keyword));
  return shell({ title: 'UK Vinted Price Guides | Vendex by Vendora', path: '/price-guides',
    description: 'Explore Vinted UK asking-price ranges, recent movement and weekly price cards from Vendora’s collected niche data.',
    content: `<p class="eyebrow">THE ASKING-PRICE LIBRARY</p><h1>A clearer starting<br>point for your price.</h1><p class="lead">Explore the categories Vendex watches. Real collected asking prices, visible ranges and a dated view of the market.</p>
<div class="note">These are listing prices, not completed sales or a promise of what your item will sell for. Size, condition and model still matter.</div>
<div class="guide-grid">${cards.map(e => `<a class="guide-tile" href="/price-guides/${esc(e.slug)}"><p class="eyebrow">VINTED UK</p><h2>${esc(name(e.keyword))}</h2><strong>${money(e.median)}</strong><p>Middle asking range ${money(e.p25)}–${money(e.p75)}</p><p class="muted">Latest day ${esc(e.day)} · ${e.days.length} sampled days in the last month</p><span>Read price guide ↗</span></a>`).join('') || '<div class="note">We’re collecting enough recent data to publish useful guides. Each category needs at least seven sampled days and a consistent price range. Check the market index while the library builds.</div>'}</div>${cta()}` });
}
function guide(e, related, weekly) {
  const title = `${name(e.keyword)}: UK Vinted Price Guide`;
  const description = `${name(e.keyword)} Vinted UK asking prices: median ${money(e.median)}, middle range ${money(e.p25)}–${money(e.p75)}. Data dated ${e.day}; see history and sampling limits.`;
  const path = `/price-guides/${e.slug}`;
  const first = e.days[0];
  const schema = { '@context': 'https://schema.org', '@type': 'Dataset', name: title,
    description, url: ORIGIN + path, creator: { '@type': 'Organization', name: 'Vendora', url: ORIGIN },
    temporalCoverage: `${first.day}/${e.day}`, variableMeasured: 'Public Vinted UK item asking price in GBP, excluding buyer fees and postage',
    measurementTechnique: 'Filtered search samples rolled into daily medians and interquartile ranges. Repeated observations can include the same listing.' };
  const breadcrumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Price guides', item: ORIGIN + '/price-guides' },
    { '@type': 'ListItem', position: 2, name: name(e.keyword), item: ORIGIN + path } ] };
  return shell({ title: `${title} | Vendex`, description, path, index: eligible(e), schemas: [schema, breadcrumbs], data: { evidence: e, weekly },
    content: `<a class="back" href="/price-guides">← All price guides</a><p class="eyebrow">VENDEX / VINTED UK</p><h1>${esc(name(e.keyword))}<br><span>UK Vinted price guide.</span></h1><p class="lead">A dated reference for ${esc(e.keyword)} listings, built from the niche price data Vendora already collects.</p>
${!e.fresh ? '<div class="note warning">This data is older than three days. Treat it as historical context until fresh samples arrive.</div>' : ''}${e.mixed ? '<div class="note warning">This category has a wide spread and can mix different models. A single median is a weak guide for an individual item.</div>' : ''}
<section class="metrics" aria-label="Price snapshot"><div><p>Median asking price</p><strong>${money(e.median)}</strong><small>Latest sampled day · ${esc(e.day)}</small></div><div><p>Middle asking-price range</p><strong>${money(e.p25)}–${money(e.p75)}</strong><small>25th–75th percentiles, rolled up across samples</small></div><div><p>Recent weekly movement</p><strong>${e.weekChange == null ? 'Collecting' : `${e.weekChange > 0 ? '+' : ''}${e.weekChange}%`}</strong><small>${e.weekChange == null ? 'Needs at least four sampled days in each week' : 'Median of daily medians, latest 7-day window vs previous 7 days'}</small></div></section>
<section class="copy"><div><p class="eyebrow">READ THE RANGE</p><h2>Use the category as a reference.</h2><p>The latest ${esc(e.keyword)} sample day has a median of ${money(e.median)}. Its middle range is ${money(e.p25)}–${money(e.p75)}. This is a category reference; it does not isolate the exact model or condition of your item.</p><p>${e.weekChange == null ? 'There is not enough coverage in both recent weeks to report a weekly direction yet.' : `The recent weekly median ${e.weekChange > 0 ? 'rose' : e.weekChange < 0 ? 'fell' : 'was unchanged'}${e.weekChange ? ` by ${Math.abs(e.weekChange)}%` : ''}. Movement in asking prices does not establish demand or sale speed.`}</p><h3>Before choosing your listing price</h3><p>Compare the same model, size and condition on Vinted. Check photos and authenticity, then account for purchase cost and postage. A listing at the median can still remain unsold.</p></div><aside class="method"><p class="eyebrow">HOW WE MEASURE</p><h3>A visible source and its limits.</h3><p>Source: filtered public Vinted UK search listings for “${esc(e.keyword)}”. Collection is scheduled every three hours; failures can leave gaps.</p><p>${e.observations} listing observations on ${esc(e.day)}. Repeated samples may include the same listings: this is not a count of unique items.</p><p>We roll samples into one daily median and middle range. Prices exclude buyer protection and postage. They are not verified sale prices, exact valuations or net profit.</p><p>${e.days.length} sampled days in the last 30 days. No missing days are filled with invented prices.</p></aside></section>
<section class="history"><p class="eyebrow">THE RECENT RECORD</p><h2>Daily asking-price history.</h2><div class="table-wrap"><table><caption class="sr-only">Daily ${esc(e.keyword)} asking-price samples</caption><thead><tr><th scope="col">Sample day</th><th scope="col">Median</th><th scope="col">Middle range</th><th scope="col">Observations</th></tr></thead><tbody>${[...e.days].reverse().map(d => `<tr><td>${esc(d.day)}</td><td>${money(d.median)}</td><td>${money(d.p25)}–${money(d.p75)}</td><td>${d.observations}</td></tr>`).join('')}</tbody></table></div></section>
<section class="share"><div><p class="eyebrow">YOUR WEEKLY PRICE CARD</p><h2>Research worth sharing.</h2><p>${weekly ? `A fixed view of ${esc(weekly.from)}–${esc(weekly.to)}. ${weekly.observedDays} sampled days; asking prices only. Download a 1080 × 1350 PNG for X or a TikTok photo post.` : 'A weekly card will appear after at least four sampled days in the previous complete week. We do not invent a weekly result.'}</p>${weekly ? '<button class="button" id="download-card" type="button">Download weekly PNG ↓</button><p id="card-status" role="status" class="muted"></p>' : ''}</div>${weekly ? `<canvas id="weekly-card" width="1080" height="1350" role="img" aria-label="${esc(name(e.keyword))} weekly asking-price card"></canvas>` : ''}</section>
${cta()}<section><p class="eyebrow">KEEP EXPLORING</p><h2>Other price guides.</h2><div class="related">${related.filter(r => r.slug !== e.slug && eligible(r)).slice(0, 5).map(r => `<a href="/price-guides/${esc(r.slug)}">${esc(name(r.keyword))} ↗</a>`).join('')}<a href="/vendex">View the Vendex market index ↗</a></div></section>` });
}

function registerPriceGuides(app, { getSetting, saveSetting }) {
  let cached = null, expiry = 0, loading = null;
  async function evidence() {
    if (cached && Date.now() < expiry) return cached;
    if (!loading) loading = getSetting('niche_daily_v2').then(daily => {
      cached = { daily: daily || {}, evidence: marketEvidence(daily) }; expiry = Date.now() + 300000; return cached;
    }).finally(() => { loading = null; });
    return loading;
  }
  let weeklyPromise = null;
  async function updateWeeklyCards() {
    if (weeklyPromise) return weeklyPromise;
    weeklyPromise = (async () => {
      const { daily } = await evidence();
      const week = londonMonday(Date.now());
      const saved = await getSetting('vendex_weekly_cards');
      if (saved?.week === week && saved.cards?.length) return saved;
      const cards = buildWeeklyCards(daily);
      const payload = { week, cards, generatedAt: new Date().toISOString() };
      if (cards.length) await saveSetting('vendex_weekly_cards', payload);
      return payload;
    })().finally(() => { weeklyPromise = null; });
    return weeklyPromise;
  }
  const route = handler => async (req, res) => {
    try { res.set('Cache-Control', 'public, max-age=0, s-maxage=300, must-revalidate'); await handler(req, res); }
    catch (error) { console.error('[price-guides]', error.message); res.set('Cache-Control', 'no-store'); res.status(503).type('html').send(shell({ title: 'Price guides temporarily unavailable | Vendora', description: 'Please try again shortly.', path: '/price-guides', index: false, content: '<h1>The price library is taking a moment.</h1><p>We couldn’t load the collected data. Please try again shortly.</p><a href="/vendex">Visit the market index</a>' })); }
  };
  app.get('/public/price-guides', route(async (req, res) => res.type('html').send(hub((await evidence()).evidence))));
  app.get('/public/price-guides/sitemap.xml', route(async (req, res) => {
    const data = (await evidence()).evidence;
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${data.filter(eligible).map(e => `<url><loc>${ORIGIN}/price-guides/${esc(e.slug)}</loc><lastmod>${esc(e.day)}</lastmod></url>`).join('')}</urlset>`);
  }));
  app.get('/public/price-guides/:slug', route(async (req, res) => {
    const { evidence: rows } = await evidence();
    const entry = rows.find(e => e.slug === req.params.slug);
    if (!entry) return res.status(404).type('html').send(shell({ title: 'Price guide not found | Vendora', description: 'Browse the Vendex price library.', path: '/price-guides', index: false, content: '<h1>No guide for this category yet.</h1><a href="/price-guides">Browse available guides</a>' }));
    const weekly = await updateWeeklyCards();
    res.type('html').send(guide(entry, rows, weekly.cards.find(c => c.slug === entry.slug) || null));
  }));
  return { updateWeeklyCards };
}
module.exports = { registerPriceGuides, buildWeeklyCards, marketEvidence, eligible, hub, guide, londonMonday };
