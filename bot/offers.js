// ── Offer Finder ──────────────────────────────────────────────────────────────
// Listings priced AT or near market that an offer turns into a flip. The deal
// feed already catches listings that are cheap as listed; this is the other
// half — a fair-priced item where the seller would plausibly take less.
//
// Pure logic: no client, no database, no config imports — same convention as
// feeds.js and track-record.js, so the maths can be tested without a browser.
//
// It never SENDS an offer. The member sends it from the Vinted app. That keeps
// ban risk off their account and needs no private offer endpoint.
//
// VINTED FEES — probed live 2026-09-13 across 40 UK listings, every one exact:
//   service_fee (buyer protection) = £0.70 + 5% of the item price
//   total_item_price               = price + service_fee
// Note mapVintedRawItem's priceNum is total_item_price, i.e. fee-INCLUSIVE.
// Resale is estimated from the item price a seller actually receives, so this
// module reads the raw `price.amount`, not priceNum.

const BUYER_FEE_FIXED = 0.70;
const BUYER_FEE_PCT   = 5;

const DEFAULTS = {
  targetMarginPct: 25,   // profit as a % of total cost to buy
  postage:         3.00, // what the member pays for postage when buying
  sellerFeePct:    0,    // UK Vinted sellers pay no selling fee; tunable if that changes
  maxAskPct:       30,   // deepest discount worth suggesting — beyond this it is a lowball
  // Smallest discount worth calling an offer. Live 2026-09-13 the top Carhartt
  // picks were £84 offers on £84.99 listings — that is buying at list.
  minAskPct:       5,
  // p75/p25 above this and the median is a blend of different items, not a
  // price for one. Live 2026-09-13: "nike tech fleece" spread 2.54 (£11.80-£30,
  // joggers and unlabelled kids' sizes mixed with adult jackets) against
  // "carhartt detroit jacket" 1.61. It only drives a warning, so err towards it.
  mixedSpread:     2.5,
  minSample:       8,    // fewer comparables than this and the median means nothing
  maxPicks:        10,
  budget:          null, // max total cost to buy, including fee and postage
};

// Titles that match a keyword but are not the item: kids' sizes, bundles,
// faulty stock, packaging, wanted posts. They drag the median down (the Vendex
// nike-tech-fleece problem) and would be suggested as offers on the wrong thing.
const JUNK_RE = new RegExp('\\b(' + [
  'kids?', "kid's", 'child(ren)?', 'baby', 'babies', 'toddler', 'junior', 'infant',
  'boys?', 'girls?', 'years?\\s*old', '\\d{1,2}\\s*-\\s*\\d{1,2}\\s*(y|yrs?|years?)', 'age\\s*\\d{1,2}',
  'bundle', 'job\\s*lot', 'joblot', 'wholesale',
  'faulty', 'broken', 'damaged', 'for\\s*parts', 'spares', 'needs?\\s*repair',
  'box\\s*only', 'empty\\s*box', 'dust\\s*bag\\s*only', 'tags?\\s*only', 'photo\\s*only',
  'wanted', 'wtb', 'iso', 'swap', 'trade',
  'replica', 'fake', 'inspired', 'dupe',
  // Not 'patch': patch pockets and logo patches are real jackets.
  'keyring', 'keychain', 'sticker',
].join('|') + ')\\b', 'i');

const round2 = n => Math.round(n * 100) / 100;

function buyerFee(price) {
  return round2(BUYER_FEE_FIXED + price * BUYER_FEE_PCT / 100);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Nearest-rank on an already sorted array. Coarse, but it only feeds a range
// label and a warning, never the offer maths.
function percentile(sorted, q) {
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : 0;
}

function isJunk(title) {
  return JUNK_RE.test(String(title || ''));
}

// Kids' sizing from Vinted's structured size_title, which catches what titles
// miss. Probed 2026-09-13 on the 96 newest listings: "nike tech fleece" had 17
// kid-sized listings and 12 of them said nothing in the title; "stone island"
// 18 and 8. Clothing reads "13 years / 158 cm" or "3-6 months / 62 cm"; shoes
// read "12 child", "5 baby", "2 junior" or a small EU size.
// French forms too: since the 2026-09-14 search endpoint move, Vinted has been
// seen returning size labels in French ("13 ans / 158 cm") to an en-GB browser.
const KID_SIZE_RE = /\b(years?|yrs?|months?|mths?|child|children|baby|junior|infant|toddler|kids?|ans|mois|enfants?)\b|\bb[eé]b[eé]|\d\s*cm\b/i;

function isKidSize(size) {
  const s = String(size || '');
  if (!s) return false;
  if (KID_SIZE_RE.test(s)) return true;
  // EU 35 is the smallest common adult shoe size.
  const eu = /\bEU\s*(\d{2}(?:[.,]5)?)\b/i.exec(s);
  return !!eu && parseFloat(eu[1].replace(',', '.')) < 35;
}

// A listing whose brand shares no word with the search is not the item: probed
// "zara" and "druids" under stone island, "dh gate" (a replica marketplace)
// under the north face. Deliberately NOT "must equal the most common brand" —
// that dropped every "ralph lauren" listing in favour of "polo ralph lauren".
// An empty brand is unknown, not a mismatch.
const BRAND_STOP = new Set(['the', 'x', 'and', 'co', 'of', 'by']);
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !BRAND_STOP.has(w));

function brandMismatch(brand, keyword) {
  const b = words(brand);
  const k = new Set(words(keyword));
  if (!b.length || !k.size) return false;
  return !b.some(w => k.has(w));
}

// Title junk, kids' sizes, or the wrong brand — using every field Vinted gives.
function isJunkItem({ title, size, brand } = {}, keyword = '') {
  return isJunk(title) || isKidSize(size) || brandMismatch(brand, keyword);
}

// Bottoms and tops list at different prices under the same search: tech fleece
// joggers sit far below hoodies and full tracksuits, so an £8 jogger was being
// reported as 60% under a median set mostly by hoodies. Compare like with like.
const BOTTOMS_RE = /\b(joggers?|jogging\s*bottoms|bottoms|trousers|pants|shorts|leggings|sweatpants|trackies|cargos?)\b/i;

function garmentGroup(title) {
  return BOTTOMS_RE.test(String(title || '')) ? 'bottoms' : 'other';
}

// Raw /api/v2/catalog/items object → the fields this module needs.
function normalise(raw, now = Date.now()) {
  const price = parseFloat(raw?.price?.amount ?? raw?.price ?? 0) || 0;
  const id    = raw?.id ? String(raw.id) : '';
  // The main photo's upload time is the closest thing to listing age the
  // search response carries. Sellers of older listings are more open to offers.
  const ts    = raw?.photo?.high_resolution?.timestamp;
  return {
    id,
    title:      raw?.title || '',
    brand:      raw?.brand_title || '',
    size:       raw?.size_title || '',
    condition:  raw?.status || '',   // on Vinted `status` is the CONDITION, not availability
    price,
    url:        raw?.url || (id ? `https://www.vinted.co.uk/items/${id}` : ''),
    photo:      raw?.photo?.url || '',
    favourites: Number(raw?.favourite_count) || 0,
    sellerName: raw?.user?.login || '',
    ageDays:    ts ? Math.max(0, Math.floor((now / 1000 - ts) / 86400)) : null,
  };
}

// Highest offer that still clears the target margin, rounded DOWN to 50p —
// a round figure reads like a person, and rounding down never breaks the margin.
//   cost(offer) = offer + £0.70 + 5% of offer + postage
//   want        net resale >= cost × (1 + margin)
function maxOfferFor(netResale, { targetMarginPct, postage }) {
  const maxCost = netResale / (1 + targetMarginPct / 100);
  const raw = (maxCost - BUYER_FEE_FIXED - postage) / (1 + BUYER_FEE_PCT / 100);
  return raw > 0 ? Math.floor(raw * 2) / 2 : 0;
}

function acceptanceHint(askPct, ageDays) {
  // Older listings get a notch of benefit: a seller three weeks in has seen
  // the list price not work. Deliberately coarse — this is a heuristic.
  const stale = ageDays !== null && ageDays >= 14;
  if (askPct <= 12 || (askPct <= 20 && stale)) return 'likely';
  if (askPct <= 22 || (askPct <= 30 && stale)) return 'fair';
  return 'long shot';
}

function offerMessage(offer) {
  return `Hi, would you take £${offer.toFixed(offer % 1 ? 2 : 0)} for this? I can pay straight away.`;
}

function findOffers(rawItems, opts = {}, now = Date.now()) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
  const excluded = { junk: 0, noPrice: 0, alreadyUnder: 0, tooDeep: 0, overBudget: 0 };

  const all = (rawItems || []).map(r => normalise(r, now));
  const priced = all.filter(i => {
    if (!(i.price > 0) || !i.id) { excluded.noPrice++; return false; }
    if (isJunkItem(i, o.keyword)) { excluded.junk++;    return false; }
    return true;
  });

  const assumptions = {
    buyerFee:        `£${BUYER_FEE_FIXED.toFixed(2)} + ${BUYER_FEE_PCT}% of the price`,
    postage:         o.postage,
    targetMarginPct: o.targetMarginPct,
    sellerFeePct:    o.sellerFeePct,
    maxAskPct:       o.maxAskPct,
    minAskPct:       o.minAskPct,
    basis:           'Median ASKING price of comparable listings, not sold prices.',
  };

  if (priced.length < o.minSample) {
    return { median: 0, sample: priced.length, excluded, picks: [], assumptions, tooFewComparables: true };
  }

  const sortedPrices = priced.map(i => i.price).sort((a, b) => a - b);
  const med = median(sortedPrices);
  const p25 = percentile(sortedPrices, 0.25);
  const p75 = percentile(sortedPrices, 0.75);
  const mixedMarket = p25 > 0 && p75 / p25 > o.mixedSpread;
  const netResale = med * (1 - o.sellerFeePct / 100);
  const maxOffer = maxOfferFor(netResale, o);

  const picks = [];
  for (const i of priced) {
    // Listed above the market: an offer is fighting the median, not the seller.
    if (i.price > med) continue;
    if (!maxOffer) { excluded.tooDeep++; continue; }

    const askPct = Math.round((1 - maxOffer / i.price) * 100);
    // Under, at, or within a few % of the max offer as listed — that is buying
    // at list, not an offer. Includes anything already cheaper than the offer.
    if (askPct < o.minAskPct) { excluded.alreadyUnder++; continue; }
    if (askPct > o.maxAskPct) { excluded.tooDeep++; continue; }

    const cost = round2(maxOffer + buyerFee(maxOffer) + o.postage);
    if (o.budget && cost > o.budget) { excluded.overBudget++; continue; }

    const profit = round2(netResale - cost);
    picks.push({
      ...i,
      offer:      maxOffer,
      askPct,
      cost,
      profit,
      roiPct:     cost ? Math.round((profit / cost) * 100) : 0,
      chance:     acceptanceHint(askPct, i.ageDays),
      message:    offerMessage(maxOffer),
    });
  }

  // Smallest ask first: the offer most likely to be accepted. Every pick clears
  // the same target margin by construction, so ranking by ROI would be noise.
  // Older listings break ties.
  picks.sort((a, b) => a.askPct - b.askPct || (b.ageDays ?? -1) - (a.ageDays ?? -1));

  return {
    median:   round2(med),
    range:    { p25: round2(p25), p75: round2(p75) },
    mixedMarket,
    maxOffer,
    sample:   priced.length,
    excluded,
    picks:    picks.slice(0, o.maxPicks),
    matched:  picks.length,
    assumptions,
  };
}

module.exports = {
  DEFAULTS,
  buyerFee,
  isJunk,
  isKidSize,
  brandMismatch,
  isJunkItem,
  garmentGroup,
  normalise,
  maxOfferFor,
  acceptanceHint,
  findOffers,
};
