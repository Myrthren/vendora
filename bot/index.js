const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ── Config ──────────────────────────────────────────────────────────────────
const GUILD_ID       = process.env.DISCORD_GUILD_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PORT           = process.env.PORT || 3000;

const ROLE_IDS = {
  basic: '1491388683327242290',
  pro:   '1491389600852349061',
  elite: '1491389713607823420',
};

const TIER_NAMES  = { basic: 'Starter', pro: 'Pro', elite: 'Elite' };
const TIER_PRICES = { basic: '£9.99',   pro: '£24.99', elite: '£49.99' };
const DASHBOARD   = 'https://vendora-vv.netlify.app/vendora-dashboard.html';

// ── Discord ready ────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✓ Vendora bot online as ${client.user.tag}`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────
async function assignRole(member, tier) {
  // Remove all existing tier roles
  const toRemove = Object.values(ROLE_IDS).filter(id => member.roles.cache.has(id));
  if (toRemove.length) await member.roles.remove(toRemove);

  // Add new tier role
  if (tier && ROLE_IDS[tier]) {
    await member.roles.add(ROLE_IDS[tier]);
  }
}

async function sendDM(member, message) {
  try {
    await member.send(message);
  } catch {
    console.log(`Could not DM ${member.user.tag} — DMs may be closed`);
  }
}

// ── Webhook endpoint (called by Supabase Database Webhook) ───────────────────
app.post('/webhook', async (req, res) => {
  // Verify secret header
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, record } = req.body;

  // Only handle INSERT and UPDATE events on profiles
  if (!['INSERT', 'UPDATE'].includes(type)) {
    return res.json({ ok: true });
  }

  const { discord_id, tier, subscription_status } = record;
  if (!discord_id) return res.json({ ok: true });

  try {
    const guild  = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discord_id).catch(() => null);

    if (!member) {
      console.log(`Member ${discord_id} not in server — skipping role assignment`);
      return res.json({ ok: true });
    }

    if (subscription_status === 'active' && tier && ROLE_IDS[tier]) {
      await assignRole(member, tier);
      await sendDM(member,
        `**Your Vendora ${TIER_NAMES[tier]} subscription is active!**\n\n` +
        `✓ Role assigned: **${TIER_NAMES[tier]}**\n` +
        `✓ Billing: ${TIER_PRICES[tier]}/month via PayPal\n\n` +
        `Manage your account: ${DASHBOARD}`
      );
      console.log(`✓ Assigned ${tier} role to ${discord_id}`);

    } else if (subscription_status === 'inactive') {
      await assignRole(member, null); // removes all tier roles
      await sendDM(member,
        `**Your Vendora subscription has ended.**\n\n` +
        `Your tier role has been removed.\n` +
        `Resubscribe anytime at: ${DASHBOARD}`
      );
      console.log(`✓ Removed tier roles from ${discord_id}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'Vendora bot running' }));

// ── Start ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`✓ Webhook server listening on port ${PORT}`));
