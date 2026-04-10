process.on('uncaughtException',  err => console.error('[crash] uncaughtException:', err));
process.on('unhandledRejection', err => console.error('[crash] unhandledRejection:', err));

console.log('[boot] Loading modules...');

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');

console.log('[boot] Modules loaded');

// ── Config ───────────────────────────────────────────────────────────────────
const TOKEN           = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID        = process.env.DISCORD_GUILD_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://fqfanqtybvnurhzkoxwr.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const PORT            = process.env.PORT || 3000;

console.log('[boot] Config loaded — GUILD_ID:', GUILD_ID, '| PORT:', PORT);

if (!TOKEN)          console.warn('[warn] DISCORD_BOT_TOKEN is not set');
if (!GUILD_ID)       console.warn('[warn] DISCORD_GUILD_ID is not set');
if (!WEBHOOK_SECRET) console.warn('[warn] WEBHOOK_SECRET is not set');

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

const ROLE_IDS = {
  basic: '1491388683327242290',
  pro:   '1491389600852349061',
  elite: '1491389713607823420',
};
const TIER_NAMES  = { basic: 'Starter', pro: 'Pro', elite: 'Elite' };
const TIER_PRICES = { basic: '£9.99',   pro: '£24.99', elite: '£49.99' };
const DASHBOARD   = 'https://vendora-vv.netlify.app/vendora-dashboard';

client.once('ready', () => {
  console.log(`[discord] Online as ${client.user.tag}`);
});

client.on('error', err => console.error('[discord] Client error:', err));

// ── Helpers ───────────────────────────────────────────────────────────────────
async function assignRole(member, tier) {
  const allRoleIds = Object.values(ROLE_IDS);
  const toRemove = allRoleIds.filter(id => member.roles.cache.has(id));
  if (toRemove.length) {
    await member.roles.remove(toRemove);
    console.log(`[roles] Removed ${toRemove.length} old role(s) from ${member.user.tag}`);
  }
  if (tier && ROLE_IDS[tier]) {
    await member.roles.add(ROLE_IDS[tier]);
    console.log(`[roles] Added ${tier} role to ${member.user.tag}`);
  }
}

async function sendDM(member, message) {
  try {
    await member.send(message);
    console.log(`[dm] Sent DM to ${member.user.tag}`);
  } catch (e) {
    console.log(`[dm] Could not DM ${member.user.tag} — DMs likely closed (${e.message})`);
  }
}

// Update Supabase profile via REST (used by PayPal webhook)
async function updateProfile(filterKey, filterVal, data) {
  if (!SUPABASE_KEY) {
    console.warn('[supabase] SUPABASE_SERVICE_KEY not set — skipping profile update');
    return { error: 'no key' };
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?${filterKey}=eq.${encodeURIComponent(filterVal)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(data),
      }
    );
    const text = await res.text();
    if (!res.ok) return { error: text };
    return { data: JSON.parse(text || '[]') };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Express server ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.json({ status: 'ok', bot: client.user?.tag || 'connecting...' });
});

// Supabase DB webhook — fired on profiles INSERT/UPDATE
app.post('/webhook', async (req, res) => {
  console.log('[webhook] Received request from', req.ip);

  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    console.warn('[webhook] Rejected — bad secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, record } = req.body || {};
  console.log('[webhook] type:', type, '| discord_id:', record?.discord_id, '| tier:', record?.tier, '| status:', record?.subscription_status);

  if (!record || !['INSERT', 'UPDATE'].includes(type)) {
    return res.json({ ok: true, note: 'ignored' });
  }

  const { discord_id, tier, subscription_status } = record;
  if (!discord_id) return res.json({ ok: true, note: 'no discord_id' });

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discord_id).catch(() => null);

    if (!member) {
      console.log(`[webhook] Member ${discord_id} not found in server — skipping role assignment`);
      return res.json({ ok: true, note: 'member_not_in_server' });
    }

    if (subscription_status === 'active' && tier && ROLE_IDS[tier]) {
      await assignRole(member, tier);
      await sendDM(member,
        `**Your Vendora ${TIER_NAMES[tier]} subscription is active!**\n\n` +
        `✓ Role: **${TIER_NAMES[tier]}**\n` +
        `✓ Billing: ${TIER_PRICES[tier]}/month\n\n` +
        `Manage your account: ${DASHBOARD}`
      );
    } else if (subscription_status === 'inactive' || subscription_status === 'cancelled') {
      await assignRole(member, null);
      await sendDM(member,
        `**Your Vendora subscription has ended.**\n\n` +
        `Your access role has been removed.\n` +
        `Resubscribe anytime: ${DASHBOARD}`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PayPal webhook — subscription cancelled/suspended/expired
app.post('/paypal-webhook', async (req, res) => {
  const eventType = req.body?.event_type;
  const subId     = req.body?.resource?.id;
  console.log('[paypal] Event:', eventType, '| sub:', subId);

  const cancelEvents = [
    'BILLING.SUBSCRIPTION.CANCELLED',
    'BILLING.SUBSCRIPTION.SUSPENDED',
    'BILLING.SUBSCRIPTION.EXPIRED',
  ];

  if (!cancelEvents.includes(eventType) || !subId) return res.json({ ok: true });

  const { data, error } = await updateProfile('paypal_subscription_id', subId, {
    subscription_status: 'inactive',
    tier: 'none',
    paypal_subscription_id: null,
  });

  if (error) {
    console.error('[paypal] Failed to update profile:', error);
    return res.status(500).json({ error });
  }

  console.log(`[paypal] Marked ${subId} inactive — rows: ${data?.length || 0}`);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[http] Listening on port ${PORT}`);
});

if (TOKEN) {
  client.login(TOKEN).catch(err => {
    console.error('[discord] Login failed:', err.message);
  });
} else {
  console.error('[discord] Cannot login — DISCORD_BOT_TOKEN missing');
}
