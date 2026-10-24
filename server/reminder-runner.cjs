'use strict';
const { randomUUID } = require('node:crypto');
const coach = require('../bot/reprice-coach');
const { capabilities } = require('../bot/member-intelligence');
const { dayKey } = require('./web-quotas.cjs');

async function runReminders(runtime, { now = Date.now, budgetMs = 20000 } = {}) {
  const { store, atomic, request, messenger, getProfileByUserId, url, key, env } = runtime;
  const start = now();
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start);
  // The scheduler uses UTC; this guard follows British summer time without
  // shifting the promised local delivery window when the clocks change.
  if (env.VENDORA_REPRICE_ENABLED !== 'true' || !env.DISCORD_BOT_TOKEN || local < '12:10' || local > '12:59') return { skipped: true };
  const day = dayKey(start), owner = randomUUID(), lockKey = 'netlify_reprice_dispatch_v1';
  const lease = await atomic.update(lockKey, raw => {
    const state = raw?.day === day ? raw : { day, offset: 0, complete: false };
    if (state.complete || state.leaseUntil > start) return { result: null };
    return { value: { ...state, owner, leaseUntil: start + 120000 }, result: { offset: state.offset } };
  });
  if (!lease) return { skipped: true };
  let offset = lease.offset, sentCount = 0, processed = 0, complete = false;
  try {
    const daily = await store.getSetting('niche_daily_v2');
    while (now() - start < budgetMs && processed < 10) {
      // One recipient per page makes a persisted cursor precise, including
      // users who opted out. Work resumes in the next ten-minute invocation.
      const response = await request(`${url}/rest/v1/profiles?tier=eq.elite&subscription_status=eq.active&select=id,discord_id,is_banned&order=id&limit=1&offset=${offset}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Could not read reminder recipients');
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('Invalid reminder recipients');
      if (!rows.length) { complete = true; break; }
      const profile = rows[0];
      if (!profile.is_banned && profile.discord_id && (await store.getSetting(`reprice_preferences_${profile.id}`))?.enabled) {
        const snapshot = await store.getSetting(`vinted_inventory_${profile.id}`);
        const suggestions = coach.recommendations(snapshot, daily, now()).items;
        const previous = (await store.getSetting(`reprice_sent_${profile.id}`)) || {};
        const due = coach.dueItems(suggestions, previous, now());
        if (due.length) {
          const current = await getProfileByUserId(profile.id);
          const consent = await store.getSetting(`reprice_preferences_${profile.id}`);
          if (capabilities(current).repriceCoach && !current.is_banned && consent?.enabled) {
            const stampedAt = now();
            const claimed = await atomic.update(`reprice_sent_${profile.id}`, raw => {
              const latest = raw || {};
              const fresh = coach.dueItems(due, latest, stampedAt);
              if (!fresh.length) return { result: [] };
              for (const item of fresh) latest[item.id] = stampedAt;
              return { value: latest, result: fresh };
            });
            if (claimed.length) {
              try { await messenger.sendDM(profile.discord_id, coach.dmPayload(claimed).content); sentCount++; }
              catch {
                // A known failed send can retry later; preserve any changes
                // written by another runner since this invocation's claim.
                await atomic.update(`reprice_sent_${profile.id}`, raw => {
                  const next = raw || {};
                  for (const item of claimed) if (next[item.id] === stampedAt) {
                    if (previous[item.id]) next[item.id] = previous[item.id]; else delete next[item.id];
                  }
                  return { value: next, result: null };
                });
              }
            }
          }
        }
      }
      offset++; processed++;
    }
    return { processed, sent: sentCount, complete };
  } finally {
    await atomic.update(lockKey, raw => raw?.owner === owner
      ? { value: { ...raw, offset, complete, leaseUntil: 0 }, result: null }
      : { result: null });
  }
}
module.exports = { runReminders };
