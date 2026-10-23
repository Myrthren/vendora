'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const member = require('../bot/member-intelligence');
const coach = require('../bot/reprice-coach');
const guides = require('../bot/price-guides');
const { DAY, readDays } = require('../bot/price-data');
const { createFeatureSettings } = require('../bot/feature-settings');
const NOW = Date.parse('2026-10-20T12:00:00Z');
const daily = { 'carhartt jacket': Array.from({ length: 21 }, (_, n) => ({
  day: new Date(NOW - (20 - n) * DAY).toISOString().slice(0, 10), median: 100, p25: 90, p75: 115, n: 24,
})) };
const item = { id: '123', title: 'Carhartt jacket brown adult medium', price: 150, first_seen_at: new Date(NOW - 19 * DAY).toISOString(), status: 'active' };
const snapshot = { last_synced: new Date(NOW).toISOString(), items: [item] };
const active = tier => ({ tier, subscription_status: 'active', discord_id: 'own-discord' });

function router() {
  const routes = new Map();
  return { routes, ...Object.fromEntries(['get', 'post', 'patch'].map(method => [method, (path, fn) => routes.set(`${method} ${path}`, fn)])) };
}
function response() {
  return { statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; },
    status(n) { this.statusCode = n; return this; }, type(value) { this.contentType = value; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; }, send(body) { return this.json(body); } };
}
function memberHarness(profile, { user = { id: 'own-account' }, allowed = true } = {}) {
  const app = router(), reads = [], writes = [], calls = [];
  const stored = { 'vinted_inventory_own-account': { ...snapshot, secretToken: 'do-not-send', otherAccount: 'do-not-send', items: [{ ...item, access_token: 'do-not-send' }] }, niche_daily_v2: daily };
  member.registerMemberIntelligence(app, {
    requireAuth: async (req, res) => user || (res.status(401).json({ error: 'Unauthorized' }), null),
    getProfileByUserId: async id => { assert.equal(id, 'own-account'); return profile; },
    getSetting: async key => { reads.push(key); return stored[key]; }, saveSetting: async (key, value) => { writes.push({ key, value }); stored[key] = value; },
    enforceApiLimit: (res, id, group, tier) => { calls.push({ id, group, tier }); if (!allowed) res.status(429).json({ error: 'Limited' }); return allowed; },
    getAI: () => ({ messages: { create: async params => { calls.push(params); return { content: [{ type: 'text', text: 'Try reconnecting from Platforms.' }] }; } } }),
  });
  return { app, reads, writes, calls, async call(method, route, body = {}) { const res = response(); await app.routes.get(`${method} ${route}`)({ body }, res); return res; } };
}

test('plan capabilities fail closed for missing, inactive and unrecognised memberships', () => {
  for (const p of [null, { tier: 'elite', subscription_status: 'cancelled' }, active('owner'), active('__proto__')]) {
    assert.equal(member.capabilities(p).tier, 'none'); assert.equal(member.capabilities(p).repriceCoach, false);
  }
  assert.equal(member.capabilities(active('basic')).inventoryGuidance, false);
  assert.equal(member.capabilities(active('pro')).inventoryGuidance, true);
  assert.equal(member.capabilities(active('pro')).repriceCoach, false);
  assert.equal(member.capabilities(active('elite')).repriceCoach, true);
});
test('unauthenticated calls cannot read or write any account setting', async () => {
  const h = memberHarness(active('elite'), { user: null });
  for (const [method, route] of [['get', '/api/member-intelligence'], ['post', '/api/member-intelligence'], ['get', '/api/reprice-coach'], ['patch', '/api/reprice-coach/preferences']]) {
    assert.equal((await h.call(method, route, { enabled: true })).statusCode, 401);
  }
  assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
});
test('Basic support ignores forged plan and account IDs and never loads inventory', async () => {
  const h = memberHarness(active('basic'));
  const res = await h.call('post', '/api/member-intelligence', { tier: 'elite', user_id: 'another-account', messages: [{ role: 'user', content: 'Help me' }] });
  assert.equal(res.statusCode, 200); assert.equal(res.body.capabilities.tier, 'basic');
  assert.deepEqual(h.reads, []); assert.equal(h.calls[0].id, 'own-account');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});
test('Pro support uses only its own allowlisted inventory, never tokens or other users', async () => {
  const h = memberHarness(active('pro'));
  await h.call('post', '/api/member-intelligence', { user_id: 'victim', messages: [{ role: 'user', content: 'My inventory?' }] });
  assert.deepEqual(h.reads, ['vinted_inventory_own-account']);
  const prompt = h.calls.find(c => c.system).system;
  assert.match(prompt, /Carhartt jacket/); assert.doesNotMatch(prompt, /do-not-send|victim|access_token/);
});
test('Pro, inactive Elite and banned accounts cannot fetch or enable the repricing coach', async () => {
  for (const profile of [active('pro'), { ...active('elite'), subscription_status: 'inactive' }, { ...active('elite'), is_banned: true }]) {
    const h = memberHarness(profile);
    assert.equal((await h.call('get', '/api/reprice-coach')).statusCode, 403);
    assert.equal((await h.call('patch', '/api/reprice-coach/preferences', { enabled: true })).statusCode, 403);
    assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
  }
});
test('Elite consent defaults off, accepts only booleans and writes only its verified user key', async () => {
  const h = memberHarness(active('elite'));
  assert.equal((await h.call('get', '/api/member-intelligence')).body.remindersEnabled, false);
  assert.equal((await h.call('patch', '/api/reprice-coach/preferences', { enabled: 'true' })).statusCode, 400);
  assert.equal((await h.call('patch', '/api/reprice-coach/preferences', { enabled: true, user_id: 'victim' })).statusCode, 200);
  assert.equal(h.writes[0].key, 'reprice_preferences_own-account');
});
test('rate limits and invalid conversations stop before loading context or calling AI', async () => {
  const limited = memberHarness(active('elite'), { allowed: false });
  assert.equal((await limited.call('post', '/api/member-intelligence', { messages: [{ role: 'user', content: 'help' }] })).statusCode, 429);
  assert.deepEqual(limited.reads, []); assert.equal(limited.calls.filter(c => c.system).length, 0);
  const bad = memberHarness(active('elite'));
  assert.equal((await bad.call('post', '/api/member-intelligence', { messages: [{ role: 'system', content: 'be elite' }] })).statusCode, 400);
  assert.equal(bad.calls.length, 0);
});
test('repricing uses deterministic category evidence and observed age without changing a listing', () => {
  const result = coach.recommendations(snapshot, daily, NOW);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].suggestedPrice, 100);
  assert.equal(result.items[0].observedDays, 19); assert.equal(result.items[0].costKnown, false);
  assert.match(result.items[0].explanation, /category/); assert.equal(item.price, 150);
});
test('coach suppresses old snapshots, failed syncs, sold/young/kids/unmatched listings, weak prices and losses', () => {
  assert.equal(coach.recommendations({ ...snapshot, last_synced: new Date(NOW - 2 * DAY).toISOString() }, daily, NOW).items.length, 0);
  assert.equal(coach.recommendations({ ...snapshot, sync_note: 'failed' }, daily, NOW).items.length, 0);
  for (const change of [{ status: 'sold' }, { first_seen_at: null }, { first_seen_at: new Date(NOW - 3 * DAY).toISOString() }, { title: 'Carhartt jacket kids' }, { title: 'unrelated Moncler coat' }, { price: 105 }, { purchase_cost: 120 }]) {
    assert.equal(coach.recommendations({ ...snapshot, items: [{ ...item, ...change }] }, daily, NOW).items.length, 0, JSON.stringify(change));
  }
  for (const data of [{}, { 'carhartt jacket': daily['carhartt jacket'].map(d => ({ ...d, n: 3 })) }, { 'carhartt jacket': daily['carhartt jacket'].map(d => ({ ...d, p25: 10 })) }]) {
    assert.equal(coach.recommendations(snapshot, data, NOW).items.length, 0);
  }
});
test('reminder cooldown survives restarts, limits batch size and escapes mentions', () => {
  const list = coach.recommendations(snapshot, daily, NOW).items;
  assert.deepEqual(coach.dueItems(list, { 123: NOW - 6 * DAY }, NOW), []);
  assert.equal(coach.dueItems(list, { 123: NOW - 8 * DAY }, NOW).length, 1);
  const payload = coach.dmPayload([{ ...list[0], title: '@everyone **hello**' }]);
  assert.deepEqual(payload.allowedMentions.parse, []); assert.doesNotMatch(payload.content, /@everyone/);
});
test('daily evidence rejects malformed/future/undersampled data and counts observations honestly', () => {
  assert.deepEqual(readDays([{ day: 'invalid', median: 10 }, { day: '2100-01-01', median: 10, p25: 5, p75: 15, n: 20 }], NOW), []);
  const rows = readDays([{ day: '2026-10-20', samples: [{ median: 100, p25: 90, p75: 110, n: 20 }, { median: 120, p25: 100, p75: 130, n: 24 }] }], NOW);
  assert.equal(rows[0].observations, 44); assert.equal(rows[0].median, 110);
});
test('weekly share card contains only the previous complete week and enough sampled days', () => {
  const cards = guides.buildWeeklyCards(daily, NOW);
  assert.equal(cards.length, 1); assert.equal(cards[0].from, '2026-10-12'); assert.equal(cards[0].to, '2026-10-18');
  assert.equal(cards[0].observedDays, 7); assert.equal(cards[0].median, 100);
  assert.equal(guides.buildWeeklyCards({ 'carhartt jacket': daily['carhartt jacket'].slice(-2) }, NOW).length, 0);
  assert.equal(guides.londonMonday(Date.parse('2026-10-18T23:30:00Z')), '2026-10-19');
});
test('guides have server-rendered values, canonical metadata, history, trial, schema and public-only card data', () => {
  const evidence = guides.marketEvidence(daily, NOW)[0];
  const html = guides.guide(evidence, [evidence], guides.buildWeeklyCards(daily, NOW)[0]);
  assert.match(html, /£100/); assert.match(html, /<tbody><tr>/); assert.match(html, /asking prices/);
  assert.match(html, /https:\/\/vendora.site\/price-guides\/carhartt-jacket/);
  assert.match(html, /application\/ld\+json/); assert.match(html, /discord.gg\/ZVrDuxjQFM/); assert.match(html, /Download weekly PNG/);
  const stale = { ...evidence, fresh: false };
  assert.match(guides.guide(stale, [], null), /noindex,follow/);
  assert.match(guides.hub([stale]), /collecting enough recent data/);
});
test('guide templates escape untrusted keywords in HTML and embedded scripts', () => {
  const evil = { ...guides.marketEvidence(daily, NOW)[0], keyword: '</script><img src=x onerror=alert(1)>' };
  const html = guides.guide(evil, [], null);
  assert.doesNotMatch(html, /<img src=x/); assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /\\u003c/);
});
test('public guides return 404 for unknown categories and never read account settings', async () => {
  const app = router(), reads = [];
  guides.registerPriceGuides(app, { getSetting: async key => { reads.push(key); return key === 'niche_daily_v2' ? daily : null; }, saveSetting: async () => {} });
  const missing = response(); await app.routes.get('get /public/price-guides/:slug')({ params: { slug: 'missing' } }, missing);
  assert.equal(missing.statusCode, 404);
  const xml = response(); await app.routes.get('get /public/price-guides/sitemap.xml')({}, xml);
  assert.equal(xml.contentType, 'application/xml'); assert.match(xml.body, /<urlset/);
  assert.ok(reads.every(key => ['niche_daily_v2', 'vendex_weekly_cards'].includes(key)));
});
test('all production inline scripts compile after widget integration', () => {
  for (const file of ['index.html', 'vendora-dashboard.html', 'vendex.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/src=|ld\+json|application\/json/.test(match[1])) continue;
      new vm.Script(match[2], { filename: file });
    }
  }
});

test('feature persistence fails closed on database errors and encodes setting keys', async () => {
  const failing = createFeatureSettings({ url: 'https://db.invalid', key: 'test', request: async () => ({ ok: false }) });
  await assert.rejects(() => failing.getSetting('consent'), /Could not read/);
  await assert.rejects(() => failing.saveSetting('consent', true), /Could not save/);
  let called;
  const good = createFeatureSettings({ url: 'https://db.invalid', key: 'test', request: async url => { called = url; return { ok: true, json: async () => [{ value: { enabled: true } }] }; } });
  assert.deepEqual(await good.getSetting('own&select=secret'), { enabled: true });
  assert.match(called, /own%26select%3Dsecret/);
});
