'use strict';
const { createHmac } = require('node:crypto');
const { RATE_LIMITS } = require('../bot/member-intelligence');
const DAY = 86400000;
const TEN_MINUTES = 600000;
function dayKey(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
function bucket(old, now, window) {
  return old && now >= old.start && now < old.start + window ? { ...old } : { start: now, count: 0 };
}
function visitorId(ip, secret) { return createHmac('sha256', secret).update(String(ip || 'unknown')).digest('hex').slice(0, 32); }
function createQuotas(atomic, { secret, now = Date.now } = {}) {
  async function take(kind, id, tier = 'none') {
    const at = now();
    const day = dayKey(at);
    return atomic.update(`netlify_${kind === 'support' ? 'support' : 'ai'}_quota_${day}`, raw => {
      const state = raw || { people: {}, groups: {}, total: 0 };
      const who = `${kind}:${id}`;
      const person = state.people[who] || { used: 0 };
      const window = kind === 'member' ? 60000 : TEN_MINUTES;
      const burstLimit = kind === 'member' ? RATE_LIMITS.burst[tier] : kind === 'support' ? 2 : 8;
      const dayLimit = kind === 'member' ? RATE_LIMITS.day[tier] : kind === 'support' ? 5 : 80;
      const burst = bucket(person.burst, at, window);
      const group = bucket(state.groups[kind], at, TEN_MINUTES);
      const groupLimit = kind === 'member' ? 80 : kind === 'public' ? 40 : 15;
      const totalLimit = kind === 'support' ? 50 : 600;
      // Refusals do not mutate any counters. The daily row bounds its own size:
      // only accepted callers enter people, and at most totalLimit can enter.
      if (person.used >= dayLimit || burst.count >= burstLimit || group.count >= groupLimit || state.total >= totalLimit) {
        return { result: { allowed: false, retryAfter: person.used >= dayLimit || state.total >= totalLimit ? 3600 : Math.max(1, Math.ceil((burst.start + window - at) / 1000)) } };
      }
      state.people[who] = { used: person.used + 1, burst: { ...burst, count: burst.count + 1 } };
      state.groups[kind] = { ...group, count: group.count + 1 };
      state.total++;
      return { value: state, result: { allowed: true, remaining: dayLimit - person.used - 1, limit: dayLimit } };
    });
  }
  return { take, visitor: ip => visitorId(ip, secret) };
}
module.exports = { createQuotas, visitorId, dayKey };
