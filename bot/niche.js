// ── Monthly niche report ──────────────────────────────────────────────────────
// A 30-day read on the niches Vendora watches: which are rising (sell into
// them), falling (source into them), steady, or too noisy to trust — with a
// buy-under price for Elite.
//
// Pure logic and payload builders: no client, no database, no config imports,
// same convention as feeds.js / track-record.js / offers.js. The report object
// built here is stored as a draft, the owner previews it, and `post` publishes
// that exact stored object — so what was approved is what members see.
//
// DIVISION OF LABOUR: every number is computed here, in code. Claude only
// writes a short note per niche and a two-sentence summary, and any note that
// contains a digit, £ or % is thrown away and replaced with a code-written one.
// An AI-invented price in a paid channel is the failure this design exists to
// make impossible.
//
// DATA: a 3-hourly sweep searches each report keyword (48 newest listings),
// drops junk titles with the Offer Finder's filter, and records the median
// ITEM price (fee-exclusive, see offers.js) plus p25/p75. Samples roll up into
// one entry per day, kept 90 days. The feed's own hourly medians are not used:
// they are fee-inclusive, unfiltered, and only kept 14 days.

const { EmbedBuilder } = require('discord.js');
const offers = require('./offers');

const PINK = '#e8217a';
const GOLD = '#e8a121';
const DAY = 24 * 60 * 60 * 1000;

const KEEP_DAYS     = 90;
const SAMPLE_MIN_N  = 8;    // fewer usable listings than this and a sample is noise
const MIN_DAYS      = 21;   // days of data a niche needs inside the window to be reported
const MIN_KEYWORDS  = 5;    // a "niche report" on fewer niches than this is not one
const MOVE_PCT      = 8;    // |30-day change| at or above this is a direction, below is steady
const VOLATILE_PCT  = 25;   // day-to-day coefficient of variation above this = handle with care
// p75/p25 above this = the search blends different items. Deliberately higher
// than the Offer Finder's 2.5: a sweep of 48 newest listings in an ordinary
// category spreads 2.38-2.67 (live 2026-09-13: barbour jacket 2.38, new balance
// 550 2.50, vintage football shirt 2.67, corteiz 2.67). At 2.5 nearly every
// niche would land in "handle with care" and the report would say nothing.
const MIXED_SPREAD  = 3.0;

// Owner-editable via the `report_keywords` setting; this is only the fallback.
// Broader than the deal feed's six on purpose — the feed searches every 10
// minutes, this every 3 hours, so coverage costs far less browser time here.
const DEFAULT_REPORT_KEYWORDS = [
  'carhartt jacket', 'stone island', 'the north face puffer', 'ralph lauren jumper',
  'adidas samba', 'nike tech fleece', 'arcteryx jacket', 'patagonia fleece',
  'barbour jacket', 'levis 501', 'dr martens', 'new balance 550',
  'salomon xt-6', 'cp company', 'moncler jacket', 'stussy hoodie',
  'vintage football shirt', 'ugg boots', 'lululemon leggings', 'corteiz',
];

const round1 = n => Math.round(n * 10) / 10;
const round2 = n => Math.round(n * 100) / 100;
const avg = arr => arr.length ? arr.reduce((t, v) => t + v, 0) / arr.length : 0;
const dayKey = t => new Date(t).toISOString().slice(0, 10);

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(sorted, q) {
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : 0;
}

// ── Sampling ──────────────────────────────────────────────────────────────────
// Raw catalog items → one price sample, or null when there is too little to use.
function sampleFromItems(rawItems, now = Date.now()) {
  const prices = (rawItems || [])
    .map(r => offers.normalise(r, now))
    .filter(i => i.price > 0 && !offers.isJunk(i.title))
    .map(i => i.price)
    .sort((a, b) => a - b);
  if (prices.length < SAMPLE_MIN_N) return null;
  return {
    t:      now,
    median: round2(median(prices)),
    p25:    round2(percentile(prices, 0.25)),
    p75:    round2(percentile(prices, 0.75)),
    n:      prices.length,
  };
}

// A day's samples → one compact entry. Only today keeps its raw samples;
// holding every sample for 90 days would bloat a settings row read each sweep.
function finaliseDay(entry) {
  const s = entry.samples || [];
  if (!s.length) return null;
  return {
    day:    entry.day,
    median: round2(median(s.map(x => x.median))),
    p25:    round2(median(s.map(x => x.p25))),
    p75:    round2(median(s.map(x => x.p75))),
    n:      s.reduce((t, x) => t + (x.n || 0), 0),
    runs:   s.length,
  };
}

function recordSample(daily, keyword, sample, now = Date.now()) {
  const out = { ...(daily || {}) };
  const today = dayKey(now);
  const cutoff = dayKey(now - KEEP_DAYS * DAY);

  const list = (out[keyword] || [])
    .map(e => (e.day !== today && e.samples) ? finaliseDay(e) : { ...e })
    .filter(Boolean);

  let entry = list.find(e => e.day === today);
  if (!entry) { entry = { day: today, samples: [] }; list.push(entry); }
  if (sample) {
    entry.samples = [...(entry.samples || []), { median: sample.median, p25: sample.p25, p75: sample.p75, n: sample.n }].slice(-24);
  }

  out[keyword] = list
    .filter(e => e.day >= cutoff && !(e.samples && !e.samples.length && e.day !== today))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return out;
}

// Every day with a usable median, today included (finalised on the fly).
function readDays(list) {
  return (list || [])
    .map(e => (e.samples ? finaliseDay(e) : e))
    .filter(e => e && e.median > 0);
}

// ── Readiness ─────────────────────────────────────────────────────────────────
function dataStatus(daily, { now = Date.now(), days = 30, minDays = MIN_DAYS, minKeywords = MIN_KEYWORDS } = {}) {
  const cutoff = dayKey(now - days * DAY);
  const perKeyword = Object.entries(daily || {})
    .map(([keyword, list]) => ({ keyword, days: readDays(list).filter(e => e.day >= cutoff).length }))
    .sort((a, b) => b.days - a.days);
  const ready = perKeyword.filter(k => k.days >= minDays).length;
  const bestDays = perKeyword.length ? perKeyword[0].days : 0;
  return {
    keywords: perKeyword.length,
    ready,
    bestDays,
    minDays,
    minKeywords,
    enoughData: ready >= minKeywords,
    daysUntilReady: Math.max(0, minDays - (perKeyword[minKeywords - 1]?.days ?? 0)),
    perKeyword,
  };
}

// ── The report ────────────────────────────────────────────────────────────────
function codeNote(r) {
  if (r.group === 'watch') {
    return r.mixed
      ? 'This search mixes different items, so the going rate is unreliable. Narrow it before buying on it.'
      : 'Prices are swinging from week to week. Only buy well under the going rate.';
  }
  if (r.group === 'rising')  return 'The going rate is climbing. List what you already hold before chasing more stock.';
  if (r.group === 'falling') return 'The going rate is slipping. A cheaper time to source, a worse time to sell.';
  return r.gone24Pct !== null && r.gone24Pct >= 50
    ? 'Stable pricing, and underpriced finds here go fast. A dependable niche to keep sourcing.'
    : 'Stable pricing. Safe to source at a sensible discount.';
}

function monthLabel(t) {
  return new Date(t).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/London' });
}

// `feedKeywords` is trackRecord.summarise(...).keywords — evidence of how fast
// the deal feed's underpriced finds went, where a report niche overlaps it.
function buildReport(daily, feedKeywords = [], {
  now = Date.now(), days = 30, minDays = MIN_DAYS, minKeywords = MIN_KEYWORDS,
  targetMarginPct = 25, postage = 3,
} = {}) {
  const cutoff = dayKey(now - days * DAY);
  const feed = Object.fromEntries((feedKeywords || []).map(k => [String(k.keyword).toLowerCase(), k]));
  const rows = [];
  const skipped = [];

  for (const [keyword, list] of Object.entries(daily || {})) {
    const pts = readDays(list).filter(e => e.day >= cutoff);
    if (pts.length < minDays) { skipped.push({ keyword, days: pts.length }); continue; }

    // Compare the last week against the first week of the window rather than
    // two single days: one odd day should not read as a market move.
    const cur   = avg(pts.slice(-7).map(p => p.median));
    const start = avg(pts.slice(0, 7).map(p => p.median));
    const changePct = start ? Math.round(((cur - start) / start) * 100) : 0;

    const meds = pts.map(p => p.median);
    const mean = avg(meds);
    const sd = Math.sqrt(avg(meds.map(m => (m - mean) ** 2)));
    const volatilityPct = mean ? Math.round((sd / mean) * 100) : 0;

    const spreads = pts.slice(-7).filter(p => p.p25 > 0).map(p => p.p75 / p.p25);
    const spread = round1(avg(spreads));
    const mixed = spread > MIXED_SPREAD;

    const direction = changePct >= MOVE_PCT ? 'rising' : changePct <= -MOVE_PCT ? 'falling' : 'steady';
    const group = (mixed || volatilityPct > VOLATILE_PCT) ? 'watch' : direction;
    const f = feed[keyword.toLowerCase()];

    rows.push({
      keyword,
      median:        round2(cur),
      changePct,
      volatilityPct,
      spread,
      mixed,
      direction,
      group,
      days:          pts.length,
      listings:      pts.reduce((t, p) => t + (p.n || 0), 0),
      // The most a member can pay (item price) and still clear the margin
      // reselling at today's median — the Offer Finder's own maths.
      buyUnder:      offers.maxOfferFor(cur, { targetMarginPct, postage }),
      gone24Pct:     f && f.resolved >= 3 ? f.gone24Pct : null,
    });
  }

  const pick = g => rows.filter(r => r.group === g);
  const sections = {
    rising:  pick('rising').sort((a, b) => b.changePct - a.changePct).map(r => r.keyword),
    falling: pick('falling').sort((a, b) => a.changePct - b.changePct).map(r => r.keyword),
    steady:  pick('steady').sort((a, b) => (b.gone24Pct ?? -1) - (a.gone24Pct ?? -1) || a.volatilityPct - b.volatilityPct).map(r => r.keyword),
    watch:   pick('watch').sort((a, b) => a.keyword.localeCompare(b.keyword)).map(r => r.keyword),
  };

  const report = {
    label:       monthLabel(now - DAY),   // on the 1st, this names the month just ended
    generatedAt: now,
    days,
    targetMarginPct,
    postage,
    rows,
    sections,
    skipped,
    listings:    rows.reduce((t, r) => t + r.listings, 0),
    enoughData:  rows.length >= minKeywords,
    notes:       Object.fromEntries(rows.map(r => [r.keyword, codeNote(r)])),
    aiUsed:      false,
    aiDropped:   0,
  };
  report.summary = fallbackSummary(report);
  return report;
}

function fallbackSummary(report) {
  const s = report.sections;
  const parts = [`${report.rows.length} niches tracked: ${s.rising.length} rising, ${s.falling.length} falling, ${s.steady.length} steady.`];
  if (s.falling.length) parts.push(`Best sourcing window: ${s.falling[0]}.`);
  if (s.rising.length)  parts.push(`Strongest selling market: ${s.rising[0]}.`);
  return parts.join(' ');
}

// ── Claude notes ──────────────────────────────────────────────────────────────
// JSON schema for structured output. Notes only — no numeric fields exist for
// the model to fill.
const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { keyword: { type: 'string' }, note: { type: 'string' } },
        required: ['keyword', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'notes'],
  additionalProperties: false,
};

function buildNotesRequest(report) {
  const system = [
    'You write the commentary for a monthly market report sent to UK resellers who buy and sell second-hand clothing on Vinted.',
    'You receive one row per niche. The numbers are already computed and will be printed next to your words.',
    '',
    'Write one note per niche and a two-sentence summary of the month.',
    '- Never write a number, price, percentage, date or currency symbol. The report shows those; a repeated or rounded figure would contradict it.',
    '- Each note is one sentence, under 140 characters, and tells a reseller what to do: source, sell, hold, list now, or avoid, and why.',
    '- Base every note only on the row: group, direction, volatility, whether the search is mixed, and how fast deal-feed finds went (gone24Pct, null when unknown).',
    '- group "watch" means the data is unreliable; say so plainly rather than giving a buy or sell call.',
    '- Voice: direct and practical, peer to peer. No hype, no buzzwords, no emojis, no exclamation marks.',
    '- Use each keyword exactly as given.',
  ].join('\n');

  const rows = report.rows.map(r => ({
    keyword: r.keyword,
    group: r.group,
    direction: r.direction,
    changePct: r.changePct,
    volatilityPct: r.volatilityPct,
    mixedSearch: r.mixed,
    gone24Pct: r.gone24Pct,
  }));
  const user = `Niches for the 30 days to ${dayKey(report.generatedAt)}:\n${JSON.stringify(rows, null, 2)}`;
  return { system, user, schema: NOTES_SCHEMA };
}

// The Messages API request. Kept here, pure, so the exact params can be tested
// against the installed SDK without a network call or a bot.
//   - claude-opus-5 with adaptive thinking at medium effort: short judgement
//     calls over ~20 rows, once a month.
//   - Structured output (output_config.format) guarantees parseable JSON
//     matching NOTES_SCHEMA, instead of hoping a prompt holds.
//   - fallbacks: 'default' re-runs a policy decline on Anthropic's recommended
//     fallback model inside the same call. A market commentary request should
//     never be declined; if it is, the report still gets notes.
// The bot pins @anthropic-ai/sdk 0.39, which predates output_config and
// fallbacks in its types; create() serialises the body as given, so they pass
// through (verified by a captured request, not assumed).
const NOTES_MODEL = 'claude-opus-5';

function buildNotesParams(report) {
  const { system, user, schema } = buildNotesRequest(report);
  return {
    params: {
      model: NOTES_MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      fallbacks: 'default',
    },
    options: { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } },
  };
}

// Message → { parsed, model, fellBack } | { error, model, fellBack }.
// Thinking and fallback blocks come before the text; only text blocks are read.
function extractNotesJson(msg) {
  if (!msg || !Array.isArray(msg.content)) return { error: 'empty response' };
  const model = msg.model || null;
  const fellBack = (msg.usage?.iterations || []).some(i => i?.type === 'fallback_message');
  if (msg.stop_reason === 'refusal') {
    return { error: `refused (${msg.stop_details?.category || 'no category'})`, model, fellBack };
  }
  if (msg.stop_reason === 'max_tokens') return { error: 'hit max_tokens', model, fellBack };
  const text = msg.content.filter(b => b?.type === 'text').map(b => b.text).join('').trim();
  if (!text) return { error: 'no text block in response', model, fellBack };
  try {
    return { parsed: JSON.parse(text), model, fellBack };
  } catch {
    return { error: 'response text was not JSON', model, fellBack };
  }
}

// Anything numeric or decorative is rejected, not edited — a note with a
// figure in it is a note that could be wrong in a paid channel.
const FORBIDDEN_RE = /[0-9£$€%]|\p{Extended_Pictographic}/u;

function applyNotes(report, parsed) {
  if (!parsed || typeof parsed !== 'object') return report;
  const known = new Set(report.rows.map(r => r.keyword));
  const notes = { ...report.notes };
  let accepted = 0, dropped = 0;

  for (const n of Array.isArray(parsed.notes) ? parsed.notes : []) {
    const kw = typeof n?.keyword === 'string' ? n.keyword : '';
    const text = typeof n?.note === 'string' ? n.note.replace(/\s+/g, ' ').trim() : '';
    if (!known.has(kw)) { dropped++; continue; }
    if (!text || text.length > 180 || FORBIDDEN_RE.test(text)) { dropped++; continue; }
    notes[kw] = text;
    accepted++;
  }

  const summaryText = typeof parsed.summary === 'string' ? parsed.summary.replace(/\s+/g, ' ').trim() : '';
  const summaryOk = summaryText && summaryText.length <= 500 && !FORBIDDEN_RE.test(summaryText);

  return {
    ...report,
    notes,
    // The code summary carries real counts; only replace it with a clean one.
    summary:   summaryOk ? summaryText : report.summary,
    aiUsed:    accepted > 0 || summaryOk,
    aiDropped: dropped + (summaryText && !summaryOk ? 1 : 0),
  };
}

// ── Discord payloads ──────────────────────────────────────────────────────────
const SECTION_TITLES = {
  rising:  'Rising — sell into it',
  falling: 'Falling — source into it',
  steady:  'Steady',
  watch:   'Handle with care',
};

function money(n) {
  return `£${n % 1 ? n.toFixed(2) : n.toFixed(0)}`;
}

function buildNicheReportPayload(report, { tier = 'pro' } = {}) {
  const isElite = tier === 'elite';
  const byKw = Object.fromEntries(report.rows.map(r => [r.keyword, r]));

  const line = r => {
    const move = r.changePct === 0 ? 'flat' : `${r.changePct > 0 ? '↑' : '↓'} ${Math.abs(r.changePct)}%`;
    const cap  = isElite && r.buyUnder ? ` · buy under **${money(r.buyUnder)}**` : '';
    return `**${r.keyword}** — ${money(Math.round(r.median))} ${move}${cap}\n${report.notes[r.keyword] || ''}`;
  };

  const fields = [];
  for (const key of ['rising', 'falling', 'steady', 'watch']) {
    const rows = (report.sections[key] || []).map(k => byKw[k]).filter(Boolean);
    if (!rows.length) continue;
    // Field values cap at 1024 characters: keep whole lines and say what was cut.
    let value = '';
    let shown = 0;
    for (const r of rows) {
      const next = (value ? '\n\n' : '') + line(r);
      const tail = `\n\n…and ${rows.length - shown - 1} more`;
      if ((value + next).length > 1024 - (shown < rows.length - 1 ? tail.length : 0)) break;
      value += next;
      shown++;
    }
    if (shown < rows.length) value += `\n\n…and ${rows.length - shown} more`;
    fields.push({ name: SECTION_TITLES[key], value });
  }

  const footer = isElite
    ? `Buy under = the most you can pay and still make ${report.targetMarginPct}% reselling at today's going rate, after Vinted's buyer fee and £${report.postage.toFixed(2)} postage. Asking prices, not sold prices.`
    : `Median asking prices from ${report.listings.toLocaleString('en-GB')} UK Vinted listings over ${report.days} days. Asking prices, not sold prices. Elite members get a buy-under price for every niche.`;

  const embed = new EmbedBuilder()
    .setColor(isElite ? GOLD : PINK)
    .setTitle(`${isElite ? 'Elite niche report' : 'Niche report'} — ${report.label}`)
    .setDescription(report.summary.slice(0, 4000))
    .addFields(fields)
    .setFooter({ text: footer })
    .setTimestamp(new Date(report.generatedAt));

  return { embeds: [embed] };
}

function buildStatusPayload(status) {
  const top = status.perKeyword.slice(0, 12)
    .map(k => `${k.days >= status.minDays ? '✓' : '·'} ${k.keyword} — ${k.days} day${k.days === 1 ? '' : 's'}`)
    .join('\n') || 'No samples recorded yet.';
  const embed = new EmbedBuilder()
    .setColor(status.enoughData ? '#4ade80' : PINK)
    .setTitle(status.enoughData ? 'Niche report — data ready' : 'Niche report — still collecting data')
    .setDescription(
      `${status.ready} of ${status.keywords} niche${status.keywords === 1 ? '' : 's'} have ${status.minDays}+ days of data ` +
      `(need ${status.minKeywords}).` +
      (status.enoughData ? '' : ` Roughly ${status.daysUntilReady} more day${status.daysUntilReady === 1 ? '' : 's'} to go.`) +
      `\n\n${top}`
    )
    .setTimestamp();
  return { embeds: [embed] };
}

module.exports = {
  DEFAULT_REPORT_KEYWORDS,
  MIN_DAYS,
  MIN_KEYWORDS,
  dayKey,
  sampleFromItems,
  recordSample,
  readDays,
  dataStatus,
  buildReport,
  buildNotesRequest,
  buildNotesParams,
  extractNotesJson,
  applyNotes,
  buildNicheReportPayload,
  buildStatusPayload,
};
