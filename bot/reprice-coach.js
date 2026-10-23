'use strict';

const { DAY, marketEvidence } = require('./price-data');
const { isJunkItem } = require('./offers');
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const money = n => `£${n.toFixed(n % 1 ? 2 : 0)}`;

function recommendations(snapshot, daily, now = Date.now()) {
  const synced = Date.parse(snapshot?.last_synced);
  if (!Number.isFinite(synced) || synced > now || now - synced > 36 * 3600000 || snapshot.sync_note) {
    return { items: [], reason: 'Sync your Vinted inventory before asking for a repricing review.' };
  }
  const evidence = marketEvidence(daily, now).filter(e => e.fresh && !e.mixed);
  const items = [];
  for (const item of snapshot.items || []) {
    const first = Date.parse(item.first_seen_at);
    const age = Math.floor((now - first) / DAY);
    const price = Number(item.price);
    if (!item.id || (item.currency && item.currency !== 'GBP') || (item.status || 'active') !== 'active' || !Number.isFinite(first) || age < 14 ||
      !(price > 0) || isJunkItem({ title: item.title, brand: item.brand, size: item.size }, '')) continue;
    const titleWords = new Set(words(item.title));
    const match = evidence.filter(e => words(e.keyword).length >= 2 && words(e.keyword).every(w => titleWords.has(w)))
      .sort((a, b) => words(b.keyword).length - words(a.keyword).length)[0];
    if (!match || price <= match.p75 * 1.1) continue;
    const suggestion = Math.floor(match.median);
    const costValue = item.purchase_cost ?? item.cost_price;
    const cost = costValue == null ? null : Number(costValue);
    if (!(suggestion > 0) || suggestion >= price || (Number.isFinite(cost) && suggestion <= cost)) continue;
    items.push({ id: String(item.id), title: String(item.title || '').slice(0, 160), currentPrice: price,
      suggestedPrice: suggestion, observedDays: age, keyword: match.keyword, rangeLow: match.p25,
      rangeHigh: match.p75, evidenceDay: match.day, observations: match.observations,
      // Only link to a numeric Vinted item ID, never an untrusted inventory URL.
      url: /^\d+$/.test(String(item.id)) ? `https://www.vinted.co.uk/items/${item.id}` : null,
      costKnown: Number.isFinite(cost),
      explanation: `Observed in your synced wardrobe for ${age} days. The ${match.keyword} category's middle asking-price range is ${money(match.p25)}–${money(match.p75)}. Consider ${money(suggestion)} after checking the exact model, size, condition and your costs.` });
  }
  return { items: items.sort((a, b) => b.observedDays - a.observedDays).slice(0, 12),
    reason: items.length ? null : 'No reliable repricing suggestions right now. We need an active listing observed for at least 14 days, a matching category and fresh, reasonably consistent price data.' };
}

function dmPayload(items) {
  return { content: '**Your Vendora repricing check**\n\n' + items.slice(0, 3).map(i =>
    `**${i.title.replace(/[*_~`<>@]/g, '').slice(0, 100)}** · asking ${money(i.currentPrice)}\n${i.explanation}${i.url ? `\n${i.url}` : ''}`
  ).join('\n\n') + '\n\nCategory asking prices, not completed sales. Nothing has been changed. Review your coach or turn reminders off at https://vendora.site/vendora-dashboard#intelligence.',
    allowedMentions: { parse: [] } };
}

// Durable per-listing cooldown survives bot restarts; plan/consent are checked by caller.
function dueItems(items, sent = {}, now = Date.now()) {
  return items.filter(i => !sent[i.id] || now - Number(sent[i.id]) >= 7 * DAY).slice(0, 3);
}

module.exports = { recommendations, dueItems, dmPayload };
