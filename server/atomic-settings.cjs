'use strict';
const { randomUUID } = require('node:crypto');

// Optimistic updates use a PostgREST JSON revision filter. A failed comparison
// changes no row; concurrent functions retry rather than losing increments.
// Uses the existing settings table and its unique key. No schema migration.
function createAtomicSettings({ url, key, request = fetch, attempts = 8 }) {
  const headers = () => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' });
  async function read(name) {
    if (!key) throw new Error('Database configuration is unavailable');
    const r = await request(`${url}/rest/v1/settings?key=eq.${encodeURIComponent(name)}&select=value`, { headers: headers(), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('Could not read usage state');
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('Invalid usage state');
    return rows[0]?.value ?? null;
  }
  async function compareAndSet(name, previous, next) {
    const revision = previous?._revision;
    const value = { ...next, _revision: randomUUID() };
    const payload = { key: name, value, updated_at: new Date().toISOString() };
    let endpoint = `${url}/rest/v1/settings`;
    const opts = { headers: headers(), signal: AbortSignal.timeout(10000) };
    if (previous === null) {
      endpoint += '?on_conflict=key';
      opts.method = 'POST';
      opts.headers.Prefer = 'resolution=ignore-duplicates,return=representation';
      opts.body = JSON.stringify(payload);
    } else {
      endpoint += `?key=eq.${encodeURIComponent(name)}&value->>_revision=${revision ? 'eq.' + encodeURIComponent(revision) : 'is.null'}`;
      opts.method = 'PATCH';
      opts.body = JSON.stringify({ value, updated_at: payload.updated_at });
    }
    const r = await request(endpoint, opts);
    if (!r.ok) throw new Error('Could not persist usage state');
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('Invalid persistence response');
    return rows.length === 1;
  }
  async function update(name, decide) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const previous = await read(name);
      const decision = decide(previous ? structuredClone(previous) : null);
      if (!Object.hasOwn(decision, 'value')) return decision.result;
      if (await compareAndSet(name, previous, decision.value)) return decision.result;
      await new Promise(resolve => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
    }
    throw new Error('Usage state is busy; please retry shortly');
  }
  return { read, update, compareAndSet };
}

module.exports = { createAtomicSettings };
