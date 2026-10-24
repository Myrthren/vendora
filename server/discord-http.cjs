'use strict';

function createDiscord({ token, request = fetch }) {
  async function call(route, body) {
    if (!token) throw new Error('Discord delivery is not configured');
    const r = await request('https://discord.com/api/v10' + route, {
      method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) { const e = new Error('Discord delivery failed'); e.status = r.status; throw e; }
    return r.json();
  }
  return {
    async sendDM(recipient, content) {
      if (!/^\d{15,22}$/.test(String(recipient))) throw new Error('Invalid support recipient');
      const channel = await call('/users/@me/channels', { recipient_id: String(recipient) });
      if (!/^\d{15,22}$/.test(String(channel.id))) throw new Error('Invalid Discord channel');
      return call(`/channels/${channel.id}/messages`, { content: String(content).slice(0, 2000), allowed_mentions: { parse: [] } });
    },
  };
}
module.exports = { createDiscord };
