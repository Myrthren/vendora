'use strict';

// Consent and reminder cooldowns must fail visibly when persistence fails.
// The legacy bot setting helpers intentionally swallow errors; new features
// cannot use that behaviour to report a preference saved or a DM recorded.
function createFeatureSettings({ url, key, request = fetch }) {
  const headers = () => ({ apikey: key, Authorization: `Bearer ${key}` });
  return {
    async getSetting(name) {
      if (!key) throw new Error('Feature storage is unavailable');
      const result = await request(`${url}/rest/v1/settings?key=eq.${encodeURIComponent(name)}&select=value`, {
        headers: headers(), signal: AbortSignal.timeout(15000),
      });
      if (!result.ok) throw new Error('Could not read feature settings');
      const rows = await result.json();
      if (!Array.isArray(rows)) throw new Error('Invalid feature settings response');
      return rows[0]?.value ?? null;
    },
    async saveSetting(name, value) {
      if (!key) throw new Error('Feature storage is unavailable');
      const result = await request(`${url}/rest/v1/settings`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ key: name, value, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(15000),
      });
      if (!result.ok) throw new Error('Could not save feature settings');
    },
  };
}
module.exports = { createFeatureSettings };
