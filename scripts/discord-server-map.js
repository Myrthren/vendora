#!/usr/bin/env node
// Print the full structure of the Discord server: every category, every channel
// of every type, in display order, with the permission overwrites that matter
// for tier gating resolved into readable names.
//
// READ ONLY. This script issues GET requests and nothing else — it cannot
// create, edit or delete anything.
//
//   $env:DISCORD_BOT_TOKEN = "<token>"        # PowerShell — set it yourself
//   $env:DISCORD_GUILD_ID  = "<guild id>"     # optional, or pass as argv[2]
//   node scripts/discord-server-map.js
//
// Raw REST so it needs no dependencies — just Node 18+.

const TOKEN    = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.argv[2] || process.env.DISCORD_GUILD_ID;

if (!TOKEN) {
  console.error('DISCORD_BOT_TOKEN is not set in this shell. Set it and re-run.');
  process.exit(1);
}
if (!GUILD_ID) {
  console.error('Usage: node scripts/discord-server-map.js <guild_id>');
  console.error('   or: set DISCORD_GUILD_ID in this shell first.');
  process.exit(1);
}

// Keep in step with ROLE_IDS in bot/index.js (~line 161).
const TIER_ROLES = {
  '1491388683327242290': 'Basic',
  '1491389600852349061': 'Pro',
  '1491389713607823420': 'Elite',
};

// https://discord.com/developers/docs/resources/channel#channel-object-channel-types
const TYPES = {
  0: 'text', 2: 'voice', 4: 'CATEGORY', 5: 'announcement', 10: 'news-thread',
  11: 'public-thread', 12: 'private-thread', 13: 'stage', 14: 'directory',
  15: 'forum', 16: 'media',
};

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;

async function api(path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${TOKEN}` },
  });
  if (!r.ok) {
    throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  }
  return r.json();
}

// Turn a channel's overwrites into a one-line summary of who can see it.
function visibility(channel, guildId, roleNames) {
  const ows = channel.permission_overwrites || [];
  if (!ows.length) return 'inherits category';

  const parts = [];
  for (const ow of ows) {
    const allow = BigInt(ow.allow || '0');
    const deny  = BigInt(ow.deny  || '0');
    if (!((allow | deny) & (VIEW_CHANNEL | SEND_MESSAGES))) continue;

    const who = ow.id === guildId
      ? '@everyone'
      : ow.type === 0
        ? (TIER_ROLES[ow.id] || roleNames.get(ow.id) || `role:${ow.id}`)
        : `member:${ow.id}`;

    const bits = [];
    if (deny  & VIEW_CHANNEL)  bits.push('-view');
    if (allow & VIEW_CHANNEL)  bits.push('+view');
    if (deny  & SEND_MESSAGES) bits.push('-send');
    if (allow & SEND_MESSAGES) bits.push('+send');
    parts.push(`${who} ${bits.join(' ')}`);
  }
  return parts.length ? parts.join('  |  ') : 'inherits category';
}

(async () => {
  const guild    = await api(`/guilds/${GUILD_ID}`);
  const channels = await api(`/guilds/${GUILD_ID}/channels`);
  const roles    = await api(`/guilds/${GUILD_ID}/roles`);

  const roleNames = new Map(roles.map(r => [r.id, r.name]));
  const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0);

  const categories = channels.filter(c => c.type === 4).sort(byPos);
  const children   = id => channels.filter(c => c.parent_id === id).sort(byPos);
  const orphans    = channels.filter(c => !c.parent_id && c.type !== 4).sort(byPos);

  const line = (c, indent) => {
    const type = TYPES[c.type] || `type${c.type}`;
    console.log(`${indent}#${c.name}`.padEnd(38) + `${type.padEnd(13)} ${visibility(c, GUILD_ID, roleNames)}`);
    if (c.topic) console.log(`${indent}   topic: ${c.topic}`);
  };

  console.log(`\n${guild.name}  —  ${channels.length} channels, ${categories.length} categories, ${roles.length} roles\n`);

  if (orphans.length) {
    console.log('(no category)');
    orphans.forEach(c => line(c, '  '));
    console.log('');
  }

  for (const cat of categories) {
    const kids = children(cat.id);
    console.log(`${cat.name.toUpperCase()}  (${kids.length})`);
    console.log(`  ${visibility(cat, GUILD_ID, roleNames)}`);
    kids.forEach(c => line(c, '  '));
    console.log('');
  }

  console.log('ROLES (position order, highest first)');
  roles.sort((a, b) => b.position - a.position).forEach(r => {
    const tag = TIER_ROLES[r.id] ? '  <- Vendora tier role' : '';
    console.log(`  ${String(r.position).padStart(3)}  ${r.name}${tag}`);
  });

  // The two channels the bot resolves by NAME. If either is missing, the
  // feature that depends on it fails silently at runtime.
  console.log('\nBOT NAME DEPENDENCIES');
  const named = n => channels.find(c => c.type === 0 && c.name === n);
  const loose = s => channels.find(c => c.type === 0 && c.name.toLowerCase().includes(s));
  const check = (label, chan, why) =>
    console.log(`  ${chan ? 'OK     ' : 'MISSING'}  ${label.padEnd(22)} ${why}`);
  check('use-vendora',  named('use-vendora'),                     'bot/index.js:1570 — parents /session channels; named on the landing page');
  check('*support*',    named('❓｜support') || loose('support'),  'bot/index.js:7678 — support channel lookup');
  check('*rules*',      loose('rules'),                           'bot/index.js:7686 — rules channel lookup');
})().catch(e => {
  console.error(e.message);
  process.exit(1);
});
