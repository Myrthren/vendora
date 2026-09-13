// ── Channel feed payloads ─────────────────────────────────────────────────────
// The Market category is fed from here. Pure logic and payload builders: no
// client, no database, no config imports — same shape as winback-embed.js and
// outreach.js, so a payload can be previewed and unit tested without a token.
//
// WHY A GLOBAL SOURCE: processVintedAlerts is PER USER — each person's keywords,
// DM'd to that person. Posting those into a shared channel would leak what
// individuals are hunting, be noise to everyone else, and go silent whenever
// nobody has alerts set. The feed therefore has its own owner-curated keyword
// list, searched on a schedule.

const { EmbedBuilder } = require('discord.js');
// Pure junk-title filter shared with the Offer Finder, Vendex and the niche report.
const offers = require('./offers');

const PINK = '#e8217a';
const GOLD = '#e8a121';

// The Market. IDs rather than names so a rename cannot break the feed.
const CHANNELS = {
  codes:          '1495135910159847454',
  deals:          '1474034014888394852',
  priceDrops:     '1546952769141870643',
  whatsSelling:   '1474034064531919025',
  trendReports:   '1546943978274947123',
  earlyDeals:     '1546944255036231681',
  eliteLounge:    '1546944353690198016',
};

// Elite sees a find immediately; Pro sees the same find after this delay. The
// gap is the "speed edge" the pricing page already sells, so it is a product
// value, not a technical artefact — changing it changes what Elite is worth.
const PRO_DELAY_MS = 10 * 60 * 1000;

// Keywords the feed watches. Owner-editable via the `feed_keywords` setting;
// this list is only the fallback when that setting is unset.
const DEFAULT_KEYWORDS = [
  'nike tech fleece',
  'carhartt jacket',
  'stone island',
  'the north face puffer',
  'ralph lauren jumper',
  'adidas samba',
];

// ── Underpriced detection ─────────────────────────────────────────────────────
// A feed of "new listings" is not a deal feed — it is a firehose. What makes an
// item interesting is being cheap RELATIVE TO ITS OWN SEARCH RESULTS, which is
// computable from data already in hand and costs nothing extra.
//
// The floor matters as much as the ceiling: on Vinted an item at 10% of the
// median is almost never a steal, it is a bundle listing, a photo-only post, or
// something described as faulty. Those make the feed look careless, so they are
// excluded rather than celebrated.
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

//
// PRICE BASIS (changed 2026-09-13): the ITEM price, excluding Vinted's buyer fee
// (£0.70 + 5%), and junk titles removed BEFORE the median is taken. It used to
// compare total_item_price over every result, so kids' sizes and bundles that
// matched the keyword dragged the median down — nike tech fleece read £16.45
// against a real £40-80 — and an ordinary adult listing could then look
// "underpriced". Picks come back with priceNum/price set to that item price, so
// the embed, the Pro queue and the track record all show the same figure.
//
// QUALITY (2026-09-13, after tech fleece picks at £5-£10 proved to be kids'
// sizes, joggers and likely fakes):
//   - junk is judged on size_title and brand as well as the title, via
//     offers.isJunkItem, so pass the search `keyword` for the brand check;
//   - each listing is compared with the median of its own garment group
//     (bottoms vs everything else), and not judged at all when that group has
//     too few comparables;
//   - floorPct defaults to 25: on the probe, every adult-sized listing below a
//     quarter of the going rate looked fake, damaged or misdescribed.
function pickUnderpriced(items, { minDiscountPct = 35, floorPct = 25, minSample = 6, maxPicks = 5 } = {}, keyword = '') {
  let junk = 0;
  const priced = (items || [])
    // Vinted's catalog endpoint does not always return `url` on an item. Requiring
    // it would drop every result on those runs and post nothing, with no error —
    // and an id is enough to rebuild the link, so rebuild it rather than discard.
    .filter(i => i && (i.url || i.id))
    .filter(i => {
      if (offers.isJunkItem({ title: i.title, size: i.size, brand: i.brand }, keyword)) { junk++; return false; }
      return true;
    })
    .map(i => {
      // itemPriceNum comes from mapVintedRawItem. The Apify fallback does not set
      // it, so those rare runs fall back to priceNum.
      const basis = i.itemPriceNum > 0 ? i.itemPriceNum : i.priceNum;
      return {
        ...i,
        url:      i.url || `https://www.vinted.co.uk/items/${i.id}`,
        priceNum: basis,
        price:    basis > 0 ? `£${basis.toFixed(2)}` : i.price,
      };
    })
    .filter(i => i.priceNum > 0);
  // Too few comparables and the median means nothing — better to post nothing
  // than to call a random item a bargain.
  if (priced.length < minSample) return { median: 0, picks: [], junk, sample: priced.length };

  // The overall median is still what the Market stats record: it describes the
  // category, while picks are judged within their garment group.
  const med = median(priced.map(i => i.priceNum));
  if (!med) return { median: 0, picks: [], junk, sample: priced.length };

  const groupMedian = {};
  for (const g of ['bottoms', 'other']) {
    const prices = priced.filter(i => offers.garmentGroup(i.title) === g).map(i => i.priceNum);
    groupMedian[g] = prices.length >= minSample ? median(prices) : 0;
  }

  const picks = priced
    .map(i => {
      const group = offers.garmentGroup(i.title);
      return { ...i, group, groupMedian: groupMedian[group] };
    })
    .filter(i => i.groupMedian > 0
      && i.priceNum <= i.groupMedian * (1 - minDiscountPct / 100)
      && i.priceNum >= i.groupMedian * (floorPct / 100))
    .sort((a, b) => a.priceNum - b.priceNum)
    .slice(0, maxPicks)
    .map(i => ({ ...i, discountPct: Math.round(((i.groupMedian - i.priceNum) / i.groupMedian) * 100) }));

  return { median: med, picks, junk, sample: priced.length };
}

// ── Per-keyword tuning ────────────────────────────────────────────────────────
// feed_tuning is global: { minDiscountPct, floorPct, minSample, maxPicks }. A
// category can also carry its own values under `keywords`:
//   { "floorPct": 25, "keywords": { "nike tech fleece": { "floorPct": 45 } } }
// Precedence, lowest to highest: global feed_tuning < DEFAULT_KEYWORD_TUNING <
// feed_tuning.keywords[keyword]. A code default outranks the GLOBAL value on
// purpose — a global floor change is not a statement about tech fleece — but
// the owner's explicit per-keyword value always wins, so any default here can
// be switched off from Supabase without a deploy.
const TUNING_FIELDS = ['minDiscountPct', 'floorPct', 'minSample', 'maxPicks'];

const DEFAULT_KEYWORD_TUNING = {
  // Live 2026-09-13, after kids' sizes and garment groups were handled: tech
  // fleece still posted joggers at £7-£10 against a £20 median for bottoms and a
  // hoodie at £9 against £30. On one of Vinted's most counterfeited items, that
  // far under the going rate reads as fake. 45% keeps a £10 jogger, drops £7-£9.
  'nike tech fleece': { floorPct: 45 },
};

const normKeyword = k => String(k || '').trim().toLowerCase();

// Numeric fields only; anything else (typos, strings, the `keywords` map) is
// ignored rather than passed into the maths.
function cleanTuning(t) {
  const out = {};
  for (const f of TUNING_FIELDS) {
    const v = t?.[f];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[f] = n;
  }
  return out;
}

function tuningFor(tuning, keyword) {
  const kw = normKeyword(keyword);
  const owner = {};
  for (const [k, v] of Object.entries(tuning?.keywords || {})) owner[normKeyword(k)] = v;
  return {
    ...cleanTuning(tuning),
    ...cleanTuning(DEFAULT_KEYWORD_TUNING[kw]),
    ...cleanTuning(owner[kw]),
  };
}

// First run on the filtered series. The weekly counters carry across — a count
// of finds does not depend on the price basis — but the medians do NOT: a
// series mixing fee-inclusive, unfiltered medians with the new ones would read
// as an overnight drop of several percent and fire a bogus #price-drops post.
function seedStatsFromLegacy(legacy) {
  const out = {};
  for (const [keyword, s] of Object.entries(legacy || {})) {
    out[keyword] = { medians: [], finds: s?.finds || 0, bestDiscountPct: s?.bestDiscountPct || 0 };
  }
  return out;
}

// ── Deal feed payload ─────────────────────────────────────────────────────────
// `tier` is 'elite' or 'pro' and changes only the framing. The Pro footer names
// the delay explicitly: it is the most honest upgrade prompt available, because
// the member can see for themselves that the find is still live.
function buildDealPayload({ keyword, picks, median: med, tier = 'elite' }) {
  const isElite = tier === 'elite';

  const lines = picks.map(i => {
    const title = (i.title || 'Item').slice(0, 60).replace(/[[\]]/g, '');
    const brand = i.brand ? ` · ${i.brand}` : '';
    // Each pick is measured against its own garment group, so say which median.
    const ref = i.groupMedian || med;
    const label = i.group === 'bottoms' ? 'median for bottoms' : 'median';
    return `**[${title}](${i.url})**\n${i.price} — **${i.discountPct}% under** the £${ref.toFixed(0)} ${label}${brand}`;
  });

  const embed = new EmbedBuilder()
    .setColor(isElite ? GOLD : PINK)
    .setTitle(`Underpriced now — ${keyword}`)
    .setDescription(lines.join('\n\n'))
    .addFields(
      { name: 'Median asking price', value: `£${med.toFixed(2)}`, inline: true },
      { name: 'Found',               value: `${picks.length} listing${picks.length === 1 ? '' : 's'}`, inline: true },
    )
    .setFooter({
      text: isElite
        ? 'Elite — you are seeing this first. Pro members get it in 10 minutes.'
        : 'Elite members saw this 10 minutes ago. Upgrade for first look.',
    })
    .setTimestamp();

  if (picks[0]?.photo) embed.setThumbnail(picks[0].photo);

  return { embeds: [embed] };
}

// ── Weekly "what's selling" payload ───────────────────────────────────────────
// The only free-tier channel in the category, so it has to stand on its own for
// someone who has never paid: movement, not individual listings. Deliberately
// carries no live URLs — those are what Pro and Elite are paying for.
function buildWhatsSellingPayload({ rows, days = 7 }) {
  const ranked = [...rows].sort((a, b) => b.finds - a.finds).slice(0, 6);

  const lines = ranked.map((r, n) => {
    const arrow = r.medianChangePct > 0 ? '↑' : r.medianChangePct < 0 ? '↓' : '→';
    const move  = r.medianChangePct === 0
      ? 'flat'
      : `${arrow} ${Math.abs(r.medianChangePct)}%`;
    return `**${n + 1}. ${r.keyword}** — median £${r.median.toFixed(0)}, ${move} this week · ${r.finds} underpriced find${r.finds === 1 ? '' : 's'}`;
  });

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle(`What moved this week`)
    .setDescription(
      `Median asking prices across the categories Vendora watches, and how many ` +
      `genuinely underpriced listings turned up in each over the last ${days} days.\n\n` +
      lines.join('\n')
    )
    .setFooter({ text: 'Live finds as they happen go to #deals — Pro and above.' })
    .setTimestamp();

  return { embeds: [embed] };
}

// ── Price drops ───────────────────────────────────────────────────────────────
// Category-level, not per-listing. The watchlist is per user — piping it into a
// shared channel would leak what individuals are tracking and be noise to
// everyone else. A drop in the GOING RATE for a category is the signal that is
// both global and actionable: it says "this is a buying window", which is a
// different and more useful thing than "one listing got cheaper".
function detectPriceDrops(stats, { minDropPct = 8, recentMs = 24 * 60 * 60 * 1000, baselineMs = 72 * 60 * 60 * 1000, minSamples = 6 } = {}) {
  const now = Date.now();
  const drops = [];

  for (const [keyword, s] of Object.entries(stats || {})) {
    const pts = s.medians || [];
    if (pts.length < minSamples) continue;

    const recent   = pts.filter(p => p.t > now - recentMs);
    const baseline = pts.filter(p => p.t <= now - recentMs && p.t > now - baselineMs);
    if (recent.length < 2 || baseline.length < 2) continue;

    const avg = arr => arr.reduce((t, p) => t + p.median, 0) / arr.length;
    const nowAvg  = avg(recent);
    const baseAvg = avg(baseline);
    if (!baseAvg) continue;

    const dropPct = ((baseAvg - nowAvg) / baseAvg) * 100;
    if (dropPct >= minDropPct) {
      drops.push({ keyword, from: baseAvg, to: nowAvg, dropPct: Math.round(dropPct) });
    }
  }

  return drops.sort((a, b) => b.dropPct - a.dropPct);
}

function buildPriceDropPayload({ drops }) {
  const lines = drops.map(d =>
    `**${d.keyword}** — £${d.from.toFixed(0)} → **£${d.to.toFixed(0)}** (down ${d.dropPct}%)`
  );

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle('Going rate dropped')
    .setDescription(
      `The median asking price in these categories has fallen over the last day ` +
      `against the three days before it. Cheaper to buy into, harder to sell out of — ` +
      `worth sourcing now, worth holding listings back.\n\n` +
      lines.join('\n')
    )
    .setFooter({ text: 'Category rates, measured every hour. Your own item alerts stay in your DMs.' })
    .setTimestamp();

  return { embeds: [embed] };
}

// ── Weekly trend report (Pro) ─────────────────────────────────────────────────
// The paid depth behind #whats-selling: same underlying data, but every category
// rather than the top six, with the 14-day direction and the week's best find.
function buildTrendReportPayload({ rows, days = 7 }) {
  const sorted = [...rows].sort((a, b) => b.finds - a.finds);

  const lines = sorted.map(r => {
    // "→ 0%" next to a "from → to" price line reads as an arrow to a value, so
    // a flat category says so in words instead.
    const move = r.medianChangePct === 0
      ? 'flat'
      : `${r.medianChangePct > 0 ? '↑' : '↓'} ${Math.abs(r.medianChangePct)}%`;
    const best = r.bestDiscountPct ? ` · best find **${r.bestDiscountPct}% under**` : '';
    return `**${r.keyword}** — £${r.median.toFixed(0)} ${move} · ${r.finds} find${r.finds === 1 ? '' : 's'}${best}`;
  });

  const totalFinds = rows.reduce((t, r) => t + r.finds, 0);

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle(`Weekly trend report`)
    .setDescription(
      `Every category Vendora watched over the last ${days} days — median asking ` +
      `price, direction, and how many genuinely underpriced listings appeared.\n\n` +
      lines.join('\n')
    )
    .addFields(
      { name: 'Categories tracked', value: String(rows.length), inline: true },
      { name: 'Underpriced finds',  value: String(totalFinds),  inline: true },
    )
    .setFooter({ text: 'Rising median = sell into it. Falling median = source into it.' })
    .setTimestamp();

  return { embeds: [embed] };
}

module.exports = {
  CHANNELS,
  PRO_DELAY_MS,
  DEFAULT_KEYWORDS,
  median,
  pickUnderpriced,
  tuningFor,
  seedStatsFromLegacy,
  buildDealPayload,
  buildWhatsSellingPayload,
  detectPriceDrops,
  buildPriceDropPayload,
  buildTrendReportPayload,
};
