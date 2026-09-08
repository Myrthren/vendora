#!/usr/bin/env node
// Post the win-back DM embed into a Discord channel for approval, without
// deploying anything. Raw REST so it needs no dependencies — just Node 18+.
//
//   $env:DISCORD_BOT_TOKEN = "<token>"        # PowerShell — set it yourself
//   node scripts/preview-winback-dm.js 1487571461408297182
//
// The bot must be able to see and post in that channel. Nothing is DM'd.

const { buildWinbackPayload } = require('../bot/winback-embed');

const TOKEN     = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.argv[2] || process.env.WINBACK_PREVIEW_CHANNEL;

if (!TOKEN) {
  console.error('DISCORD_BOT_TOKEN is not set in this shell. Set it and re-run.');
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error('Usage: node scripts/preview-winback-dm.js <channel_id>');
  process.exit(1);
}

(async () => {
  const payload = buildWinbackPayload({ username: 'Kene' });
  const r = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${TOKEN}` },
    body: JSON.stringify({
      content: '**Preview — win-back DM.** This is exactly what unsubscribed members will receive.',
      ...payload,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`Discord returned ${r.status}:`, text);
    process.exit(1);
  }
  console.log(`Posted preview to channel ${CHANNEL_ID}.`);
})();
