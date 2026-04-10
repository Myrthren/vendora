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
const GUILD_ID          = process.env.DISCORD_GUILD_ID;
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET;
const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://fqfanqtybvnurhzkoxwr.supabase.co';
const SUPABASE_SVC_KEY  = process.env.SUPABASE_SERVICE_KEY;
const PORT              = process.env.PORT || 3000;

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
  const toRemove = Object.values(ROLE_IDS).filter(id => member.roles.cache.has(id));
  if (toRemove.length) await member.roles.remove(toRemove);
  if (tier && ROLE_IDS[tier]) await member.roles.add(ROLE_IDS[tier]);
}

async function sendDM(member, message) {
  try {
    await member.send(message);
  } catch {
    console.log(`Could not DM ${member.user.tag} — DMs may be closed`);
  }
}

// Update a profile in Supabase (used by PayPal webhook handler)
async function updateProfile(filter, data) {
  if (!SUPABASE_SVC_KEY) {
    console.warn('SUPABASE_SERVICE_KEY not set — cannot update profiles from PayPal webhook');
    return { error: 'No service key' };
  }
  const params = Object.entries(filter).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?${params}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SVC_KEY,
      'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  if (!res.ok) return { error: text };
  return { data: JSON.parse(text || '[]') };
}

// ── Supabase webhook (profile INSERT / UPDATE) ───────────────────────────────
app.post('/webhook', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, record } = req.body;
  if (!['INSERT', 'UPDATE'].includes(type)) return res.json({ ok: true });

  const { discord_id, tier, subscription_status } = record;
  if (!discord_id) return res.json({ ok: true });

  try {
    const guild  = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discord_id).catch(() => null);

    if (!member) {
      console.log(`Member ${discord_id} not in server — role skipped. They should join: https://discord.gg/ZVrDuxjQFM`);
      // Still acknowledge — the Supabase row is correct, they just need to join the server
      return res.json({ ok: true, note: 'member_not_in_server' });
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
      await assignRole(member, null);
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

// ── PayPal webhook (subscription cancelled / suspended / expired) ────────────
// Register this URL in PayPal Developer → Webhooks:
//   https://vendora-production-8a47.up.railway.app/paypal-webhook
// Events to subscribe: BILLING.SUBSCRIPTION.CANCELLED, BILLING.SUBSCRIPTION.SUSPENDED,
//                      BILLING.SUBSCRIPTION.EXPIRED, BILLING.SUBSCRIPTION.PAYMENT.FAILED
app.post('/paypal-webhook', async (req, res) => {
  const eventType = req.body?.event_type;
  const subId     = req.body?.resource?.id;

  console.log(`PayPal event: ${eventType} — sub ${subId}`);

  const cancelEvents = [
    'BILLING.SUBSCRIPTION.CANCELLED',
    'BILLING.SUBSCRIPTION.SUSPENDED',
    'BILLING.SUBSCRIPTION.EXPIRED',
  ];

  if (!cancelEvents.includes(eventType) || !subId) {
    return res.json({ ok: true });
  }

  // Find the user by PayPal subscription ID and mark inactive
  // This will trigger the Supabase database webhook which calls /webhook above
  const { data, error } = await updateProfile(
    { paypal_subscription_id: subId },
    { subscription_status: 'inactive', tier: 'none', paypal_subscription_id: null }
  );

  if (error) {
    console.error('Failed to update profile for cancelled sub:', subId, error);
    return res.status(500).json({ error });
  }

  console.log(`✓ Marked ${subId} inactive (${eventType}), affected rows: ${data?.length || 0}`);
  res.json({ ok: true });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'Vendora bot running' }));

// ── Start ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`✓ Webhook server listening on port ${PORT}`));
