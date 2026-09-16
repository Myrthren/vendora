// ── Deal-feed track record ────────────────────────────────────────────────────
// Every find posted to an Elite monitor channel is logged, then rechecked at 2h, 24h and
// 72h to see whether it is still buyable. The published number is the share of
// finds that were gone by each check — proof that the feed calls things people
// actually want, in place of the testimonials the honesty pass removed.
//
// Pure logic and payload builders: no client, no database, no config imports —
// same convention as feeds.js, so the numbers and the embed can be previewed
// and tested without a token.
//
// HOW "GONE" IS DETECTED (probed live 2026-09-13):
//   - /api/v2/items/{id} 404s WITHOUT a session for live and nonexistent items
//     alike, so it cannot tell the two apart. Not usable.
//   - The seller's public wardrobe (/api/v2/wardrobe/{id}/items) works without a
//     token, carries is_closed / is_reserved / is_hidden, and every search
//     result sampled was on page 1 of its seller's wardrobe (newest_first).
//     Sold items do not appear in it at all.
//   So: in the wardrobe = still up; missing from a COMPLETE wardrobe = gone.
//
// WHAT "GONE" MEANS — keep the copy honest: an item leaves the wardrobe when it
// sells, but also when the seller deletes or hides it. Vinted's public data
// cannot separate those. Everything user-facing says "no longer available",
// never "sold".

const { EmbedBuilder } = require('discord.js');

const PINK = '#e8217a';
const H = 60 * 60 * 1000;

// Hours after posting at which a find is rechecked.
const CHECK_AT_H = [2, 24, 72];
// Slack on each bucket: the hourly sweep runs a check up to an hour late, and a
// find should not fall out of "gone by 24h" because the cron ran at 24h40m.
const BUCKET_SLACK_H = 2;
// A find whose wardrobe could never be read is dropped from the stats after
// this, rather than sitting as pending forever.
const EXPIRE_AFTER_H = 96;
const KEEP_DAYS = 60;
const MAX_LOG = 3000;
// Below this many resolved finds a percentage is noise, not a track record.
const MIN_RESOLVED = 20;

// Append freshly posted picks. Picks without a seller id cannot be checked
// (the Apify fallback does not always return one), so they are logged as
// untracked and excluded from the stats rather than silently dropped.
function logFinds(log, { keyword, picks, median, now = Date.now() }) {
  const known = new Set((log || []).map(e => e.id));
  const added = [];
  for (const p of picks || []) {
    const id = p?.id ? String(p.id) : '';
    if (!id || known.has(id)) continue;
    known.add(id);
    added.push({
      id,
      sellerId:    p.sellerId ? String(p.sellerId) : null,
      keyword,
      title:       (p.title || '').slice(0, 80),
      url:         p.url || `https://www.vinted.co.uk/items/${id}`,
      price:       p.priceNum || 0,
      median:      median || 0,
      discountPct: p.discountPct || 0,
      postedAt:    now,
      checks:      0,
      state:       p.sellerId ? 'pending' : 'untracked',
      lastSeenAt:  now,
      goneAt:      null,
      reservedAt:  null,
    });
  }
  const kept = [...(log || []), ...added]
    .filter(e => e.postedAt > now - KEEP_DAYS * 24 * H)
    .slice(-MAX_LOG);
  return { log: kept, added: added.length };
}

// Checks passed by an entry's age. If the bot was down through a check, the
// next sweep does one check and counts every mark already passed, instead of
// running three checks back to back.
function marksPassed(entry, now) {
  const ageH = (now - entry.postedAt) / H;
  return CHECK_AT_H.filter(h => ageH >= h).length;
}

function dueChecks(log, now = Date.now()) {
  return (log || []).filter(e => e.state === 'pending' && marksPassed(e, now) > e.checks);
}

// Turn one wardrobe read into an outcome for one item.
//   wardrobe = { items: { [id]: { closed, reserved, hidden } }, complete } | { error }
function outcomeFromWardrobe(itemId, wardrobe) {
  if (!wardrobe || wardrobe.error || !wardrobe.items) return 'unknown';
  // An EMPTY wardrobe is what a deleted account looks like, but it is also what
  // a soft block returning `{ items: [] }` looks like — and treating that as
  // "gone" would mark every find from the seller as sold and inflate a public
  // number. Unknown is the honest answer; it expires out of the stats at 96h.
  if (!Object.keys(wardrobe.items).length) return 'unknown';
  const hit = wardrobe.items[String(itemId)];
  if (hit) {
    if (hit.closed || hit.hidden) return 'gone';
    if (hit.reserved) return 'reserved';
    return 'present';
  }
  // Missing from a wardrobe we only partly read may just be on a later page.
  return wardrobe.complete ? 'gone' : 'unknown';
}

function applyCheck(entry, outcome, now = Date.now()) {
  const e = { ...entry };
  if (outcome === 'unknown') {
    if ((now - e.postedAt) / H >= EXPIRE_AFTER_H) e.state = 'expired';
    return e;
  }
  e.checks = marksPassed(e, now);
  if (outcome === 'gone') {
    e.state = 'gone';
    e.goneAt = now;
    return e;
  }
  e.lastSeenAt = now;
  if (outcome === 'reserved' && !e.reservedAt) e.reservedAt = now;
  if (e.checks >= CHECK_AT_H.length) e.state = outcome === 'reserved' ? 'reserved' : 'live';
  return e;
}

// Stats over finds POSTED in the window that have reached a final state.
// Buckets use the time the item was DETECTED gone, which is an upper bound —
// "gone by the 24h check" is exactly what we observed, nothing more.
function summarise(log, { now = Date.now(), days = 30 } = {}) {
  const inWindow = (log || []).filter(e => e.postedAt > now - days * 24 * H);
  const resolved = inWindow.filter(e => ['gone', 'live', 'reserved'].includes(e.state));
  const gone = resolved.filter(e => e.state === 'gone');
  const within = h => gone.filter(e => e.goneAt - e.postedAt <= (h + BUCKET_SLACK_H) * H).length;
  const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;

  const byKeyword = {};
  for (const e of resolved) {
    const k = byKeyword[e.keyword] || (byKeyword[e.keyword] = { keyword: e.keyword, resolved: 0, gone24: 0 });
    k.resolved++;
    if (e.state === 'gone' && e.goneAt - e.postedAt <= (24 + BUCKET_SLACK_H) * H) k.gone24++;
  }
  const keywords = Object.values(byKeyword)
    .map(k => ({ ...k, gone24Pct: pct(k.gone24, k.resolved) }))
    .sort((a, b) => b.gone24Pct - a.gone24Pct || b.resolved - a.resolved);

  const avg = arr => arr.length ? arr.reduce((t, v) => t + v, 0) / arr.length : 0;

  return {
    days,
    posted:      inWindow.length,
    resolved:    resolved.length,
    pending:     inWindow.filter(e => e.state === 'pending').length,
    untracked:   inWindow.filter(e => e.state === 'untracked' || e.state === 'expired').length,
    gone2hPct:   pct(within(2), resolved.length),
    gone24hPct:  pct(within(24), resolved.length),
    gone72hPct:  pct(gone.length, resolved.length),
    reservedPct: pct(resolved.filter(e => e.state === 'reserved').length, resolved.length),
    avgDiscountPct: Math.round(avg(resolved.map(e => e.discountPct || 0))),
    keywords,
    enoughData:  resolved.length >= MIN_RESOLVED,
  };
}

function buildTrackRecordPayload(summary) {
  const top = summary.keywords.filter(k => k.resolved >= 3).slice(0, 5);
  const lines = top.map(k =>
    `**${k.keyword}** — ${k.gone24Pct}% gone within a day · ${k.resolved} find${k.resolved === 1 ? '' : 's'}`
  );

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle(`Deal feed track record — last ${summary.days} days`)
    .setDescription(
      `Every underpriced listing the feed posted, rechecked 2, 24 and 72 hours ` +
      `later to see whether it could still be bought.\n\n` +
      (lines.length ? lines.join('\n') : '')
    )
    .addFields(
      { name: 'Finds checked',        value: String(summary.resolved),       inline: true },
      { name: 'Gone within 2 hours',  value: `${summary.gone2hPct}%`,        inline: true },
      { name: 'Gone within 24 hours', value: `${summary.gone24hPct}%`,       inline: true },
      { name: 'Gone within 3 days',   value: `${summary.gone72hPct}%`,       inline: true },
      { name: 'Average discount',     value: `${summary.avgDiscountPct}% under median`, inline: true },
    )
    .setFooter({ text: '"Gone" means no longer available on Vinted — sold, or removed or hidden by the seller. Pro and Elite see these finds live in the Monitors channels.' })
    .setTimestamp();

  return { embeds: [embed] };
}

module.exports = {
  CHECK_AT_H,
  MIN_RESOLVED,
  logFinds,
  dueChecks,
  outcomeFromWardrobe,
  applyCheck,
  summarise,
  buildTrackRecordPayload,
};
