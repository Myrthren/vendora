// ── Auto-buy decisions ────────────────────────────────────────────────────────
// Everything that decides whether auto-buy spends a member's money. Pure: no
// client, no database, no browser — so every rule below is unit tested rather
// than trusted.
//
// WHY THIS EXISTS (2026-09-13): the old availability check was
//   item.status === 'available' || item.status === 1 || item.status_id === 1
// but on Vinted `status` is the item's CONDITION ("Good", "Very good" — probed
// live) and status_id is the condition id, where 1 = "New without tags"
// (index.js listing code). So it refused nearly every item as unavailable and
// only let new-without-tags items through. Fixing it switches real purchases on,
// which exposed four holes that were harmless only while nothing was bought:
//   1. an alert with an empty seen_ids treated every CURRENT listing as new;
//   2. max_price was only a search filter, never rechecked on the item, and an
//      alert with no max_price would buy at any price;
//   3. junk titles (kids' sizes, bundles, box only) matching the keyword;
//   4. no spend cap — up to 3 purchases per alert per 2-minute run.
// Each is closed here.

const offers = require('./offers');

const DAY = 24 * 60 * 60 * 1000;

// Owner-tunable via the `autobuy_tuning` setting — no deploy needed.
//   enabled   — master switch for PURCHASING. Alerts keep working when false.
//   dailyCap  — successful purchases per member per rolling 24 hours.
//   maxPerRun — new listings considered per alert per 2-minute run.
const DEFAULT_TUNING = { enabled: true, dailyCap: 3, maxPerRun: 3 };

// Vinted's real availability flags, as seen on wardrobe items (probed live).
const STATE_FLAGS = [
  ['is_closed',     'sold or closed'],
  ['is_reserved',   'reserved for another buyer'],
  ['is_hidden',     'hidden by the seller'],
  ['is_draft',      'still a draft'],
  ['is_processing', 'still processing on Vinted'],
];

const round2 = n => Math.round(n * 100) / 100;
const num = v => {
  const n = parseFloat(v && typeof v === 'object' ? v.amount : v);
  return Number.isFinite(n) ? n : 0;
};

// What the member pays before postage. Vinted's own total when it sends one,
// otherwise price + buyer fee (£0.70 + 5%, probed exact — see offers.js).
// Compared against max_price because that is what the alert cron already
// compares (mapVintedRawItem.priceNum is total_item_price): the ceiling means
// the same thing for alerts and purchases.
function itemTotal(item) {
  const total = num(item?.total_item_price);
  if (total > 0) return round2(total);
  const price = num(item?.price);
  return price > 0 ? round2(price + offers.buyerFee(price)) : 0;
}

// The check made on the item JUST BEFORE purchase, from Vinted's item endpoint.
// Fails closed: if the response carries none of the availability flags, the
// answer is "not proven available", never "probably fine".
function checkBuyable(item, { maxPrice } = {}) {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'Vinted returned no item data' };

  const flagsPresent = STATE_FLAGS.some(([f]) => typeof item[f] === 'boolean')
    || typeof item.transaction_permitted === 'boolean'
    || typeof item.can_buy === 'boolean';
  if (!flagsPresent) {
    return { ok: false, reason: 'Vinted did not say whether the item is available, so it was not bought' };
  }

  for (const [flag, why] of STATE_FLAGS) {
    if (item[flag] === true) return { ok: false, reason: `Item is ${why}` };
  }
  if (item.transaction_permitted === false || item.can_buy === false) {
    return { ok: false, reason: 'Vinted is not accepting purchases on this item' };
  }

  const price = num(item.price);
  if (!(price > 0)) return { ok: false, reason: 'Item has no readable price' };

  const max = Number(maxPrice);
  if (!(max > 0)) return { ok: false, reason: 'This alert has no max price, and auto-buy needs one' };

  const total = itemTotal(item);
  if (total > max) {
    return { ok: false, reason: `£${total.toFixed(2)} including Vinted's buyer fee is over the £${max.toFixed(2)} limit` };
  }
  return { ok: true, price: round2(price), total };
}

// Decide one alert's run from the search results, before any browser purchase.
// Returns which new listings to attempt, which to alert on only (with why),
// and the seen_ids to store.
function planAlertRun(alert, items, { purchasesLast24h = 0, tuning = {} } = {}) {
  const t = { ...DEFAULT_TUNING, ...tuning };
  const list = Array.isArray(items) ? items : [];
  const seen = new Set((alert?.seen_ids || []).map(String));
  const ids = list.map(i => String(i?.id || '')).filter(Boolean);

  // No baseline means we cannot tell new listings from ones that were already
  // up. Record what is there now and buy nothing this run.
  if (!seen.size) {
    return { baseline: true, considered: [], toBuy: [], notBuying: [], seenIds: [...new Set(ids)].slice(-500) };
  }

  const fresh = list.filter(i => i?.id && !seen.has(String(i.id)));
  const considered = fresh.slice(0, t.maxPerRun);
  const toBuy = [];
  const notBuying = [];
  let remaining = Math.max(0, t.dailyCap - purchasesLast24h);

  for (const item of considered) {
    let reason = null;
    if (!t.enabled)                           reason = 'Auto-buy purchasing is paused right now';
    else if (!(Number(alert.max_price) > 0))  reason = 'Set a max price on this alert to let auto-buy purchase';
    else if (offers.isJunk(item.title))       reason = "The title looks like kids' sizes, a bundle, faulty stock or not the item itself";
    else if (remaining <= 0)                  reason = `Daily auto-buy limit reached (${t.dailyCap} purchases in 24 hours)`;

    if (reason) notBuying.push({ item, reason });
    else { toBuy.push(item); remaining--; }
  }

  return {
    baseline: false,
    considered,
    toBuy,
    notBuying,
    seenIds: [...new Set([...seen, ...ids])].slice(-500),
  };
}

// Purchase log: { [discordId]: [timestamp, ...] }, kept 7 days.
function countRecent(log, discordId, now = Date.now()) {
  return ((log || {})[discordId] || []).filter(t => t > now - DAY).length;
}

function withPurchase(log, discordId, now = Date.now()) {
  const out = { ...(log || {}) };
  out[discordId] = [...(out[discordId] || []), now].filter(t => t > now - 7 * DAY);
  return out;
}

module.exports = {
  DEFAULT_TUNING,
  itemTotal,
  checkBuyable,
  planAlertRun,
  countRecent,
  withPurchase,
};
