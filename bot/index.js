process.on('uncaughtException',  err => console.error('[crash] uncaughtException:', err));
process.on('unhandledRejection', err => console.error('[crash] unhandledRejection:', err));

console.log('[boot] Loading modules...');

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ChannelType,
  PermissionFlagsBits, PermissionsBitField,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cron     = require('node-cron');
const crypto   = require('crypto');

// undici fetch — used for the primary PROXY_URL agent (non-Apify path).
// Apify proxy now uses a raw http.CONNECT implementation (see apifyVFetch).
let ProxyAgent, undFetch;
try { ({ ProxyAgent, fetch: undFetch } = require('undici')); }
catch (e) { console.warn('[proxy] undici unavailable — primary proxy disabled:', e.message); }

const nodeHttp  = require('http');
const nodeHttps = require('https');

// Vinted browser flow (Playwright + stealth) — bypasses DataDome by running
// inside a real Chromium through the residential proxy. Optional dep:
// if playwright isn't installed, functions return { error } and we fall back
// to the legacy vFetch path (which will fail on bot-protected endpoints).
let vintedBrowser = null;
try { vintedBrowser = require('./vinted-browser'); console.log('[vinted] browser flow loaded'); }
catch (e) { console.warn('[vinted] browser flow disabled:', e.message); }

console.log('[boot] Modules loaded');

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID       = process.env.DISCORD_GUILD_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://fqfanqtybvnurhzkoxwr.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY       = process.env.OPENAI_API_KEY;
const BRAVE_KEY        = process.env.BRAVE_SEARCH_API_KEY;
const REMOVE_BG_KEY    = process.env.REMOVE_BG_API_KEY;
const PHOTOROOM_KEY    = process.env.PHOTOROOM_API_KEY;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET    = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE      = process.env.PAYPAL_MODE || 'live'; // 'sandbox' or 'live'
// Whop — alternative checkout, runs alongside PayPal. See sql/whop-integration.sql
const WHOP_API_KEY        = process.env.WHOP_API_KEY;        // server-side API key (checkout sessions)
const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET; // "whsec_..." from the Whop dashboard
const PROXY_URL        = process.env.PROXY_URL; // optional residential proxy e.g. http://user:pass@host:port
const APIFY_TOKEN      = process.env.APIFY_API_TOKEN; // Apify API key for Vinted Scraper & Monitor

// Create ONE shared proxy agent — reusing it keeps the same exit IP across a full Vinted session.
// Chrome-like TLS cipher configuration to avoid JA3 fingerprint detection by DataDome.
const CHROME_CIPHERS = [
  'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA',
].join(':');
const CHROME_SIGALGS = 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512';

let PROXY_AGENT = null;
if (PROXY_URL && ProxyAgent) {
  try {
    // undici ProxyAgent object-form does NOT auto-parse credentials from the URI —
    // they must be passed explicitly via `token` as a Basic auth header.
    const _pu = new URL(PROXY_URL);
    const _proxyUri   = `${_pu.protocol}//${_pu.host}`;
    const _proxyToken = (_pu.username && _pu.password)
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(_pu.username)}:${decodeURIComponent(_pu.password)}`).toString('base64')
      : undefined;
    PROXY_AGENT = new ProxyAgent({
      uri:     _proxyUri,
      token:   _proxyToken,
      connect: { ciphers: CHROME_CIPHERS, sigalgs: CHROME_SIGALGS },
    });
    console.log(`[proxy] Proxy agent ready — ${_proxyUri} (auth=${!!_proxyToken})`);
  } catch (e) {
    console.error('[proxy] Failed to create ProxyAgent:', e.message);
  }
} else if (PROXY_URL && !ProxyAgent) {
  console.warn('[proxy] PROXY_URL is set but undici ProxyAgent failed to load — proxy DISABLED');
}

// Apify proxy — routes Vinted API calls through Apify's proxy network via raw
// http.CONNECT tunnelling (no undici ProxyAgent — it gives zero diagnostics on failure).
// Username "auto" works on every Apify plan; "groups-RESIDENTIAL" requires a paid add-on.
//
// IMPORTANT: proxy password ≠ API token. Find it at:
// Apify Console → Settings → Integrations → Proxy password
const APIFY_PROXY_PASSWORD = process.env.APIFY_PROXY_PASSWORD || APIFY_TOKEN;
const APIFY_PROXY_READY    = !!APIFY_PROXY_PASSWORD;
if (APIFY_PROXY_READY) {
  const usingApiToken = !process.env.APIFY_PROXY_PASSWORD;
  console.log(`[apify-proxy] Apify proxy configured — username=auto, password length=${APIFY_PROXY_PASSWORD.length}${usingApiToken ? ' — WARNING: using APIFY_API_TOKEN as proxy password (set APIFY_PROXY_PASSWORD instead)' : ''}`);
} else {
  console.warn('[apify-proxy] APIFY_PROXY_PASSWORD not set — Apify proxy disabled');
}

const PORT            = process.env.PORT || 3000;
const OWNER_ID       = '731207920007643167';
const DASHBOARD_URL  = 'https://vendora.site/vendora-dashboard';
const SITE_URL       = 'https://vendora.site';

console.log('[boot] Config — GUILD_ID:', GUILD_ID, '| PORT:', PORT);
if (!TOKEN)         console.warn('[warn] DISCORD_BOT_TOKEN not set');
if (!GUILD_ID)      console.warn('[warn] DISCORD_GUILD_ID not set');
if (!SUPABASE_KEY)  console.warn('[warn] SUPABASE_SERVICE_KEY not set');
if (!ANTHROPIC_KEY)    console.warn('[warn] ANTHROPIC_API_KEY not set — AI commands will fail');
if (!OPENAI_KEY)       console.warn('[warn] OPENAI_API_KEY not set — AI photo enhancement will fail');
if (!PHOTOROOM_KEY)    console.warn('[warn] PHOTOROOM_API_KEY not set — PhotoRoom enhancement will fail');
if (!PAYPAL_CLIENT_ID) console.warn('[warn] PAYPAL_CLIENT_ID not set — credit purchases will fail');
if (!PAYPAL_SECRET)    console.warn('[warn] PAYPAL_CLIENT_SECRET not set — credit purchases will fail');
if (!APIFY_TOKEN)      console.warn('[warn] APIFY_API_TOKEN not set — Vinted Apify scraping disabled');
if (!WHOP_WEBHOOK_SECRET) console.warn('[warn] WHOP_WEBHOOK_SECRET not set — Whop webhooks will be REJECTED');
if (!WHOP_API_KEY)        console.warn('[warn] WHOP_API_KEY not set — Whop checkout falls back to unmatched plan links');

// ── Anthropic ─────────────────────────────────────────────────────────────────
const ai = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});
client.on('error', err => console.error('[discord] Client error:', err));

// ── Constants ─────────────────────────────────────────────────────────────────
const ROLE_IDS = {
  basic: '1491388683327242290',
  pro:   '1491389600852349061',
  elite: '1491389713607823420',
};
const TIER_NAMES  = { none: 'Free', basic: 'Basic', pro: 'Pro', elite: 'Elite' };
const TIER_PRICES = { basic: '£9.99', pro: '£24.99', elite: '£49.99' };
const TIER_RANK   = { none: 0, basic: 1, pro: 2, elite: 3 };
const TIER_COLOR  = { basic: '#60a5fa', pro: '#e8217a', elite: '#e8a121' };

// Whop plan id -> Vendora tier. Env-driven so plan ids can change without a redeploy.
// Find these on the plan inside your Whop product (they look like "plan_XXXXXXXX").
const WHOP_PLAN_TIERS = {
  [process.env.WHOP_PLAN_BASIC || '']: 'basic',
  [process.env.WHOP_PLAN_PRO   || '']: 'pro',
  [process.env.WHOP_PLAN_ELITE || '']: 'elite',
};
delete WHOP_PLAN_TIERS['']; // drop the placeholder key when a plan id is unset

// Whop membership statuses that mean "this person has paid and should have access".
// Full enum: trialing, active, past_due, completed, canceled, expired, unresolved,
// drafted, canceling. Note "canceling" IS entitled — they cancelled but the period
// they already paid for has not ended yet. Whop sends membership.deactivated when
// it actually lapses. "past_due" is deliberately NOT entitled.
const WHOP_ACTIVE_STATUSES = new Set(['trialing', 'active', 'completed', 'canceling']);

// ── Rate limits ───────────────────────────────────────────────────────────────
const RATE_LIMITS = {
  scan:      { basic: 5,  pro: 50,  elite: Infinity },
  reply:     { basic: 20, pro: 100, elite: Infinity },
  research:  { basic: 3,  pro: 20,  elite: Infinity },
  flip:      { basic: 0,  pro: 0,   elite: 20       },
  default:   { basic: 10, pro: 50,  elite: Infinity },
};
const CMD_RATE_GROUP = {
  scan: 'scan', research: 'research', margins: 'research',
  sold: 'research', competitor: 'research', trends: 'research',
  reply: 'reply', lowball: 'reply', price: 'reply',
  pricedrop: 'default',
  'vinted-alert': 'default',
  flip: 'flip',
};
const CMD_TIER_REQUIRED = {
  scan: 'pro', research: 'pro', margins: 'pro',
  pricedrop: 'pro', trends: 'pro', tracker: 'pro', sold: 'pro', competitor: 'pro',
  'vinted-alert': 'pro',
  flip: 'elite', analytics: 'elite', earlydeals: 'elite',
  negotiate: 'elite', authenticate: 'elite', grade: 'elite',
};

// ── Bot feature toggles (defaults — overwritten by Supabase on boot) ──────────
const BOT_TOGGLES = {
  bot_online:          true,
  session_auto_delete: true,
  join_dm:             true,
  share_detection:     true,
  ticket_close_roles:  [], // Array of role IDs allowed to use /ticket close
};

// In-memory rate limit store: Map<discordId, Map<group, { count, resetAt }>>
const usageStore = new Map();

// In-memory ticket store: ticketId -> { discordId, username, message, subject, createdAt }
const ticketStore = new Map();
setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [id, t] of ticketStore) { if (t.createdAt < cutoff) ticketStore.delete(id); }
}, 60 * 60 * 1000);

function checkRateLimit(discordId, commandName, tier) {
  const group     = CMD_RATE_GROUP[commandName] || 'default';
  const limits    = RATE_LIMITS[group] || RATE_LIMITS.default;
  const tierLimit = limits[tier] ?? limits.basic;

  if (tierLimit === 0)        return { allowed: false, reason: 'tier_blocked' };
  if (tierLimit === Infinity) return { allowed: true };

  const now = Date.now();
  if (!usageStore.has(discordId)) usageStore.set(discordId, new Map());
  const store = usageStore.get(discordId);
  const entry = store.get(group);

  if (!entry || now >= entry.resetAt) {
    store.set(group, { count: 1, resetAt: now + 86_400_000 });
    return { allowed: true, used: 1, limit: tierLimit };
  }
  if (entry.count >= tierLimit) {
    return { allowed: false, reason: 'limit_reached', resetIn: Math.ceil((entry.resetAt - now) / 3_600_000), limit: tierLimit };
  }
  entry.count++;
  return { allowed: true, used: entry.count, limit: tierLimit };
}

// ── Session system ────────────────────────────────────────────────────────────
// Map<discordId, { channelId, warnTimer, deleteTimer }>
const activeSessions = new Map();
const SESSION_MS     = 24 * 3600_000;
const WARN_MS        = 23 * 3600_000;

async function deleteSessionChannel(discordId, channelId, reason = 'inactivity') {
  activeSessions.delete(discordId);
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send({ embeds: [
        new EmbedBuilder().setColor('#f87171')
          .setDescription('**Session closed.** This channel is being deleted.')
          .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
      ]});
      await channel.delete(`Session ${reason}`);
      console.log(`[session] Deleted channel ${channelId} for ${discordId} (${reason})`);
    }
  } catch (e) {
    console.error('[session] Delete error:', e.message);
  }
}

function scheduleSessionDelete(discordId, channelId) {
  const existing = activeSessions.get(discordId);
  if (existing) {
    clearTimeout(existing.warnTimer);
    clearTimeout(existing.deleteTimer);
  }

  const warnTimer = setTimeout(async () => {
    try {
      const guild  = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (member) {
        await member.send({
          embeds: [new EmbedBuilder().setColor('#e8a121')
            .setTitle('Session Closing Soon')
            .setDescription('Your Vendora session channel will be automatically deleted in **1 hour** due to inactivity.\n\nRun any command in your session to reset the timer, or use `/session close` to close it manually.')
            .setFooter({ text: 'Vendora — The Reseller\'s Edge' })]
        });
      }
    } catch (e) { /* DMs closed */ }
  }, WARN_MS);

  const deleteTimer = setTimeout(() => deleteSessionChannel(discordId, channelId, 'inactivity'), SESSION_MS);

  activeSessions.set(discordId, { channelId, warnTimer, deleteTimer });
}

// ── Embed builders ────────────────────────────────────────────────────────────
function baseEmbed(color = '#e8217a') {
  return new EmbedBuilder().setColor(color).setFooter({ text: 'Vendora — The Reseller\'s Edge' });
}

function unsubscribedEmbed() {
  return baseEmbed('#f87171')
    .setTitle('Subscription Required')
    .setDescription(`This command requires an active Vendora subscription.\n\n**Get access from £9.99/month** at ${SITE_URL}`)
    .addFields({ name: 'Plans', value: '**Basic** £9.99 · **Pro** £24.99 · **Elite** £49.99' });
}

function tierGateEmbed(command, requiredTier) {
  return baseEmbed('#e8a121')
    .setTitle(`/${command} — ${TIER_NAMES[requiredTier]} Required`)
    .setDescription(`This feature requires **Vendora ${TIER_NAMES[requiredTier]}** (${TIER_PRICES[requiredTier]}/mo).\n\nUpgrade at ${DASHBOARD_URL}`);
}

function rateLimitEmbed(command, tier, rl) {
  let desc = `You've reached your **${TIER_NAMES[tier]}** daily limit for \`/${command}\` (${rl.limit}/day).`;
  if (rl.resetIn) desc += `\n\nResets in approximately **${rl.resetIn} hour${rl.resetIn !== 1 ? 's' : ''}**.`;
  if (tier !== 'elite') desc += `\n\nUpgrade for higher limits: ${DASHBOARD_URL}`;
  return baseEmbed('#60a5fa').setTitle('Daily Limit Reached').setDescription(desc);
}

function aiUnavailableEmbed() {
  return baseEmbed('#f87171').setTitle('AI Unavailable').setDescription('The AI service is currently unavailable. Please try again later.');
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function getProfileByDiscordId(discordId) {
  if (!SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?discord_id=eq.${discordId}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    return data[0] || null;
  } catch { return null; }
}

async function getProfileByUserId(uuid) {
  if (!SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${uuid}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    return data[0] || null;
  } catch { return null; }
}

async function updateProfile(filterKey, filterVal, data) {
  if (!SUPABASE_KEY) return { error: 'no key' };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?${filterKey}=eq.${encodeURIComponent(filterVal)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(data),
      }
    );
    const text = await res.text();
    if (!res.ok) return { error: text };
    return { data: JSON.parse(text || '[]') };
  } catch (e) { return { error: e.message }; }
}

// ── Discord helpers ───────────────────────────────────────────────────────────
async function assignRole(member, tier) {
  const allIds  = Object.values(ROLE_IDS);
  const toRemove = allIds.filter(id => member.roles.cache.has(id));
  if (toRemove.length) await member.roles.remove(toRemove);
  if (tier && ROLE_IDS[tier]) {
    await member.roles.add(ROLE_IDS[tier]);
    console.log(`[roles] ${tier} assigned to ${member.user.tag}`);
  }
}

async function sendDM(member, content) {
  try {
    await member.send(content);
    console.log(`[dm] Sent DM to ${member.user.tag}`);
  } catch (e) {
    console.log(`[dm] Could not DM ${member.user.tag}: ${e.message}`);
  }
}

async function sendOwnerDM(guild, content) {
  try {
    const owner = await guild.members.fetch(OWNER_ID).catch(() => null);
    if (owner) await owner.send(content);
  } catch (e) {
    console.log('[dm] Could not DM owner:', e.message);
  }
}

// Send a Vendora-branded embed DM to a user when credits are added (purchase / code / admin grant)
async function sendCreditsDM(discordId, creditsAdded, newBalance, source = 'purchase') {
  if (!discordId || !creditsAdded) return;
  try {
    const guild  = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) { console.log(`[credits-dm] ${discordId} not in server`); return; }

    const sourceLine = {
      purchase: 'Payment received — credits are now available in your account.',
      code:     'Your redemption code has been applied.',
      admin:    'Credits have been granted to your account by the Vendora team.',
    }[source] || 'Credits added to your account.';

    const title = {
      purchase: 'Credits Purchased',
      code:     'Code Redeemed',
      admin:    'Credits Granted',
    }[source] || 'Credits Added';

    await sendDM(member, { embeds: [
      new EmbedBuilder()
        .setColor('#e8217a')
        .setTitle(`⚡ ${title}`)
        .setDescription(sourceLine)
        .addFields(
          { name: 'Credits Added',  value: `**+${creditsAdded.toLocaleString()}**`, inline: true },
          { name: 'New Balance',    value: `**${newBalance.toLocaleString()}**`,    inline: true },
        )
        .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
        .setTimestamp()
    ]});
  } catch (e) {
    console.log('[credits-dm] Error:', e.message);
  }
}

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(system, user, model = 'claude-haiku-4-5-20251001', maxTokens = 800) {
  if (!ai) return null;
  try {
    const msg = await ai.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return msg.content[0]?.text || null;
  } catch (e) {
    console.error('[ai] Error:', e.message);
    return null;
  }
}

async function callAIWithImage(system, userText, imageUrl, model = 'claude-opus-4-6') {
  if (!ai) return null;
  try {
    const imgRes  = await fetch(imageUrl);
    const imgBuf  = await imgRes.arrayBuffer();
    const b64     = Buffer.from(imgBuf).toString('base64');
    const mime    = imgRes.headers.get('content-type') || 'image/jpeg';
    const msg = await ai.messages.create({
      model,
      max_tokens: 800,
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          { type: 'text',  text: userText },
        ],
      }],
    });
    return msg.content[0]?.text || null;
  } catch (e) {
    console.error('[ai] Image error:', e.message);
    return null;
  }
}

// ── Platform search ───────────────────────────────────────────────────────────
async function searchDepop(query) {
  try {
    const url = `https://api.depop.com/api/v1/search/products/?q=${encodeURIComponent(query)}&country=gb&currency=GBP&sort=relevance&itemsPerPage=12`;
    const res = await fetch(url, vintedProxyOpts({
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }));
    if (!res.ok) return null;
    const data = await res.json();
    return (data.objects || []).map(o => ({
      title:    o.description || o.slug || '',
      price:    o.pricing?.priceAmount ? `£${(o.pricing.priceAmount / 100).toFixed(2)}` : '—',
      url:      `https://www.depop.com/products/${o.slug}/`,
      condition: o.sizeInfo?.condition || '',
    }));
  } catch (e) {
    console.log('[depop] Search failed:', e.message);
    return null;
  }
}

// ── Apify Vinted Scraper ──────────────────────────────────────────────────────
// Two separate actors:
//   APIFY_VINTED_ACTOR      — keyword search (Auto-Buy, /vinted-alert, /scan)
//   APIFY_VINTED_USER_ACTOR — user profile/member page item fetching (inventory)
// Override either via Railway env vars. Format: "username~actor-name".
const APIFY_VINTED_ACTOR      = process.env.APIFY_VINTED_ACTOR      || 'kazkn~vinted-smart-scraper';
const APIFY_VINTED_USER_ACTOR = process.env.APIFY_VINTED_USER_ACTOR || 'kazkn~vinted-smart-scraper';

// Run the configured Apify Vinted actor/task with a given input object.
// Handles both Actor ("user~name") and Task ("user~name-task") endpoints —
// tries the actor endpoint first, falls back to the task endpoint on 404.
// Returns the dataset array, or null on failure.
async function apifyRunVinted(input, timeoutSec = 90) {
  if (!APIFY_TOKEN) return null;
  const rawId   = APIFY_VINTED_ACTOR;
  const tildeId = rawId.replace('/', '~');
  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeoutSec + 5) * 1000),
  };
  // Try, in order: configured actor → configured task → configured+"-task" →
  // the canonical kazkn actor (always available; the account rents it).
  // This survives a misconfigured APIFY_VINTED_ACTOR env var (e.g. the name
  // set to the actor slug when only the Task exists, or vice-versa).
  const ids = [...new Set([
    tildeId,
    tildeId.endsWith('-task') ? tildeId : `${tildeId}-task`,
    'kazkn~vinted-smart-scraper',
  ])];
  const candidates = [];
  for (const id of ids) {
    candidates.push(`https://api.apify.com/v2/acts/${id}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutSec}`);
    candidates.push(`https://api.apify.com/v2/actor-tasks/${id}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutSec}`);
  }
  for (const url of candidates) {
    try {
      const res = await fetch(url, fetchOpts);
      if (res.status === 404) { continue; } // wrong endpoint type for this id — try next
      if (!res.ok) { console.warn(`[apify] run failed (${res.status}) at ${url.split('?')[0]}`); continue; }
      const data = await res.json();
      if (Array.isArray(data)) {
        if (!url.includes(rawId.replace('/','~'))) console.warn(`[apify] note: fell back to ${url.split('/').slice(5,6)} — fix APIFY_VINTED_ACTOR`);
        return data;
      }
    } catch (e) {
      console.warn('[apify] run error:', e.message);
    }
  }
  console.warn('[apify] all actor/task candidates failed');
  return null;
  return null;
}

// Build currency symbols from char codes so they're immune to any source-file
// encoding issue at runtime (the deployed runtime mangles non-ASCII literals).
const SYM_GBP = String.fromCharCode(163);   // £
const SYM_EUR = String.fromCharCode(8364);  // €

// Map a kazkn/vinted-smart-scraper output item to our internal shape.
function mapApifyVintedItem(i) {
  const photo = Array.isArray(i.photos) ? (i.photos[0] || '')
    : (i.photo || i.photoUrl || i.thumbnailUrl || '');
  const cur = (i.currency || '').toUpperCase();
  const sym = cur === 'GBP' ? SYM_GBP : cur === 'EUR' ? SYM_EUR : (cur ? cur + ' ' : SYM_GBP);
  const num = parseFloat(i.price ?? i.priceNumeric ?? 0) || 0;
  return {
    id:        String(i.id || i.itemId || ''),
    title:     i.title || i.name || '',
    price:     num ? `${sym}${num.toFixed(2)}` : '—',
    priceNum:  num,
    currency:  cur || 'GBP',
    url:       i.url || i.itemUrl || '',
    brand:     i.brand || i.brandTitle || '',
    condition: i.condition || i.status || '',
    photo,
    sellerName: i.seller?.username || '',
    sellerId:   String(i.seller?.id || ''),
  };
}

// Keyword search via the Vinted actor's SEARCH mode (no Vinted token needed —
// uses Apify residential proxies). Powers Auto-Buy, /vinted-alert, /scan.
async function apifyVintedSearch(query, maxItems = 12) {
  if (!APIFY_TOKEN) return null;
  const items = await apifyRunVinted({
    mode: 'SEARCH',
    query,
    countries: ['uk'],
    maxItems,
    includePhotos: true,
  }, 90);
  if (!Array.isArray(items)) return null;
  return items.slice(0, maxItems).map(mapApifyVintedItem);
}

// Fetch a single Vinted item's live details via the actor's ITEM_DETAIL mode.
// Returns { title, price, size, currency } or null. Powers watchlist tracking.
async function apifyVintedItemDetail(url) {
  if (!APIFY_TOKEN || !url) return null;
  const items = await apifyRunVinted({ mode: 'ITEM_DETAIL', itemUrls: [url], includePhotos: false }, 60);
  if (!Array.isArray(items) || !items.length) return null;
  const m = mapApifyVintedItem(items[0]);
  if (!m.priceNum) return null;
  return { title: m.title, price: m.priceNum, size: items[0].size || '', currency: m.currency || 'GBP' };
}

// Fetch a specific Vinted item by URL or ID via Apify residential proxy.
// Used by the watchlist cron to track price changes on individual Vinted listings.
async function apifyVintedFetchItem(itemIdOrUrl) {
  let itemId = String(itemIdOrUrl || '');
  const m = itemId.match(/\/items\/(\d+)/);
  if (m) itemId = m[1];
  if (!/^\d+$/.test(itemId)) return null;
  try {
    // Try Apify proxy route first — bypasses DataDome without browser
    const bases = ['https://www.vinted.co.uk', 'https://www.vinted.fr'];
    for (const base of bases) {
      const res = APIFY_PROXY_READY
        ? await apifyVFetch(`${base}/api/v2/items/${itemId}`, {
            headers: { ...VINTED_HEADERS('', base), Authorization: undefined },
            timeout: 15000,
          })
        : null;
      if (res?.ok) {
        const data = await res.json();
        if (data?.item) return data.item;
      }
    }
    return null;
  } catch (e) {
    console.warn('[apify-item] fetch failed:', e.message);
    return null;
  }
}

async function searchVinted(query) {
  // Try Apify first — bypasses DataDome via residential proxies
  if (APIFY_TOKEN) {
    const apifyResults = await apifyVintedSearch(query, 12);
    if (apifyResults?.length) return apifyResults;
  }
  // Fallback: direct Vinted API (may be blocked by DataDome)
  try {
    const url = `https://www.vinted.co.uk/api/v2/catalog/items?search_text=${encodeURIComponent(query)}&per_page=12&order=newest_first`;
    const res = await fetch(url, vintedProxyOpts({
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }));
    if (!res.ok) return null;
    const data = await res.json();
    return (data.items || []).map(i => ({
      id:        String(i.id || ''),
      title:     i.title || '',
      price:     i.total_item_price ? `£${i.total_item_price.amount}` : '—',
      priceNum:  parseFloat(i.total_item_price?.amount || 0) || 0,
      url:       i.url || '',
      brand:     i.brand_title || '',
      condition: i.status || '',
      photo:     i.photo?.url || '',
    }));
  } catch (e) {
    console.log('[vinted] Search failed:', e.message);
    return null;
  }
}

async function searchEbay(query) {
  const appId = process.env.EBAY_APP_ID;
  if (!appId) return null;
  try {
    const url = `https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findItemsByKeywords&SERVICE-VERSION=1.0.0&SECURITY-APPNAME=${appId}&RESPONSE-DATA-FORMAT=JSON&keywords=${encodeURIComponent(query)}&paginationInput.entriesPerPage=12&outputSelector=SellingStatus,PictureURLSuperSize`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item || [];
    return items.map(i => ({
      title:    i.title?.[0] || '',
      price:    i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] ? `£${parseFloat(i.sellingStatus[0].currentPrice[0]['__value__']).toFixed(2)}` : '—',
      url:      i.viewItemURL?.[0] || '',
      condition: i.condition?.[0]?.conditionDisplayName?.[0] || '',
    }));
  } catch (e) {
    console.log('[ebay] Search failed:', e.message);
    return null;
  }
}

// ── Web search (Brave) ────────────────────────────────────────────────────────
async function webSearch(query, count = 5) {
  if (!BRAVE_KEY) return null;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&country=gb&search_lang=en&safesearch=off`,
      {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.web?.results || []).map(r => ({
      title:       r.title || '',
      description: r.description || '',
      url:         r.url || '',
    }));
  } catch (e) {
    console.warn('[search] Brave web search failed:', e.message);
    return null;
  }
}

// ── Brave Image Search ────────────────────────────────────────────────────────
async function braveImageSearch(query, count = 5) {
  if (!BRAVE_KEY) return null;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=${count}&safesearch=off&country=gb`,
      {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.results || []).map(r => ({
      title:    r.title || '',
      imageUrl: r.thumbnail?.src || r.properties?.url || '',
      pageUrl:  r.url || '',
      source:   r.source || '',
    }));
  } catch (e) {
    console.warn('[search] Brave image search failed:', e.message);
    return null;
  }
}

// ── Brave News Search ─────────────────────────────────────────────────────────
async function braveNewsSearch(query, count = 4) {
  if (!BRAVE_KEY) return null;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=${count}&country=gb`,
      {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.results || []).map(r => ({
      title:       r.title || '',
      description: r.description || '',
      url:         r.url || '',
      age:         r.age || '',
    }));
  } catch (e) {
    console.warn('[search] Brave news search failed:', e.message);
    return null;
  }
}

function formatWebResults(results) {
  if (!results?.length) return '';
  return results.slice(0, 5).map(r =>
    `• ${r.title}: ${r.description.slice(0, 120)}`
  ).join('\n');
}

async function searchDepopSeller(username) {
  try {
    const BASE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' };
    const userRes = await fetch(`https://api.depop.com/api/v1/users/${encodeURIComponent(username)}/`,
      vintedProxyOpts({ headers: BASE_HEADERS, signal: AbortSignal.timeout(10000) }));
    if (!userRes.ok) return null;
    const user = await userRes.json();
    const uid  = user.id;
    if (!uid) return null;
    const prodRes = await fetch(`https://api.depop.com/api/v1/users/${uid}/products/?offset=0&limit=12`,
      vintedProxyOpts({ headers: BASE_HEADERS, signal: AbortSignal.timeout(10000) }));
    if (!prodRes.ok) return null;
    const data = await prodRes.json();
    return {
      username: user.username || username,
      followers: user.followersTotal || 0,
      totalListings: user.itemsSoldTotal || 0,
      products: (data.objects || []).map(o => ({
        title:    o.description || o.slug || '',
        price:    o.pricing?.priceAmount ? `£${(o.pricing.priceAmount / 100).toFixed(2)}` : '—',
        url:      `https://www.depop.com/products/${o.slug}/`,
        condition: o.sizeInfo?.condition || '',
      })),
    };
  } catch (e) { console.log('[depop] Seller lookup failed:', e.message); return null; }
}

async function searchVintedSeller(username) {
  try {
    const BASE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' };
    const userRes = await fetch(`https://www.vinted.co.uk/api/v2/users?login=${encodeURIComponent(username)}&per_page=1`,
      vintedProxyOpts({ headers: BASE_HEADERS, signal: AbortSignal.timeout(10000) }));
    if (!userRes.ok) return null;
    const userData = await userRes.json();
    const user = userData.users?.[0];
    if (!user) return null;
    const itemsRes = await fetch(`https://www.vinted.co.uk/api/v2/users/${user.id}/items?per_page=12`,
      vintedProxyOpts({ headers: BASE_HEADERS, signal: AbortSignal.timeout(10000) }));
    if (!itemsRes.ok) return null;
    const items = await itemsRes.json();
    return {
      username: user.login || username,
      followers: user.followers_count || 0,
      totalListings: user.items_count || 0,
      products: (items.items || []).map(i => ({
        title: i.title || '',
        price: i.total_item_price ? `£${i.total_item_price.amount}` : '—',
        url:   i.url || '',
      })),
    };
  } catch (e) { console.log('[vinted] Seller lookup failed:', e.message); return null; }
}

function formatPlatformResults(results, platformName) {
  if (!results || results.length === 0) return null;
  const lines = results.slice(0, 8).map((r, i) =>
    `**${i + 1}.** ${r.title.slice(0, 60)} — **${r.price}**${r.condition ? ` · ${r.condition}` : ''}`
  );
  return lines.join('\n');
}

// Supabase JWT verification (for API endpoints called from the dashboard)
async function verifySupabaseToken(token) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── Slash command definitions ─────────────────────────────────────────────────
const commands = [
  // ── All tiers ──
  new SlashCommandBuilder().setName('reply').setDescription('Generate an AI buyer reply for a situation')
    .addStringOption(o => o.setName('situation').setDescription('Describe the buyer situation').setRequired(true)),
  new SlashCommandBuilder().setName('lowball').setDescription('Generate a professional response to a lowball offer')
    .addStringOption(o => o.setName('offer').setDescription('Describe the lowball offer').setRequired(true)),
  new SlashCommandBuilder().setName('price').setDescription('Quick AI price check for an item')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)),
  new SlashCommandBuilder().setName('help').setDescription('Get your available Vendora commands via DM'),
  new SlashCommandBuilder().setName('session').setDescription('Manage your private Vendora session channel')
    .addSubcommand(s => s.setName('open').setDescription('Open a private session channel'))
    .addSubcommand(s => s.setName('close').setDescription('Close your session channel')),

  // ── Pro+ ──
  new SlashCommandBuilder().setName('scan').setDescription('Scan a platform for underpriced listings [Pro+]')
    .addStringOption(o => o.setName('platform').setDescription('Platform to scan').setRequired(true)
      .addChoices({ name: 'eBay', value: 'ebay' }, { name: 'Depop', value: 'depop' }, { name: 'Vinted', value: 'vinted' }))
    .addStringOption(o => o.setName('item').setDescription('Item to search for').setRequired(true)),
  new SlashCommandBuilder().setName('research').setDescription('Full research report for an item [Pro+]')
    .addStringOption(o => o.setName('item').setDescription('Item to research').setRequired(true)),
  new SlashCommandBuilder().setName('margins').setDescription('Detailed profit margin breakdown [Pro+]')
    .addStringOption(o => o.setName('item').setDescription('Item to analyse').setRequired(true)),
  new SlashCommandBuilder().setName('pricedrop').setDescription('Track price drops for a product page [Pro+]')
    .addStringOption(o => o.setName('url').setDescription('Direct link to the product page (Nike, ASOS, JD Sports, Selfridges, etc.)').setRequired(true)),
  new SlashCommandBuilder().setName('vinted-alert').setDescription('Get alerted when new Vinted listings match your search [Pro+]')
    .addSubcommand(s => s.setName('add').setDescription('Add a keyword alert for Vinted')
      .addStringOption(o => o.setName('keyword').setDescription('Search term to monitor (e.g. "nike air max 90 uk9")').setRequired(true))
      .addNumberOption(o => o.setName('max_price').setDescription('Only alert if price is below this (e.g. 40)').setRequired(false)))
    .addSubcommand(s => s.setName('list').setDescription('View your active Vinted alerts'))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a Vinted alert by number (from /vinted-alert list)')
      .addIntegerOption(o => o.setName('number').setDescription('Alert number from /vinted-alert list').setRequired(true))),
  new SlashCommandBuilder().setName('trends').setDescription('Current brand/category trend report [Pro+]')
    .addStringOption(o => o.setName('category').setDescription('Category or brand name').setRequired(true)),
  new SlashCommandBuilder().setName('tracker').setDescription('Manage your inventory tracker [Pro+]')
    .addSubcommand(s => s.setName('add').setDescription('Add an item to your tracker')
      .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)))
    .addSubcommand(s => s.setName('view').setDescription('View your inventory tracker'))
    .addSubcommand(s => s.setName('remove').setDescription('Remove an item by number (shown in /tracker view)')
      .addStringOption(o => o.setName('item').setDescription('Item number from /tracker view').setRequired(true))),
  new SlashCommandBuilder().setName('sold').setDescription('Analyse what actually sells vs what just gets listed [Pro+]')
    .addStringOption(o => o.setName('item').setDescription('Item or category to analyse').setRequired(true)),
  new SlashCommandBuilder().setName('competitor').setDescription('Track a competitor seller [Pro+]')
    .addStringOption(o => o.setName('seller').setDescription('Seller username to track').setRequired(true)),

  // ── Elite ──
  new SlashCommandBuilder().setName('flip').setDescription('Full auto-flipping suggestion — source, list, price, profit [Elite]')
    .addStringOption(o => o.setName('item').setDescription('Item to flip').setRequired(true)),
  new SlashCommandBuilder().setName('analytics').setDescription('Live sales analytics for a connected platform [Elite]')
    .addStringOption(o => o
      .setName('platform')
      .setDescription('Which platform to analyse')
      .setRequired(true)
      .addChoices(
        { name: 'Vinted', value: 'vinted' },
        { name: 'All connected', value: 'all' }
      )
    ),
  new SlashCommandBuilder().setName('earlydeals').setDescription('Access current early deal alerts [Elite]'),
  new SlashCommandBuilder().setName('negotiate').setDescription('Advanced AI negotiation assistant [Elite]')
    .addStringOption(o => o.setName('offer').setDescription('Describe the negotiation scenario').setRequired(true)),
  new SlashCommandBuilder().setName('authenticate').setDescription('Authenticity red flag check from a photo [Elite]')
    .addAttachmentOption(o => o.setName('photo').setDescription('Clear photo of the item (tags, logo, hardware, stitching, etc.)').setRequired(true))
    .addStringOption(o => o.setName('item').setDescription('Item name & brand (e.g. Louis Vuitton Speedy 30)').setRequired(true))
    .addStringOption(o => o.setName('price').setDescription('Asking price (e.g. £120) — helps flag suspicious pricing').setRequired(false))
    .addStringOption(o => o.setName('source').setDescription('Where it is being sold (e.g. Vinted, eBay, Facebook)').setRequired(false)),
  new SlashCommandBuilder().setName('grade').setDescription('Grade item condition from a photo [Elite]')
    .addAttachmentOption(o => o.setName('photo').setDescription('Photo of the item').setRequired(true)),

  // ── Support ──
  new SlashCommandBuilder().setName('ticket')
    .setDescription('Ticket management')
    .addSubcommand(s => s.setName('close').setDescription('Close this support ticket')),
  new SlashCommandBuilder().setName('supportsetup')
    .setDescription('Post the Vendora support embed — one-time use, command deletes itself after'),
].map(c => c.toJSON());

// ── Inventory (persistent via Supabase) ──────────────────────────────────────
async function dbAddInventory(discordId, item) {
  if (!SUPABASE_KEY) return { error: 'no key' };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=representation' },
      body: JSON.stringify({ discord_id: discordId, item }),
    });
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

async function dbGetInventory(discordId) {
  if (!SUPABASE_KEY) return [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/inventory?discord_id=eq.${discordId}&order=added_at.asc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    return await r.json();
  } catch { return []; }
}

async function dbRemoveInventory(id) {
  if (!SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/inventory?id=eq.${id}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
  } catch {}
}

// ── Price-drop URL scraper ────────────────────────────────────────────────────
const PLATFORM_MAP = {
  'nike.com':             'Nike',
  'adidas.com':           'Adidas',
  'asos.com':             'ASOS',
  'amazon.co.uk':         'Amazon UK',
  'amazon.com':           'Amazon',
  'jdsports.co.uk':       'JD Sports',
  'jdsports.com':         'JD Sports',
  'footlocker.co.uk':     'Foot Locker',
  'footlocker.com':       'Foot Locker',
  'size.co.uk':           'Size?',
  'endclothing.com':      'END Clothing',
  'end.com':              'END Clothing',
  'farfetch.com':         'Farfetch',
  'ssense.com':           'SSENSE',
  'selfridges.com':       'Selfridges',
  'johnlewis.com':        'John Lewis',
  'zalando.co.uk':        'Zalando',
  'zalando.com':          'Zalando',
  'zara.com':             'Zara',
  'hm.com':               'H&M',
  'sportsdirect.com':     'Sports Direct',
  'schuh.co.uk':          'Schuh',
  'footasylum.com':       'Footasylum',
  'offspring.co.uk':      'Offspring',
  'office.co.uk':         'Office',
  'newbalance.com':       'New Balance',
  'newbalance.co.uk':     'New Balance',
  'next.co.uk':           'Next',
  'prettylittlething.com':'PrettyLittleThing',
  'boohoo.com':           'Boohoo',
  'revolve.com':          'Revolve',
  'gymshark.com':         'Gymshark',
  'vans.co.uk':           'Vans',
  'vans.com':             'Vans',
  'converse.com':         'Converse',
  'puma.com':             'Puma',
  'reebok.com':           'Reebok',
  'asics.com':            'Asics',
  'superdry.com':         'Superdry',
  'patagonia.com':        'Patagonia',
  'allbirds.com':         'Allbirds',
  'skechers.com':         'Skechers',
  'underarmour.com':      'Under Armour',
};

// Platforms that are known to block bots consistently
const BLOCKED_PLATFORMS = new Set(['nike.com', 'adidas.com', 'zara.com', 'hm.com', 'amazon.co.uk', 'amazon.com', 'asos.com']);

function detectPlatformFromUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    for (const [domain, name] of Object.entries(PLATFORM_MAP)) {
      if (host === domain || host.endsWith('.' + domain)) return { domain, name, likelyBlocked: BLOCKED_PLATFORMS.has(domain) };
    }
    // Unknown but valid URL — still try
    return { domain: host, name: host, likelyBlocked: false };
  } catch { return null; }
}

async function scrapeProductPage(rawUrl) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };

  const fetchOpts = { headers, redirect: 'follow' };
  if (PROXY_URL && ProxyAgent) fetchOpts.dispatcher = new ProxyAgent(PROXY_URL);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 15000);
  let html;
  try {
    const res = await fetch(rawUrl, { ...fetchOpts, signal: controller.signal });
    if (res.status === 403 || res.status === 429 || res.status === 503)
      throw new Error(`blocked:${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } finally { clearTimeout(timeout); }

  // ── 1. JSON-LD structured data ──────────────────────────────────────────────
  const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      let data = JSON.parse(m[1].trim());
      if (!Array.isArray(data)) data = [data];
      for (const node of data) {
        const nodes = node['@graph'] ? node['@graph'] : [node];
        for (const obj of nodes) {
          if (obj['@type'] !== 'Product') continue;
          const r = parseSchemaProduct(obj, rawUrl);
          if (r) return r;
        }
      }
    } catch { /* bad JSON — try next */ }
  }

  // ── 2. Shopify /products/{handle}.js ───────────────────────────────────────
  if (/shopify/i.test(html)) {
    try {
      const urlObj   = new URL(rawUrl);
      const parts    = urlObj.pathname.split('/');
      const pidx     = parts.indexOf('products');
      if (pidx !== -1 && parts[pidx + 1]) {
        const handle   = parts[pidx + 1].split('?')[0];
        const shopUrl  = `${urlObj.origin}/products/${handle}.js`;
        const sRes     = await fetch(shopUrl, { headers });
        if (sRes.ok) {
          const sj = await sRes.json();
          const r  = parseShopifyProduct(sj, rawUrl);
          if (r) return r;
        }
      }
    } catch { /* not Shopify / handle missing */ }
  }

  // ── 3. OG / meta tag fallback ──────────────────────────────────────────────
  const metaResult = parseMetaTags(html, rawUrl);
  if (metaResult?.lowestPrice) return metaResult;

  // ── 4. Embedded JSON in script tags (Next.js / Nuxt / etc.) ───────────────
  const nextData = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) {
    try {
      const nd = JSON.parse(nextData[1]);
      const r  = parseNextData(nd, rawUrl);
      if (r) return r;
    } catch { /* bad JSON */ }
  }

  throw new Error('no_data');
}

function parseSchemaProduct(product, url) {
  const name = (product.name || '').trim();
  if (!name) return null;

  const offersRaw = product.offers;
  if (!offersRaw) return null;

  const offerList = Array.isArray(offersRaw) ? offersRaw : [offersRaw];
  const variants  = [];

  for (const offer of offerList) {
    const rawPrice = offer.price ?? offer.lowPrice;
    const price    = parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));
    if (!price || isNaN(price) || price <= 0) continue;
    const currency     = offer.priceCurrency || 'GBP';
    const availability = offer.availability
      ? (String(offer.availability).toLowerCase().includes('instock') ? 'in_stock' : 'out_of_stock')
      : 'unknown';
    const size = offer.sku || offer.name || null;
    variants.push({ price, currency, availability, size: size ? String(size).slice(0, 30) : null });
  }

  // AggregateOffer fallback
  if (!variants.length) {
    const p = parseFloat(String(offersRaw.lowPrice ?? offersRaw.price ?? '').replace(/[^0-9.]/g, ''));
    if (p && p > 0) variants.push({ price: p, currency: offersRaw.priceCurrency || 'GBP', availability: 'unknown', size: null });
  }

  if (!variants.length) return null;

  const lowestPrice = Math.min(...variants.map(v => v.price));
  const image       = Array.isArray(product.image) ? product.image[0] : (typeof product.image === 'string' ? product.image : product.image?.url || null);

  return { name, variants, lowestPrice, currency: variants[0].currency, image, url };
}

function parseMetaTags(html, url) {
  const get = prop => {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    ];
    for (const re of patterns) { const m = html.match(re); if (m) return m[1]; }
    return null;
  };
  const name  = get('og:title') || get('twitter:title') || get('title');
  const price = parseFloat((get('product:price:amount') || get('og:price:amount') || get('price') || '0').replace(/[^0-9.]/g, ''));
  if (!name || !price || price <= 0) return null;
  const currency = get('product:price:currency') || get('og:price:currency') || 'GBP';
  return { name, variants: [{ price, currency, availability: 'unknown', size: null }], lowestPrice: price, currency, image: get('og:image'), url };
}

function parseShopifyProduct(product, url) {
  const name = (product.title || '').trim();
  if (!name) return null;
  const variants = (product.variants || []).map(v => {
    // Shopify /products/*.js returns price as integer cents (e.g. 8999 = £89.99)
    const raw   = parseInt(v.price, 10);
    const price = raw > 1000 ? raw / 100 : raw; // guard: already decimal on some themes
    const size  = [v.option1, v.option2].filter(Boolean).join(' / ') || v.title || null;
    return { price, currency: 'GBP', availability: v.available ? 'in_stock' : 'out_of_stock', size };
  }).filter(v => v.price > 0);
  if (!variants.length) return null;
  const lowestPrice = Math.min(...variants.map(v => v.price));
  return { name, variants, lowestPrice, currency: 'GBP', image: product.images?.[0]?.src || null, url };
}

function parseNextData(nd, url) {
  // Walk Next.js page props looking for a product object with a price field
  const walk = (obj, depth = 0) => {
    if (depth > 8 || !obj || typeof obj !== 'object') return null;
    if (obj.name && (obj.price !== undefined || obj.offers)) {
      const price = parseFloat(String(obj.price || obj.offers?.price || '').replace(/[^0-9.]/g, ''));
      if (price > 0) return { name: String(obj.name).slice(0, 200), variants: [{ price, currency: 'GBP', availability: 'unknown', size: null }], lowestPrice: price, currency: 'GBP', image: obj.image || null, url };
    }
    for (const v of Object.values(obj)) { const r = walk(v, depth + 1); if (r) return r; }
    return null;
  };
  return walk(nd);
}

// ── Watchlist (persistent via Supabase) ───────────────────────────────────────
async function dbAddWatchlist(discordId, item) {
  if (!SUPABASE_KEY) return { error: 'no key' };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=representation' },
      body: JSON.stringify({ discord_id: discordId, item }),
    });
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

async function dbGetWatchlist(discordId) {
  if (!SUPABASE_KEY) return [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/watchlist?discord_id=eq.${discordId}&order=added_at.asc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    return await r.json();
  } catch { return []; }
}

// ── Vinted Alerts (persistent via Supabase) ───────────────────────────────────
async function dbAddVintedAlert(discordId, keyword, maxPrice) {
  if (!SUPABASE_KEY) return { error: 'no key' };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vinted_alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=representation' },
      body: JSON.stringify({ discord_id: discordId, keyword, max_price: maxPrice || null, seen_ids: [] }),
    });
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

async function dbGetVintedAlerts(discordId) {
  if (!SUPABASE_KEY) return [];
  try {
    const url = discordId
      ? `${SUPABASE_URL}/rest/v1/vinted_alerts?discord_id=eq.${discordId}&order=created_at.asc`
      : `${SUPABASE_URL}/rest/v1/vinted_alerts?order=created_at.asc`;
    const r = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    const data = await r.json();
    // Supabase returns an error object (not array) if the table doesn't exist
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function dbRemoveVintedAlert(id) {
  if (!SUPABASE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/vinted_alerts?id=eq.${id}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  }).catch(() => {});
}

async function dbUpdateVintedAlertSeenIds(id, seenIds) {
  if (!SUPABASE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/vinted_alerts?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify({ seen_ids: seenIds, last_checked: new Date().toISOString() }),
  }).catch(() => {});
}

async function dbUpdateVintedAlert(id, data) {
  if (!SUPABASE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/vinted_alerts?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify(data),
  }).catch(() => {});
}

// ── Settings (persistent config in Supabase) ──────────────────────────────────
async function getSetting(key) {
  if (!SUPABASE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.${key}&select=value`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await r.json();
    return rows[0]?.value ?? null;
  } catch { return null; }
}

async function saveSetting(key, value) {
  if (!SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
  } catch {}
}

// Load persisted rate limits on startup
(async () => {
  const saved = await getSetting('rate_limits');
  if (saved) {
    for (const [group, limits] of Object.entries(saved)) {
      if (RATE_LIMITS[group]) Object.assign(RATE_LIMITS[group], limits);
    }
    console.log('[config] Loaded persisted rate limits from Supabase');
  }
  const savedToggles = await getSetting('bot_toggles');
  if (savedToggles) {
    Object.assign(BOT_TOGGLES, savedToggles);
    console.log('[config] Loaded persisted bot toggles from Supabase');
  }
})();

// ── Command executor ──────────────────────────────────────────────────────────
async function executeCommand(interaction, commandName, tier, profile) {
  const opts = interaction.options;

  // /help
  if (commandName === 'help') {
    const allCmds   = '`/reply` `//lowball` `/price` `/session open` `/session close`';
    const proCmds   = '`/scan` `/research` `/margins` `/pricedrop` `/trends` `/tracker` `/sold` `/competitor`';
    const eliteCmds = '`/flip` `/analytics` `/earlydeals` `/negotiate` `/authenticate` `/grade`';
    const e = baseEmbed(TIER_COLOR[tier] || '#e8217a')
      .setTitle(`Vendora ${TIER_NAMES[tier]} — Available Commands`)
      .addFields({ name: 'All Plans', value: allCmds, inline: false });
    if (TIER_RANK[tier] >= TIER_RANK.pro)   e.addFields({ name: 'Pro+', value: proCmds,   inline: false });
    if (TIER_RANK[tier] >= TIER_RANK.elite) e.addFields({ name: 'Elite', value: eliteCmds, inline: false });
    e.addFields({ name: 'Manage Subscription', value: DASHBOARD_URL, inline: false });
    try {
      await interaction.user.send({ embeds: [e] });
      return interaction.editReply({ embeds: [baseEmbed().setDescription('Your command list has been sent to your DMs.')] });
    } catch {
      return interaction.editReply({ embeds: [e] });
    }
  }

  // /session open
  if (commandName === 'session' && opts.getSubcommand() === 'open') {
    const existing = activeSessions.get(interaction.user.id);
    if (existing) {
      // Verify the channel still exists
      const guild = interaction.guild;
      const stillExists = guild?.channels.cache.has(existing.channelId);
      if (stillExists) {
        return interaction.editReply({ embeds: [
          baseEmbed().setTitle('Session Already Open')
            .setDescription(`You already have an active session: <#${existing.channelId}>\n\nUse \`/session close\` to close it.`)
        ]});
      }
      // Channel was deleted externally — clean up
      activeSessions.delete(interaction.user.id);
    }

    const guild = interaction.guild;
    if (!guild) {
      return interaction.editReply({ embeds: [
        baseEmbed('#f87171').setTitle('Server Only').setDescription('`/session open` can only be used inside the Vendor Village server.')
      ]});
    }

    // Check bot has ManageChannels permission — use fetchMe() to avoid stale cache
    const botMember = await guild.members.fetchMe().catch(() => guild.members.me);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply({ embeds: [
        baseEmbed('#f87171').setTitle('Missing Permission')
          .setDescription('The bot needs the **Manage Channels** permission in this server to create session channels. Please contact the server owner.')
      ]});
    }

    try {
      // Re-fetch channels to ensure cache is current
      await guild.channels.fetch();

      // Use the same category as #use-vendora so session channels sit alongside it.
      // Fall back to server root if the channel doesn't exist or the bot can't
      // manage channels inside that category.
      const useVendoraChannel = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name === 'use-vendora'
      );
      const category = useVendoraChannel?.parent ?? null;
      const canManageInCategory = category
        ? category.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)
        : false;
      const parentId = canManageInCategory ? category.id : null;

      const channelName = `session-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}-${Date.now().toString(36).slice(-4)}`;
      // Use guild.id for @everyone (its role ID always matches the guild ID)
      const permOverwrites = [
        { id: guild.id,            deny:  [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels,  PermissionFlagsBits.ReadMessageHistory] },
        { id: OWNER_ID,            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ];

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites: permOverwrites,
        topic: `Private Vendora session for ${interaction.user.tag} — auto-deletes after 24h inactivity`,
      });

      scheduleSessionDelete(interaction.user.id, channel.id);

      await channel.send({ embeds: [
        baseEmbed().setTitle(`Session Open — ${interaction.user.username}`)
          .setDescription(
            `Welcome to your private Vendora workspace, <@${interaction.user.id}>.\n\n` +
            `Run any of your tier commands here. This channel **auto-deletes after 24 hours of inactivity**.\n\n` +
            `Use \`/session close\` to close it manually.`
          )
      ]});

      try {
        await interaction.user.send({ embeds: [
          baseEmbed().setTitle('Session Channel Created')
            .setDescription(`Your private session is ready: https://discord.com/channels/${guild.id}/${channel.id}`)
        ]});
      } catch { /* DMs closed */ }

      return interaction.editReply({ embeds: [
        baseEmbed().setTitle('Session Opened ✓')
          .setDescription(`Your private channel is ready: <#${channel.id}>\n\nIt auto-deletes after 24 hours of inactivity.`)
      ]});

    } catch (err) {
      console.error('[session] Failed to create channel:', err.message);
      return interaction.editReply({ embeds: [
        baseEmbed('#f87171').setTitle('Session Failed')
          .setDescription(`Could not create your session channel.\n\n**Reason:** ${err.message}\n\nMake sure the bot has the **Manage Channels** permission and try again.`)
      ]});
    }
  }

  // /session close
  if (commandName === 'session' && opts.getSubcommand() === 'close') {
    const existing = activeSessions.get(interaction.user.id);
    if (!existing) {
      return interaction.editReply({ embeds: [baseEmbed().setDescription('You have no active session to close.')] });
    }
    clearTimeout(existing.warnTimer);
    clearTimeout(existing.deleteTimer);
    await interaction.editReply({ embeds: [baseEmbed().setDescription('Closing your session channel...')] });
    await deleteSessionChannel(interaction.user.id, existing.channelId, 'manual close');
    return;
  }

  // /tracker
  if (commandName === 'tracker') {
    const sub = opts.getSubcommand();

    if (sub === 'add') {
      const item = opts.getString('item');
      await dbAddInventory(interaction.user.id, item);
      const inv = await dbGetInventory(interaction.user.id);
      return interaction.editReply({ embeds: [
        baseEmbed().setTitle('Item Added to Tracker')
          .setDescription(`**${item}** has been added to your inventory tracker.\n\nTotal items tracked: **${inv.length}**`)
      ]});
    }
    if (sub === 'view') {
      const inv = await dbGetInventory(interaction.user.id);
      if (inv.length === 0) return interaction.editReply({ embeds: [baseEmbed().setDescription('Your inventory tracker is empty.\n\nUse `/tracker add [item]` to start tracking.')] });
      const list = inv.map((e, i) => `**${i + 1}.** ${e.item} — added ${new Date(e.added_at).toLocaleDateString('en-GB')}`).join('\n');
      return interaction.editReply({ embeds: [
        baseEmbed().setTitle('Your Inventory Tracker')
          .setDescription(list.slice(0, 4000))
          .addFields({ name: 'Total', value: `${inv.length} item${inv.length !== 1 ? 's' : ''}` })
      ]});
    }
    if (sub === 'remove') {
      const inv = await dbGetInventory(interaction.user.id);
      const idxStr = opts.getString('item');
      const idx = parseInt(idxStr) - 1;
      if (isNaN(idx) || idx < 0 || idx >= inv.length) {
        return interaction.editReply({ embeds: [baseEmbed().setDescription(`Invalid number. You have ${inv.length} item(s). Use the number shown in \`/tracker view\`.`)] });
      }
      const removed = inv[idx];
      await dbRemoveInventory(removed.id);
      return interaction.editReply({ embeds: [baseEmbed().setTitle('Item Removed').setDescription(`**${removed.item}** removed from your tracker.`)] });
    }
  }

  // /pricedrop
  if (commandName === 'pricedrop') {
    const rawUrl = opts.getString('url').trim();

    // Validate it's a URL
    let parsedUrl;
    try { parsedUrl = new URL(rawUrl); }
    catch {
      return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Invalid URL')
        .setDescription('Please paste a full product URL starting with `https://`, e.g.:\n`https://www.jdsports.co.uk/product/...`')] });
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Invalid URL').setDescription('URL must start with `https://`.')] });
    }

    const platform = detectPlatformFromUrl(rawUrl);
    if (!platform) {
      return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Unrecognised Platform')
        .setDescription('Could not identify a supported retail platform from that URL. Make sure you paste the full product page link.')] });
    }

    // Warn up-front if platform is known to block bots
    if (platform.likelyBlocked) {
      return interaction.editReply({ embeds: [baseEmbed('#e8a121').setTitle(`⚠️ ${platform.name} Blocks Automated Checks`)
        .setDescription(
          `**${platform.name}** uses bot protection that prevents Vendora from reading their prices directly.\n\n` +
          `**Platforms that work well:**\n` +
          `JD Sports · Selfridges · John Lewis · Schuh · Footasylum · Offspring · END Clothing · Size? · Sports Direct · New Balance · Gymshark · Vans · Converse · Puma · Asics · Revolve · Superdry · Zalando\n\n` +
          `If you still want to track ${platform.name}, use their app or browser price alerts instead.`
        )] });
    }

    // Send a "checking…" reply first (scraping can take a few seconds)
    await interaction.editReply({ embeds: [baseEmbed().setTitle('🔍 Fetching product data…')
      .setDescription(`Checking **${platform.name}** for price and size information…`)] });

    try {
      const product = await scrapeProductPage(rawUrl);

      // Save URL to watchlist
      await dbAddWatchlist(interaction.user.id, rawUrl);
      const wl = await dbGetWatchlist(interaction.user.id);

      // Persist baseline + full variant data
      const baselineKey = 'watchlist_price_baselines';
      const baselines   = (await getSetting(baselineKey)) || {};
      const entry       = wl.find(w => w.item === rawUrl);
      if (entry) {
        baselines[entry.id] = {
          platform:    platform.name,
          productName: product.name,
          baseline:    product.lowestPrice,
          lowestSeen:  product.lowestPrice,
          variants:    product.variants,
          currency:    product.currency,
          url:         rawUrl,
          checkedAt:   new Date().toISOString(),
        };
        await saveSetting(baselineKey, baselines);
      }

      // Build size/variant display
      const inStock = product.variants.filter(v => v.availability === 'in_stock');
      const display = (inStock.length ? inStock : product.variants).slice(0, 18);
      const variantLines = display.map(v => v.size ? `**${v.size}** — ${product.currency === 'GBP' ? '£' : product.currency}${v.price.toFixed(2)}` : `${product.currency === 'GBP' ? '£' : product.currency}${v.price.toFixed(2)}`);
      const sizeCount   = product.variants.length;

      const embed = baseEmbed('#4ade80')
        .setTitle('✅ Price Drop Alert Set')
        .addFields(
          { name: 'Product',        value: product.name.slice(0, 200), inline: true },
          { name: 'Platform',       value: platform.name,              inline: true },
          { name: 'Current lowest', value: `£${product.lowestPrice.toFixed(2)}`, inline: true },
          { name: `Sizes / variants tracked (${sizeCount})`, value: variantLines.join('\n').slice(0, 1020) || 'No size data available' },
          { name: 'Watchlist', value: `${wl.length} item${wl.length !== 1 ? 's' : ''} tracked`, inline: true },
        )
        .setFooter({ text: "You'll be alerted when any variant drops 10%+ from today's price • Checked every 6 hours" });

      if (product.image) embed.setThumbnail(product.image);

      return interaction.editReply({ embeds: [embed] });

    } catch (err) {
      const msg = err.message || '';
      const isBlocked = msg.startsWith('blocked:') || msg.includes('403') || msg.includes('429');
      const noData    = msg === 'no_data';

      return interaction.editReply({ embeds: [baseEmbed('#f87171')
        .setTitle(isBlocked ? '❌ Site Blocked Access' : noData ? '❌ No Price Data Found' : '❌ Could Not Fetch Page')
        .setDescription(
          isBlocked
            ? `**${platform.name}** blocked our request (bot protection active).\n\nThis platform requires a real browser to load prices. Try one of these instead:\n**JD Sports · Selfridges · John Lewis · Schuh · Footasylum · END Clothing · Gymshark · Vans · Puma**`
            : noData
            ? `We fetched the **${platform.name}** page but couldn't extract price data from it. The site may use JavaScript rendering to display prices.\n\nTry a different platform.`
            : `Failed to load the page from **${platform.name}**:\n\`${msg.slice(0, 200)}\`\n\nCheck the URL is a direct product page and try again.`
        )] });
    }
  }

  // /vinted-alert
  if (commandName === 'vinted-alert') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const keyword  = opts.getString('keyword').trim();
      const maxPrice = opts.getNumber('max_price') || null;

      if (!APIFY_TOKEN) {
        return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Vinted Alerts Unavailable')
          .setDescription('Vinted alert monitoring requires the Apify API. Please contact the server owner.')] });
      }

      const existing = await dbGetVintedAlerts(interaction.user.id);
      const MAX_ALERTS = TIER_RANK[profile.tier] >= 3 ? 30 : 5;
      if (existing.length >= MAX_ALERTS) {
        return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Alert Limit Reached')
          .setDescription(`You can have up to **${MAX_ALERTS}** active Vinted alerts on your plan.\n\nRemove one with \`/vinted-alert remove\` to add a new one.`)] });
      }

      await interaction.editReply({ embeds: [baseEmbed().setTitle('⏳ Setting up alert…')
        .setDescription(`Running an initial Vinted search for **"${keyword}"** to baseline your alert…`)] });

      // Run initial scan to populate seen_ids so we only alert for NEW items going forward
      const initialItems = await apifyVintedSearch(keyword, 20);
      const seenIds = (initialItems || []).map(i => i.id).filter(Boolean);

      await dbAddVintedAlert(interaction.user.id, keyword, maxPrice);
      // Grab the newly created alert and patch its seen_ids
      const alerts = await dbGetVintedAlerts(interaction.user.id);
      const newAlert = alerts.find(a => a.keyword === keyword && (!a.seen_ids?.length));
      if (newAlert) await dbUpdateVintedAlertSeenIds(newAlert.id, seenIds);

      const priceNote = maxPrice ? ` under £${maxPrice}` : '';
      return interaction.editReply({ embeds: [
        baseEmbed('#4ade80')
          .setTitle('✅ Vinted Alert Created')
          .setDescription(`You'll be DMed whenever new **"${keyword}"** listings${priceNote} appear on Vinted.`)
          .addFields(
            { name: 'Keyword',       value: keyword,                                           inline: true },
            { name: 'Max Price',     value: maxPrice ? `£${maxPrice}` : 'Any',                 inline: true },
            { name: 'Active Alerts', value: `${alerts.length} / ${MAX_ALERTS}`,               inline: true },
            { name: 'Baseline',      value: `${seenIds.length} existing listings catalogued`, inline: false },
          )
          .setFooter({ text: 'Checked every 30 minutes via Apify · /vinted-alert list to manage' }),
      ] });
    }

    if (sub === 'list') {
      const alerts = await dbGetVintedAlerts(interaction.user.id);
      if (!alerts.length) {
        return interaction.editReply({ embeds: [baseEmbed().setTitle('No Vinted Alerts')
          .setDescription('You have no active Vinted alerts.\n\nUse `/vinted-alert add` to monitor a keyword.')] });
      }
      const lines = alerts.map((a, i) =>
        `**${i + 1}.** \`${a.keyword}\`${a.max_price ? ` · Max £${a.max_price}` : ''} · ${a.seen_ids?.length || 0} seen`
      );
      return interaction.editReply({ embeds: [
        baseEmbed().setTitle('🔔 Your Vinted Alerts')
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Use /vinted-alert remove <number> to delete · Checked every 30 min' }),
      ] });
    }

    if (sub === 'remove') {
      const num    = opts.getInteger('number');
      const alerts = await dbGetVintedAlerts(interaction.user.id);
      const target = alerts[num - 1];
      if (!target) {
        return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Not Found')
          .setDescription(`No alert #${num}. Use \`/vinted-alert list\` to see your current alerts.`)] });
      }
      await dbRemoveVintedAlert(target.id);
      return interaction.editReply({ embeds: [baseEmbed('#4ade80').setTitle('✅ Alert Removed')
        .setDescription(`Removed Vinted alert for **"${target.keyword}"**.`)] });
    }
  }

  // /earlydeals
  if (commandName === 'earlydeals') {
    // Search popular resale categories on Depop + Vinted, surface significantly underpriced items
    const DEAL_QUERIES = ['nike trainers', 'stone island', 'north face', 'adidas yeezy', 'ralph lauren hoodie'];
    // Pick 3 random searches to keep response time reasonable
    const shuffled = DEAL_QUERIES.sort(() => Math.random() - 0.5).slice(0, 3);

    const allDeals = [];
    for (const q of shuffled) {
      const [dR, vR] = await Promise.all([searchDepop(q), searchVinted(q)]);
      const combined = [...(dR || []), ...(vR || [])];
      const prices   = combined.map(x => parseFloat((x.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);
      if (prices.length < 3) continue;
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const threshold = avg * 0.65; // 35% below average = a deal
      const deals = combined
        .filter(x => {
          const p = parseFloat((x.price || '').replace('£', ''));
          return !isNaN(p) && p > 0 && p <= threshold;
        })
        .map(x => ({ ...x, category: q, avg: avg.toFixed(2) }));
      allDeals.push(...deals);
    }

    // Sort by value gap (lowest price relative to avg)
    allDeals.sort((a, b) => {
      const pa = parseFloat((a.price || '').replace('£', '')) || 999;
      const pb = parseFloat((b.price || '').replace('£', '')) || 999;
      const ra = pa / parseFloat(a.avg), rb = pb / parseFloat(b.avg);
      return ra - rb;
    });

    const top = allDeals.slice(0, 8);

    if (top.length === 0) {
      return interaction.editReply({ embeds: [
        baseEmbed('#e8a121').setTitle('Early Deal Alerts — Elite')
          .setDescription('No significant deals found in the current scan. Markets are fairly priced right now — run again in a few hours for fresh data.')
          .setFooter({ text: 'Refreshes each time you run the command' })
      ]});
    }

    const lines = top.map((d, i) => {
      const p    = parseFloat((d.price || '').replace('£', ''));
      const save = (parseFloat(d.avg) - p).toFixed(2);
      return `**${i + 1}.** ${d.title.slice(0, 55)} — **${d.price}** (avg £${d.avg}, save ~£${save})\n[View listing](${d.url})`;
    });

    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121').setTitle('Early Deal Alerts — Live Scan 🔍')
        .setDescription(lines.join('\n\n').slice(0, 4000))
        .addFields({ name: 'Categories Scanned', value: shuffled.join(', ') })
        .setFooter({ text: `${top.length} deals found — 35%+ below market average | Run again for fresh results` })
    ]});
  }

  // /analytics
  if (commandName === 'analytics') {
    if (!ai) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });

    const platform = opts.getString('platform') || 'all';
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

    // ── Platform not connected early-exit ────────────────────────────────────
    if (platform !== 'all') {
      const conn = await getPlatformConn(profile.id, platform);
      if (!conn) {
        return interaction.editReply({ embeds: [
          baseEmbed('#e8217a')
            .setTitle(`${cap(platform)} Not Connected`)
            .setDescription(
              `You haven't connected your **${cap(platform)}** account yet.\n\n` +
              `Head to the **[Vendora dashboard](${DASHBOARD_URL})** → **My Platforms** and click **Connect Vinted**.\n\n` +
              `Once connected, Vendora pulls your live listings, sold count, feedback score and more for a real analytics report.`
            )
            .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
        ]});
      }
    }

    // ── Check which platforms are connected ──────────────────────────────────
    const [vintedConn] = await Promise.all([
      getPlatformConn(profile.id, 'vinted'),
    ]);

    const connectedPlatforms = [
      vintedConn && 'vinted',
    ].filter(Boolean);

    if (!connectedPlatforms.length) {
      return interaction.editReply({ embeds: [
        baseEmbed('#e8217a')
          .setTitle('No Platforms Connected')
          .setDescription(
            'Connect at least one reselling platform to get live analytics.\n\n' +
            '**Currently supported:** Vinted\n\n' +
            `Go to the **[Vendora dashboard](${DASHBOARD_URL})** → **My Platforms** to connect.`
          )
          .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
      ]});
    }

    // ── Vinted analytics ─────────────────────────────────────────────────────
    if ((platform === 'vinted' || platform === 'all') && vintedConn) {
      const token  = decryptToken(vintedConn.access_token);
      const userId = vintedConn.platform_user_id || '';

      // Tell the user we're fetching (can take a few seconds)
      await interaction.editReply({ embeds: [
        baseEmbed('#09b1ba')
          .setTitle('Fetching Vinted Data…')
          .setDescription('Pulling live data from Vinted — this takes a few seconds.')
      ]});

      let vData = null;
      try {
        // Try direct HTTP first (fast, no Playwright needed)
        let raw = await fetchVintedAnalyticsDirect(token, userId);

        // If DataDome blocked the direct call, fall back to browser
        if (raw.datadome && vintedBrowser?.vintedBrowserFetchAnalytics) {
          console.warn('[analytics] direct call blocked by DataDome — trying browser flow');
          const browserRaw = await vintedBrowser.vintedBrowserFetchAnalytics(token, userId);
          if (!browserRaw.error) {
            raw = {
              user:  browserRaw.meRes?.data?.user    || {},
              items: browserRaw.itemsRes?.data?.items || [],
            };
          }
        }

        const u     = raw.user  || {};
        const items = raw.items || [];

        if (u.id || u.login || items.length) {
          const prices = items.map(i => parseFloat(i.price?.amount || i.price || 0)).filter(p => p > 0);
          const avgPrice   = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : '0.00';
          const totalValue = prices.reduce((a, b) => a + b, 0).toFixed(2);
          const topItems   = items.slice(0, 5)
            .map(i => `• ${i.title?.slice(0, 45) || 'Untitled'} — £${parseFloat(i.price?.amount || i.price || 0).toFixed(2)}`)
            .join('\n');

          const soldCount   = u.sold_items_count   ?? 0;
          const activeCount = u.items_count || items.length;
          const totalEver   = soldCount + activeCount;
          const sellThrough = totalEver > 0 ? ((soldCount / totalEver) * 100).toFixed(1) : null;

          vData = {
            username:     u.login || u.username || vintedConn.platform_username,
            followers:    u.followers_count || 0,
            following:    u.following_count || 0,
            activeItems:  activeCount,
            soldCount,
            sellThrough,
            feedback: {
              positive:   u.positive_feedback_count || 0,
              neutral:    u.neutral_feedback_count  || 0,
              negative:   u.negative_feedback_count || 0,
              reputation: u.feedback_reputation ? `${(u.feedback_reputation * 100).toFixed(0)}%` : null,
            },
            avgPrice,
            totalValue,
            topItems,
          };
        }
      } catch (e) {
        console.warn('[analytics] Vinted data fetch threw:', e.message);
      }

      // Build AI context string
      let aiCtx;
      if (vData) {
        aiCtx =
          `LIVE VINTED ACCOUNT DATA for @${vData.username}:\n` +
          `- Active listings: ${vData.activeItems}\n` +
          `- Sold items (all time): ${vData.soldCount}\n` +
          (vData.sellThrough ? `- Sell-through rate: ${vData.sellThrough}% (sold ÷ total listed)\n` : '') +
          `- Followers: ${vData.followers} | Following: ${vData.following}\n` +
          `- Feedback: ${vData.feedback.positive} positive, ${vData.feedback.neutral} neutral, ${vData.feedback.negative} negative` +
          (vData.feedback.reputation ? ` (${vData.feedback.reputation} reputation)` : '') + '\n' +
          `- Average active listing price: £${vData.avgPrice}\n` +
          `- Total active inventory value: £${vData.totalValue}\n` +
          (vData.topItems ? `\nSample of recent listings:\n${vData.topItems}` : '') + '\n\n' +
          `User subscription tier: ${profile?.tier || 'elite'}`;
      } else {
        aiCtx =
          `Platform: Vinted | Username: @${vintedConn.platform_username}\n` +
          `Subscription tier: ${profile?.tier || 'elite'}\n` +
          `Note: Live Vinted data unavailable (DataDome may be blocking) — provide general advice.`;
      }

      const text = await callAI(
        `You are Vendora's analytics engine for a UK reseller. Analyse this Vinted account and provide:\n` +
        `1. **Account Overview** — key stats in plain language\n` +
        `2. **Sell-Through Rate** — what it means and whether it's healthy (if data available)\n` +
        `3. **Pricing Insights** — based on their average price point\n` +
        `4. **3 Specific Actions** — things they can do THIS WEEK to improve results\n` +
        `Keep it direct, practical, UK-focused. Use £ not $. Bold the section headers.`,
        aiCtx,
        'claude-haiku-4-5-20251001', 750
      );
      if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });

      const fields = vData ? [
        { name: '📦 Active Listings', value: String(vData.activeItems), inline: true },
        { name: '✅ Sold (all time)',  value: String(vData.soldCount),   inline: true },
        { name: '📈 Sell-through',    value: vData.sellThrough ? `${vData.sellThrough}%` : 'N/A', inline: true },
        { name: '💰 Avg. Price',      value: `£${vData.avgPrice}`,       inline: true },
        { name: '💼 Inv. Value',       value: `£${vData.totalValue}`,     inline: true },
        { name: '👥 Followers',        value: String(vData.followers),    inline: true },
        { name: '⭐ Feedback',
          value: `${vData.feedback.positive}✅ ${vData.feedback.negative}❌` + (vData.feedback.reputation ? ` · ${vData.feedback.reputation}` : ''),
          inline: false },
      ] : [];

      return interaction.editReply({ embeds: [
        baseEmbed('#e8a121')
          .setTitle(`📊 Vinted Analytics — @${vData?.username || vintedConn.platform_username}`)
          .setDescription(text.slice(0, 4000))
          .addFields(fields)
          .setFooter({ text: vData ? 'Live data from Vinted · Vendora Analytics' : 'Live data unavailable · Based on Vendora account data' })
      ]});
    }
  }

  // ── AI commands ──────────────────────────────────────────────────────────────
  if (!ai) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });

  if (commandName === 'reply') {
    const situation = opts.getString('situation');
    const text = await callAI(
      'You are Vendora, an AI assistant for UK resellers. Generate a professional, friendly buyer reply message. Keep it 2-4 sentences. Be conversational and natural — match the tone to typical resale platform messaging (Depop is casual, eBay more formal). Do not add quotation marks around the message.',
      `Buyer situation: ${situation}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle('Buyer Reply').setDescription(text.slice(0, 4000))
        .addFields({ name: 'Situation', value: situation.slice(0, 200) })
    ]});
  }

  if (commandName === 'lowball') {
    const offer = opts.getString('offer');
    const text = await callAI(
      'You are Vendora, an AI assistant for UK resellers. Generate a firm but professional response to a lowball offer. The response should: protect margins, keep the door open for a fair deal, be polite but confident, not over-explain. 2-4 sentences. Do not add quotation marks.',
      `Lowball offer scenario: ${offer}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle('Lowball Response').setDescription(text.slice(0, 4000))
        .addFields({ name: 'Offer', value: offer.slice(0, 200) })
    ]});
  }

  if (commandName === 'price') {
    const item = opts.getString('item');

    const [depopResults, vintedResults, priceWebR, newsR, imagesR] = await Promise.all([
      searchDepop(item),
      searchVinted(item),
      webSearch(`${item} resale price UK sold`, 5),
      braveNewsSearch(`${item} resale demand 2025`, 3),
      braveImageSearch(`${item}`, 4),
    ]);

    const extractPrices = (results) =>
      (results || []).map(r => parseFloat((r.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);

    const depopPrices  = extractPrices(depopResults);
    const vintedPrices = extractPrices(vintedResults);
    const allPrices    = [...depopPrices, ...vintedPrices].sort((a, b) => a - b);

    let liveContext = `Live platform data unavailable. Using UK resale market knowledge.`;
    if (allPrices.length >= 2) {
      const low  = allPrices[0].toFixed(2);
      const high = allPrices[allPrices.length - 1].toFixed(2);
      const avg  = (allPrices.reduce((a, b) => a + b, 0) / allPrices.length).toFixed(2);
      const depopAvg  = depopPrices.length  ? `£${(depopPrices.reduce((a,b)=>a+b,0)/depopPrices.length).toFixed(2)}`  : 'n/a';
      const vintedAvg = vintedPrices.length ? `£${(vintedPrices.reduce((a,b)=>a+b,0)/vintedPrices.length).toFixed(2)}` : 'n/a';
      liveContext = `LIVE PLATFORM DATA (${allPrices.length} listings scraped now):\n- Depop: ${depopPrices.length} listings, avg ${depopAvg}\n- Vinted: ${vintedPrices.length} listings, avg ${vintedAvg}\n- Range: £${low}–£${high}, avg £${avg}`;
    }

    const webCtx  = priceWebR?.length ? `\nWEB — PRICES:\n${priceWebR.map(r => `• ${r.title}: ${r.description?.slice(0,100)}`).join('\n')}` : '';
    const newsCtx = newsR?.length     ? `\nNEWS:\n${newsR.map(r => `• ${r.title}: ${r.description?.slice(0,80)}`).join('\n')}`              : '';
    const productImage = imagesR?.find(img => img.imageUrl?.startsWith('https'))?.imageUrl || null;

    const systemPrompt = `You are Vendora's price analyst for UK resellers. Return ONLY valid JSON — no markdown, no extra text:
{
  "summary": "2-3 sentence price overview with specific £ figures from the live data",
  "depopRange": "£XX–XX",
  "vintedRange": "£XX–XX",
  "buyAt": "£XX target buy price to flip profitably",
  "sellAt": "£XX–XX recommended sell price",
  "margin": "£XX estimated net profit after fees and £3.50 shipping",
  "demand": "High / Medium / Low — one sentence reason based on data",
  "tip": "One actionable tip for buying or selling this item right now"
}`;

    let report = null;
    try {
      const raw = await callAI(systemPrompt, `Item: ${item}\n\n${liveContext}${webCtx}${newsCtx}`, 'claude-haiku-4-5-20251001', 600);
      if (raw) { const m = raw.match(/\{[\s\S]*\}/); if (m) report = JSON.parse(m[0]); }
    } catch (e) { console.error('[price] JSON parse failed:', e.message); }

    if (!report) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });

    const sourceCount = allPrices.length + (priceWebR?.length || 0);
    const embed = baseEmbed()
      .setTitle(`💷 Price Check — ${item}`)
      .setDescription((report.summary || '—').slice(0, 900))
      .addFields(
        { name: 'Depop Range',  value: report.depopRange  || '—', inline: true },
        { name: 'Vinted Range', value: report.vintedRange || '—', inline: true },
        { name: '\u200B',       value: '\u200B',                  inline: true },
        { name: 'Buy At',       value: report.buyAt       || '—', inline: true },
        { name: 'Sell At',      value: report.sellAt      || '—', inline: true },
        { name: 'Margin',       value: report.margin      || '—', inline: true },
        { name: '📈 Demand',    value: (report.demand     || '—').slice(0, 512), inline: false },
        { name: '💡 Tip',       value: (report.tip        || '—').slice(0, 512), inline: false },
      )
      .setFooter({ text: sourceCount > 0 ? `${sourceCount} sources · Depop + Vinted + Web` : 'Vendora AI estimate' });

    if (productImage) embed.setThumbnail(productImage);
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'scan') {
    const platform      = opts.getString('platform');
    const item          = opts.getString('item');
    const platformNames = { depop: 'Depop', vinted: 'Vinted' };
    const platformLabel = platformNames[platform] || platform;

    const [platformResults, webR, imagesR] = await Promise.all([
      platform === 'depop'  ? searchDepop(item)  :
      platform === 'vinted' ? searchVinted(item) : Promise.resolve(null),
      webSearch(`${item} resale price UK market value`, 4),
      braveImageSearch(`${item}`, 3),
    ]);

    const productImage = imagesR?.find(img => img.imageUrl?.startsWith('https'))?.imageUrl || null;

    if (!platformResults?.length) {
      const text = await callAI(
        `You are Vendora's scan engine. Analyse ${platformLabel} for underpriced listings of the given item. Include: typical price range, what underpriced looks like (specific £ threshold), best search terms, and 3-5 listing types to target.`,
        `Platform: ${platformLabel}\nItem: ${item}`,
        'claude-haiku-4-5-20251001', 700
      );
      if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
      return interaction.editReply({ embeds: [
        baseEmbed().setTitle(`🔍 Scan — ${item} on ${platformLabel}`)
          .setDescription(text.slice(0, 4000))
          .setFooter({ text: 'AI estimate — live data temporarily unavailable' })
      ]});
    }

    const prices = platformResults
      .map(r => parseFloat((r.price || '').replace('£', '')))
      .filter(p => !isNaN(p) && p > 0)
      .sort((a, b) => a - b);

    const avg           = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    const median        = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
    const dealThreshold = avg * 0.75;

    const deals = platformResults
      .filter(r => { const p = parseFloat((r.price || '').replace('£', '')); return !isNaN(p) && p > 0 && p <= dealThreshold; })
      .slice(0, 5);

    const dealsText = deals.length
      ? deals.map(d => `${d.title.slice(0,60)} — ${d.price}${d.url ? `\n${d.url}` : ''}`).join('\n\n')
      : 'No clear deals found below market average right now.';

    const webCtx = webR?.length ? `\nWEB MARKET CONTEXT:\n${webR.map(r => `• ${r.title}: ${r.description?.slice(0,100)}`).join('\n')}` : '';

    const systemPrompt = `You are Vendora's deal scanner. Return ONLY valid JSON:
{
  "dealSummary": "1-2 sentences — are there good deals right now or is the market overpriced?",
  "marketAvg": "£XX — one sentence on current market price level",
  "dealThreshold": "£XX — what counts as genuinely underpriced",
  "topDeals": "Best 1-3 specific deals from the data with prices, or state if none found",
  "searchTips": "2-3 specific search terms or filters to find more deals on ${platformLabel}",
  "verdict": "Buy now / Wait / Oversaturated — one punchy line"
}`;

    let report = null;
    try {
      const raw = await callAI(systemPrompt,
        `Item: ${item}\nPlatform: ${platformLabel}\n\nLIVE: ${platformResults.length} listings, avg £${avg.toFixed(2)}, median £${median.toFixed(2)}, range £${prices[0]?.toFixed(2) || '?'}–£${prices[prices.length-1]?.toFixed(2) || '?'}\n\nDEALS (≤ £${dealThreshold.toFixed(2)}):\n${dealsText}${webCtx}`,
        'claude-haiku-4-5-20251001', 600);
      if (raw) { const m = raw.match(/\{[\s\S]*\}/); if (m) report = JSON.parse(m[0]); }
    } catch (e) { console.error('[scan] JSON parse failed:', e.message); }

    if (!report) {
      return interaction.editReply({ embeds: [
        baseEmbed().setTitle(`🔍 Scan — ${item} on ${platformLabel}`)
          .setDescription(formatPlatformResults(platformResults, platformLabel) || 'No results.')
          .addFields(
            { name: 'Lowest',  value: prices[0] ? `£${prices[0].toFixed(2)}` : '—', inline: true },
            { name: 'Average', value: avg        ? `£${avg.toFixed(2)}`       : '—', inline: true },
            { name: 'Results', value: `${platformResults.length}`,                   inline: true },
          )
          .setFooter({ text: `Live from ${platformLabel}` })
      ]});
    }

    const embed = baseEmbed()
      .setTitle(`🔍 Scan — ${item} on ${platformLabel}`)
      .setDescription((report.dealSummary || '—').slice(0, 600))
      .addFields(
        { name: 'Market Average', value: report.marketAvg     || `£${avg.toFixed(2)}`,            inline: true },
        { name: 'Deal Threshold', value: report.dealThreshold || `≤ £${dealThreshold.toFixed(2)}`, inline: true },
        { name: 'Listings Found', value: `${platformResults.length}`,                              inline: true },
        { name: '🎯 Best Deals',  value: (report.topDeals    || 'None right now').slice(0, 1020),  inline: false },
        { name: '🔎 Search Tips', value: (report.searchTips  || '—').slice(0, 1020),               inline: false },
        { name: '✅ Verdict',      value: (report.verdict     || '—').slice(0, 512),                inline: false },
      )
      .setFooter({ text: `${platformResults.length} live listings from ${platformLabel}` });

    if (productImage) embed.setThumbnail(productImage);
    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'research') {
    const item = opts.getString('item');

    // Fire all sources in parallel — platform scrapes, web searches, images, news
    const [depopR, vintedR, priceWebR, sourcingWebR, newsR, imagesR] = await Promise.all([
      searchDepop(item),
      searchVinted(item),
      webSearch(`${item} resale price UK sold`, 6),
      webSearch(`${item} buy cheap source where to find UK`, 4),
      braveNewsSearch(`${item} resale hype market 2025`, 4),
      braveImageSearch(`${item}`, 6),
    ]);

    // Build live price context from platform scrapes
    const extractP = (r) => (r || []).map(x => parseFloat((x.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);
    const depopPrices = extractP(depopR), vintedPrices = extractP(vintedR);
    const allPrices   = [...depopPrices, ...vintedPrices].sort((a, b) => a - b);

    let liveCtx = 'No live platform data scraped — use market knowledge.';
    if (allPrices.length >= 2) {
      const avg  = (allPrices.reduce((a, b) => a + b, 0) / allPrices.length).toFixed(2);
      const low  = allPrices[0].toFixed(2), high = allPrices[allPrices.length - 1].toFixed(2);
      const dAvg = depopPrices.length  ? `£${(depopPrices.reduce((a,b)=>a+b,0)/depopPrices.length).toFixed(2)}`  : 'n/a';
      const vAvg = vintedPrices.length ? `£${(vintedPrices.reduce((a,b)=>a+b,0)/vintedPrices.length).toFixed(2)}` : 'n/a';
      liveCtx = `LIVE PLATFORM DATA (${allPrices.length} listings scraped right now):\n- Depop: ${depopPrices.length} listings, avg ${dAvg}\n- Vinted: ${vintedPrices.length} listings, avg ${vAvg}\n- Range: £${low}–£${high}, avg £${avg}`;
    }

    const priceCtx   = priceWebR?.length   ? `\nWEB — PRICES & SOLD RESULTS:\n${priceWebR.map(r => `• ${r.title}: ${r.description?.slice(0,120)}`).join('\n')}`   : '';
    const sourcingCtx = sourcingWebR?.length ? `\nWEB — SOURCING:\n${sourcingWebR.map(r => `• ${r.title}: ${r.description?.slice(0,100)}`).join('\n')}` : '';
    const newsCtx    = newsR?.length        ? `\nRECENT NEWS:\n${newsR.map(r => `• ${r.title}${r.age ? ` (${r.age})` : ''}: ${r.description?.slice(0,100)}`).join('\n')}` : '';

    // Pick first usable product image (https, likely a direct image URL)
    const productImage = imagesR?.find(img => img.imageUrl?.startsWith('https'))?.imageUrl || null;

    const systemPrompt = `You are Vendora's deep research engine for UK resellers. You have live scraped data, web search results, and news. Produce a comprehensive research report. Return ONLY valid JSON — no markdown, no explanation, just the JSON object:
{
  "overview": "2-3 sentences on what this item is, its resale market position, and why resellers care about it",
  "priceAnalysis": "Detailed price breakdown with specific £ figures per platform. Cover budget/mid/premium tiers if relevant.",
  "flipOpportunity": "Target buy price, which platform to sell on, estimated net profit after platform fees and £3.50 shipping. Include ROI %.",
  "demandSignals": "How fast does this sell? What drives demand right now? Any upcoming drops, collabs, or seasonal factors?",
  "whereToBuy": "Top 3-4 specific places to source this cheaply — charity shops, car boots, Facebook Marketplace, specific platform search terms, keywords to use.",
  "watchOut": "Fakes to identify, condition issues that kill value, slow-moving variants or sizes, anything that hurts margins.",
  "verdict": "One punchy sentence — is this worth flipping right now and why.",
  "stats": {
    "buyAt": "£XX",
    "sellAt": "£XX–XX",
    "margin": "£XX (XX%)",
    "demand": "High / Medium / Low",
    "risk": "Low / Medium / High"
  }
}`;

    const userPrompt = `Item: ${item}\n\n${liveCtx}${priceCtx}${sourcingCtx}${newsCtx}`;

    let report = null;
    try {
      const raw = await callAI(systemPrompt, userPrompt, 'claude-sonnet-4-6', 1600);
      if (!raw) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) report = JSON.parse(match[0]);
    } catch (e) {
      console.error('[research] JSON parse failed:', e.message);
    }

    if (!report) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });

    const s = report.stats || {};
    const sourceCount = allPrices.length + (priceWebR?.length || 0) + (newsR?.length || 0);

    const mainEmbed = baseEmbed()
      .setTitle(`🔍 Research Report — ${item}`)
      .setDescription(
        `**Overview**\n${(report.overview || '—').slice(0, 800)}\n\n` +
        `**📊 Price Analysis**\n${(report.priceAnalysis || '—').slice(0, 900)}\n\n` +
        `**💰 Flip Opportunity**\n${(report.flipOpportunity || '—').slice(0, 900)}`
      )
      .addFields(
        { name: 'Buy At',  value: s.buyAt  || '—', inline: true },
        { name: 'Sell At', value: s.sellAt || '—', inline: true },
        { name: 'Margin',  value: s.margin || '—', inline: true },
        { name: 'Demand',  value: s.demand || '—', inline: true },
        { name: 'Risk',    value: s.risk   || '—', inline: true },
      )
      .setFooter({ text: `Vendora Research · ${sourceCount} sources · Depop + Vinted + Web + News` });

    if (productImage) mainEmbed.setImage(productImage);

    const detailEmbed = baseEmbed('#141414')
      .setTitle('📋 Deep Dive')
      .addFields(
        { name: '📈 Demand Signals',   value: (report.demandSignals || '—').slice(0, 1020), inline: false },
        { name: '🛒 Where to Source',  value: (report.whereToBuy   || '—').slice(0, 1020), inline: false },
        { name: '⚠️ Watch Out For',    value: (report.watchOut     || '—').slice(0, 1020), inline: false },
        { name: '✅ Verdict',           value: (report.verdict      || '—').slice(0, 1020), inline: false },
      );

    return interaction.editReply({ embeds: [mainEmbed, detailEmbed] });
  }

  if (commandName === 'margins') {
    const item = opts.getString('item');
    const [depopR, vintedR, webR] = await Promise.all([
      searchDepop(item),
      searchVinted(item),
      webSearch(`${item} resale price UK sold average`, 4),
    ]);

    const extractP = (r) => (r || []).map(x => parseFloat((x.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);
    const depopP = extractP(depopR), vintedP = extractP(vintedR);
    const all    = [...depopP, ...vintedP].sort((a, b) => a - b);

    const webCtx = webR?.length ? `\nWEB PRICE CONTEXT:\n${webR.map(r => `• ${r.title}: ${r.description?.slice(0,100)}`).join('\n')}` : '';

    const shipping = 3.50;
    let liveCtx = 'No live data — using market knowledge.';
    let targetBuy = '0', depopSell = '0', vintedSell = '0';
    let depopFee = '0', vintedFee = '0';
    let depopProfit = '0', vintedProfit = '0';
    let depopROI = '0', vintedROI = '0';

    if (all.length >= 2) {
      const avg = all.reduce((a, b) => a + b, 0) / all.length;
      const low = all[0], high = all[all.length - 1];
      targetBuy    = (avg * 0.55).toFixed(2);
      depopSell    = (depopP.length  ? depopP.reduce((a,b)=>a+b,0)/depopP.length   : avg).toFixed(2);
      vintedSell   = (vintedP.length ? vintedP.reduce((a,b)=>a+b,0)/vintedP.length : avg).toFixed(2);
      depopFee     = (parseFloat(depopSell)  * 0.10).toFixed(2);
      vintedFee    = (parseFloat(vintedSell) * 0.05).toFixed(2);
      depopProfit  = (parseFloat(depopSell)  - parseFloat(targetBuy) - parseFloat(depopFee)  - shipping).toFixed(2);
      vintedProfit = (parseFloat(vintedSell) - parseFloat(targetBuy) - parseFloat(vintedFee) - shipping).toFixed(2);
      depopROI     = ((parseFloat(depopProfit)  / parseFloat(targetBuy)) * 100).toFixed(0);
      vintedROI    = ((parseFloat(vintedProfit) / parseFloat(targetBuy)) * 100).toFixed(0);
      liveCtx = `LIVE DATA (${all.length} listings):\n- Range: £${low.toFixed(2)}–£${high.toFixed(2)}, avg £${avg.toFixed(2)}\n- Depop avg: £${depopSell}, Vinted avg: £${vintedSell}`;
    }

    const systemPrompt = `You are Vendora's margin calculator. Return ONLY valid JSON:
{
  "summary": "1-2 sentence overview of the margin opportunity",
  "buyAdvice": "Where and how to source at the target buy price",
  "bestPlatform": "Depop or Vinted — which is better for this item and why",
  "depopVerdict": "One sentence on the Depop margin",
  "vintedVerdict": "One sentence on the Vinted margin",
  "warning": "Any margin risks (fakes, slow sell, seasonal demand etc)"
}`;

    let report = null;
    try {
      const raw = await callAI(systemPrompt,
        `Item: ${item}\n\n${liveCtx}${webCtx}\n\nCALCULATED:\n- Buy: £${targetBuy} | Depop sell: £${depopSell} fee £${depopFee} profit £${depopProfit} (${depopROI}% ROI) | Vinted sell: £${vintedSell} fee £${vintedFee} profit £${vintedProfit} (${vintedROI}% ROI) | Shipping: £${shipping}`,
        'claude-haiku-4-5-20251001', 500);
      if (raw) { const m = raw.match(/\{[\s\S]*\}/); if (m) report = JSON.parse(m[0]); }
    } catch (e) { console.error('[margins] JSON parse failed:', e.message); }

    if (!report) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });

    const footer = all.length >= 2 ? `Based on ${all.length} live listings · Depop + Vinted + Web` : 'AI estimate — live data unavailable';
    return interaction.editReply({ embeds: [
      baseEmbed()
        .setTitle(`📊 Margin Breakdown — ${item}`)
        .setDescription((report.summary || '—').slice(0, 600))
        .addFields(
          { name: '🛒 Buy At',           value: `£${targetBuy}`,                                       inline: true },
          { name: '📦 Shipping',         value: `£${shipping.toFixed(2)}`,                             inline: true },
          { name: '\u200B',              value: '\u200B',                                              inline: true },
          { name: '🔴 Depop Sell',       value: `£${depopSell}`,                                      inline: true },
          { name: 'Depop Fee (10%)',     value: `£${depopFee}`,                                       inline: true },
          { name: 'Depop Profit',        value: `**£${depopProfit}** (${depopROI}% ROI)`,             inline: true },
          { name: '🟦 Vinted Sell',      value: `£${vintedSell}`,                                     inline: true },
          { name: 'Vinted Fee (5%)',     value: `£${vintedFee}`,                                      inline: true },
          { name: 'Vinted Profit',       value: `**£${vintedProfit}** (${vintedROI}% ROI)`,           inline: true },
          { name: '🏆 Best Platform',    value: (report.bestPlatform || '—').slice(0, 512),            inline: false },
          { name: '💡 Sourcing Advice',  value: (report.buyAdvice    || '—').slice(0, 512),            inline: false },
          { name: '⚠️ Risks',            value: (report.warning      || 'None identified').slice(0, 512), inline: false },
        )
        .setFooter({ text: footer })
    ]});
  }


  if (commandName === 'trends') {
    const category = opts.getString('category');
    const [depopR, vintedR, webR] = await Promise.all([
      searchDepop(category), searchVinted(category),
      webSearch(`${category} resale trend UK 2025 popular selling fast`, 5),
    ]);

    const extractP = (r) => (r || []).map(x => parseFloat((x.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);
    const depopP = extractP(depopR), vintedP = extractP(vintedR);
    const allP   = [...depopP, ...vintedP];

    let liveCtx = 'No live listing data available — use market knowledge.';
    if (allP.length >= 3) {
      const avg     = (allP.reduce((a, b) => a + b, 0) / allP.length).toFixed(2);
      const low     = Math.min(...allP).toFixed(2), high = Math.max(...allP).toFixed(2);
      const topItems = [...(depopR || []), ...(vintedR || [])]
        .sort((a, b) => {
          const pA = parseFloat((a.price || '').replace('£', '')) || 0;
          const pB = parseFloat((b.price || '').replace('£', '')) || 0;
          return pB - pA;
        })
        .slice(0, 5)
        .map(x => `${x.title.slice(0, 50)} — ${x.price}`);
      liveCtx = `LIVE DATA (${allP.length} listings scraped now for "${category}"):\n` +
        `- Depop: ${depopR?.length || 0} listings, Vinted: ${vintedR?.length || 0} listings\n` +
        `- Price range: £${low}–£${high}, avg £${avg}\n` +
        `- Sample high-value items:\n${topItems.map(x => `  · ${x}`).join('\n')}\n\n` +
        `Use this data to judge current demand and price trends.`;
    }

    const webCtx = webR?.length ? `\nWEB SEARCH (latest trend signals):\n${formatWebResults(webR)}\n` : '';
    const text = await callAI(
      `You are Vendora's trend analyst for the UK resale market. You have current live listing and web data.\n\n${liveCtx}${webCtx}\n\nBased on all data, provide:\n**Demand Level** — High/Medium/Low with reasoning from the data\n**Price Trend** — rising/stable/falling (use the price distribution and web signals as evidence)\n**Top Items** — 5 most sought-after items in this category right now\n**Best Platforms** — where it performs best and why\n**Buying Opportunity** — rating out of 10 with justification\n**Source Now** — 3 specific items/variations to look for immediately`,
      `Category/Brand: ${category}`,
      'claude-haiku-4-5-20251001', 900
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const sources = [allP.length >= 3 ? `${allP.length} listings` : null, webR?.length ? 'web search' : null].filter(Boolean);
    const footer = sources.length ? `Sources: ${sources.join(' + ')}` : 'AI market knowledge — live data unavailable';
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Trend Report — ${category}`).setDescription(text.slice(0, 4000)).setFooter({ text: footer })
    ]});
  }

  if (commandName === 'sold') {
    const item = opts.getString('item');
    const [depopR, vintedR, webR] = await Promise.all([
      searchDepop(item), searchVinted(item),
      webSearch(`${item} sold recently UK resale how fast does it sell`, 4),
    ]);

    const extractP = (r) => (r || []).map(x => parseFloat((x.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);
    const depopP = extractP(depopR), vintedP = extractP(vintedR);
    const allP = [...depopP, ...vintedP];

    let liveCtx = 'No live data available — using market knowledge.';
    if (allP.length >= 3) {
      const avg  = (allP.reduce((a, b) => a + b, 0) / allP.length).toFixed(2);
      const low  = Math.min(...allP).toFixed(2), high = Math.max(...allP).toFixed(2);
      // Vinted shows active listings with condition; items priced near avg tend to sell fastest
      const priceDistrib = {
        under30: allP.filter(p => p < 30).length,
        '30to60': allP.filter(p => p >= 30 && p < 60).length,
        '60to100': allP.filter(p => p >= 60 && p < 100).length,
        over100: allP.filter(p => p >= 100).length,
      };
      liveCtx = `LIVE ACTIVE LISTINGS (proxy for demand — ${allP.length} listings):\n` +
        `- Range: £${low}–£${high}, avg £${avg}\n` +
        `- Price distribution: Under £30: ${priceDistrib.under30}, £30-60: ${priceDistrib['30to60']}, £60-100: ${priceDistrib['60to100']}, £100+: ${priceDistrib.over100}\n` +
        `- Depop: ${depopR?.length || 0} active, Vinted: ${vintedR?.length || 0} active\n\n` +
        `Note: We're looking at active listings as a demand proxy. Higher listing volume at a price point suggests that price range moves well.`;
    }

    const webCtx = webR?.length ? `\nWEB SEARCH (real buyer/seller feedback):\n${formatWebResults(webR)}\n` : '';
    const text = await callAI(
      `You are Vendora's sold listing analyst for the UK resale market.\n\n${liveCtx}${webCtx}\n\nUsing all data signals, provide:\n**Fast Sellers** — specific versions/conditions that move quickly (price them near £${allP.length >= 3 ? (allP.reduce((a,b)=>a+b,0)/allP.length).toFixed(0) : '?'})\n**Slow Movers** — what sits unsold and why\n**Key Factors** — what makes listings sell faster on each platform\n**Sweet Spot Pricing** — optimal price points based on the data\n**Condition Requirements** — what buyers expect`,
      `Item/Category: ${item}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const sources = [allP.length >= 3 ? `${allP.length} listings` : null, webR?.length ? 'web' : null].filter(Boolean);
    const footer = sources.length ? `Sources: ${sources.join(' + ')}` : 'AI market knowledge — live data unavailable';
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Sold Listing Analysis — ${item}`).setDescription(text.slice(0, 4000)).setFooter({ text: footer })
    ]});
  }

  if (commandName === 'competitor') {
    const seller = opts.getString('seller');
    const [depopData, vintedData, webR, newsR, imagesR] = await Promise.all([
      searchDepopSeller(seller),
      searchVintedSeller(seller),
      webSearch(`${seller} depop vinted reseller UK`, 4),
      braveNewsSearch(`${seller} reseller streetwear fashion UK`, 3),
      braveImageSearch(`${seller} depop`, 3),
    ]);

    let liveCtx = `Seller "${seller}" not found on Depop or Vinted.`;
    let foundOn  = [];

    if (depopData?.products?.length) {
      foundOn.push('Depop');
      const prices = depopData.products.map(p => parseFloat(p.price.replace('£', ''))).filter(p => !isNaN(p));
      const avg    = prices.length ? (prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : '?';
      const top5   = depopData.products.slice(0, 5).map(p => `${p.title.slice(0,50)} — ${p.price}`).join('\n');
      liveCtx      = `DEPOP — @${depopData.username}:\n- Followers: ${depopData.followers.toLocaleString()}, Total sold: ${depopData.totalListings.toLocaleString()}\n- Active listings shown: ${depopData.products.length}, avg £${avg}\n- Current listings:\n${top5}`;
    }
    if (vintedData?.products?.length) {
      foundOn.push('Vinted');
      const prices = vintedData.products.map(p => parseFloat(p.price.replace('£', ''))).filter(p => !isNaN(p));
      const avg    = prices.length ? (prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : '?';
      const top5   = vintedData.products.slice(0, 5).map(p => `${p.title.slice(0,50)} — ${p.price}`).join('\n');
      liveCtx     += `\nVINTED — @${vintedData.username}:\n- Followers: ${vintedData.followers.toLocaleString()}, Active items: ${vintedData.totalListings.toLocaleString()}\n- Listings shown: ${vintedData.products.length}, avg £${avg}\n- Current listings:\n${top5}`;
    }

    const webCtx   = webR?.length  ? `\nWEB MENTIONS:\n${webR.map(r => `• ${r.title}: ${r.description?.slice(0,100)}`).join('\n')}`  : '';
    const newsCtx  = newsR?.length ? `\nNEWS:\n${newsR.map(r => `• ${r.title}: ${r.description?.slice(0,80)}`).join('\n')}`          : '';
    const profileImage = imagesR?.find(img => img.imageUrl?.startsWith('https'))?.imageUrl || null;

    const systemPrompt = `You are Vendora's competitor intelligence system. You have live seller data and web context. Return ONLY valid JSON:
{
  "sellerType": "One line: what type of reseller (niche, volume, premium, budget etc.)",
  "pricingStrategy": "How they price vs market — specific observation with £ figures if possible",
  "speciality": "What categories or items they focus on based on their actual listings",
  "counterStrategy": "3 specific ways to position against this seller and steal their customers",
  "watchFor": "2-3 specific signals to monitor on their profile",
  "opportunity": "The single biggest gap in their inventory you could exploit right now",
  "threat": "Low / Medium / High — how dangerous are they as a competitor and why"
}`;

    let report = null;
    try {
      const raw = await callAI(systemPrompt, `Seller: ${seller}\n\n${liveCtx}${webCtx}${newsCtx}`, 'claude-sonnet-4-6', 900);
      if (raw) { const m = raw.match(/\{[\s\S]*\}/); if (m) report = JSON.parse(m[0]); }
    } catch (e) { console.error('[competitor] JSON parse failed:', e.message); }

    if (!report) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });

    const footer = foundOn.length ? `Live data from ${foundOn.join(' + ')}` : 'Seller not found — strategic advice only';

    const mainEmbed = baseEmbed()
      .setTitle(`🕵️ Competitor — ${seller}`)
      .setDescription(
        `**Seller Type**\n${(report.sellerType      || '—').slice(0,300)}\n\n` +
        `**Pricing Strategy**\n${(report.pricingStrategy || '—').slice(0,400)}\n\n` +
        `**Speciality**\n${(report.speciality       || '—').slice(0,400)}`
      )
      .addFields({ name: '⚠️ Threat Level', value: (report.threat || '—').slice(0, 512), inline: false })
      .setFooter({ text: footer });

    if (profileImage) mainEmbed.setThumbnail(profileImage);

    const stratEmbed = baseEmbed('#141414')
      .setTitle('📋 Counter Strategy')
      .addFields(
        { name: '⚔️ How to Counter',   value: (report.counterStrategy || '—').slice(0, 1020), inline: false },
        { name: '👁️ Watch For',        value: (report.watchFor        || '—').slice(0, 1020), inline: false },
        { name: '💡 Exploit This Gap', value: (report.opportunity     || '—').slice(0, 1020), inline: false },
      );

    return interaction.editReply({ embeds: [mainEmbed, stratEmbed] });
  }

  if (commandName === 'flip') {
    const item = opts.getString('item');
    const [depopR, vintedR, webR] = await Promise.all([
      searchDepop(item), searchVinted(item),
      webSearch(`buy ${item} cheap UK where to source resale profit`, 5),
    ]);
    const extractP = (r) => (r || []).map(x => parseFloat((x.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);
    const allPrices = [...extractP(depopR), ...extractP(vintedR)];
    let flipCtx = '';
    if (allPrices.length >= 3) {
      const avg = (allPrices.reduce((a, b) => a + b, 0) / allPrices.length).toFixed(2);
      const low = Math.min(...allPrices).toFixed(2), high = Math.max(...allPrices).toFixed(2);
      flipCtx = `LIVE MARKET DATA:\n- ${allPrices.length} active listings, range £${low}–£${high}, avg £${avg}\n- Suggested buy target: £${(parseFloat(avg) * 0.5).toFixed(2)} (50% of avg)\n`;
    }
    const webCtx = webR?.length ? `WEB SEARCH (sourcing signals):\n${formatWebResults(webR)}\n` : '';
    const text = await callAI(
      `You are Vendora's Elite Auto-Flip System. Use the live data provided.\n\n${flipCtx}${webCtx}\nProvide a complete flip opportunity analysis:\n**Sourcing Strategy** — where and how to buy cheaply (use web results for specific sources)\n**Target Buy Price** — maximum to pay (anchor to live data if available)\n**Suggested Sell Price** — with reasoning from live market prices\n**Projected Profit** — after platform fees (Depop 10%, Vinted 5%) and shipping ~£3.50\n**Best Platform** — where to sell for highest return\n**Time to Sell** — realistic estimate based on current listing volume\n**Risk Level** — Low/Medium/High with reason\n**Action Plan** — numbered step-by-step`,
      `Item: ${item}`,
      'claude-sonnet-4-6', 1200
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121').setTitle(`Auto-Flip Analysis — ${item}`).setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'negotiate') {
    const offer = opts.getString('offer');
    const text = await callAI(
      'You are Vendora\'s advanced negotiation assistant for high-value resale items. Provide a sophisticated negotiation strategy. Include:\n**Opening Position** — your starting stance and tactics\n**Counter-Offer Script** — exact wording to use\n**Floor Price** — your walk-away point\n**Psychological Tactics** — leverage points to use\n**Scenario Responses** — how to handle pushback\n**Closing Move** — how to seal the deal',
      `Negotiation scenario: ${offer}`,
      'claude-sonnet-4-6', 1000
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121').setTitle('Negotiation Strategy').setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'authenticate') {
    const attachment = opts.getAttachment('photo');
    const item      = opts.getString('item');
    const price     = opts.getString('price');
    const source    = opts.getString('source');

    const contextLines = [`Item: ${item}`];
    if (price)  contextLines.push(`Asking price: ${price}`);
    if (source) contextLines.push(`Platform / seller location: ${source}`);
    const userContext = contextLines.join('\n');

    const systemPrompt =
      'You are Vendora\'s authenticity expert for luxury and branded resale items. ' +
      'The user has provided a photo and item details. Carefully examine the photo for visual authentication markers and cross-reference with the item details provided. ' +
      'Structure your response exactly as follows:\n' +
      '**Risk Level** — Critical / High / Medium / Low (one word + one-line reason)\n' +
      '**Visual Red Flags** — list every suspicious detail you can see in the photo (stitching, logo placement, font, hardware, tags, labels, materials)\n' +
      '**Authentication Points Passed** — list anything that looks correct/genuine in the photo\n' +
      '**What to Check in Person** — physical checks the buyer should do before purchasing\n' +
      '**Price Assessment** — is the asking price consistent with the item\'s authenticity and condition?\n' +
      '**Verdict** — Buy with Confidence / Proceed with Caution / Request More Photos / Avoid\n\n' +
      'Be specific about what you see in the photo. Do not give generic advice — reference actual visual details.';

    const text = await callAIWithImage(systemPrompt, userContext, attachment.url);
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });

    const fields = [{ name: 'Item', value: item.slice(0, 200), inline: true }];
    if (price)  fields.push({ name: 'Price', value: price.slice(0, 100), inline: true });
    if (source) fields.push({ name: 'Source', value: source.slice(0, 100), inline: true });

    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121')
        .setTitle('Authenticity Check')
        .setDescription(text.slice(0, 4000))
        .addFields(...fields)
        .setThumbnail(attachment.url)
    ]});
  }

  if (commandName === 'grade') {
    const attachment = opts.getAttachment('photo');
    const text = await callAIWithImage(
      'You are Vendora\'s condition grading expert for resale items. Grade the item\'s condition from the photo using standard resale grading. Provide:\n**Grade** — Excellent/Very Good/Good/Fair/Poor (with x/10 score)\n**Condition Description** — what you observe\n**Visible Defects** — list any flaws, wear, or damage\n**Listing Advice** — how to describe this condition in a listing\n**Price Impact** — how condition affects the resale value',
      'Please grade the condition of this item.',
      attachment.url
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121').setTitle('Condition Grade').setDescription(text.slice(0, 4000))
    ]});
  }

  // ── /ticket close ────────────────────────────────────────────────────────────
  if (commandName === 'ticket') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'close') {
      const channel = interaction.channel;
      if (!channel?.isThread() || !channel.name.startsWith('ticket-')) {
        return interaction.editReply({ embeds: [
          baseEmbed('#f87171').setTitle('Not a Ticket Thread')
            .setDescription('This command can only be used inside a Vendora ticket thread.')
        ]});
      }
      const allowedRoles = Array.isArray(BOT_TOGGLES.ticket_close_roles) ? BOT_TOGGLES.ticket_close_roles : [];
      const memberRoles  = interaction.member?.roles?.cache?.map(r => r.id) || [];
      const canClose     = interaction.user.id === OWNER_ID || memberRoles.some(r => allowedRoles.includes(r));
      if (!canClose) {
        return interaction.editReply({ embeds: [
          baseEmbed('#f87171').setTitle('No Permission')
            .setDescription("You don't have permission to close tickets.")
        ]});
      }
      await interaction.editReply({ embeds: [
        baseEmbed('#4ade80').setTitle('🔒 Ticket Closed')
          .setDescription(`Closed by <@${interaction.user.id}>.\n\nThis thread is now archived.`)
          .setTimestamp()
      ]});
      try { await channel.setArchived(true, `Closed by ${interaction.user.tag}`); } catch { /* ignore */ }
    }

  }

  // ── /supportsetup — one-time command that posts the embed then deletes itself ──
  if (commandName === 'supportsetup') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Owner Only').setDescription('This command is owner-only.')] });
    }

    const supportChannel = findSupportChannel(interaction.guild);
    if (!supportChannel) {
      return interaction.editReply({ embeds: [baseEmbed('#f87171')
        .setTitle('Channel Not Found')
        .setDescription('No channel named `❓｜support` found. Create it and try again.')
      ]});
    }

    // Post the embed
    await supportChannel.send({
      embeds: [new EmbedBuilder()
        .setColor('#e8217a')
        .setTitle('Vendora Support')
        .setDescription(
          'Need help with your subscription, role, or anything else?\n\n' +
          'Click the button below to open a **private support ticket**.\n' +
          'Only you and the Vendora team will be able to see it.\n\n' +
          '**Typical response time:** within a few hours.'
        )
        .addFields({ name: '📋 Before opening a ticket', value: '• Check your role was assigned after payment\n• Run `/help` to see all available commands\n• Check announcements for known issues' })
        .setFooter({ text: 'Vendora — The Reseller\'s Edge  •  Tickets close after 24h of inactivity' })
        .setTimestamp()
      ],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_open_direct').setLabel('🎫 Open a Ticket').setStyle(ButtonStyle.Primary)
      )],
    });

    // Self-destruct: re-register commands without /supportsetup
    try {
      const rest            = new REST().setToken(TOKEN);
      const trimmedCommands = commands.filter(c => c.name !== 'supportsetup');
      await rest.put(Routes.applicationGuildCommands(client.application.id, GUILD_ID), { body: trimmedCommands });
    } catch (e) {
      console.warn('[supportsetup] Could not deregister command:', e.message);
    }

    return interaction.editReply({ embeds: [baseEmbed('#4ade80')
      .setTitle('✅ Done')
      .setDescription(`Support embed posted to ${supportChannel}.\n\nThis command has been removed and won't appear again.`)
    ]});
  }

}

// ── Bot events ────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[discord] Online as ${client.user.tag}`);

  // Register slash commands
  if (GUILD_ID) {
    try {
      const rest = new REST().setToken(TOKEN);
      await rest.put(Routes.applicationGuildCommands(client.application.id, GUILD_ID), { body: commands });
      console.log(`[commands] ${commands.length} slash commands registered`);
    } catch (err) {
      console.error('[commands] Registration failed:', err.message);
    }
  }

  // Start crosslist job scheduler
  setInterval(runCrosslistScheduler, 30 * 60 * 1000);
  console.log('[scheduler] Crosslist scheduler started (30min interval)');
});

client.on('guildMemberAdd', async (member) => {
  // Send Vendora pitch DM to new server members
  try {
    await member.send({ embeds: [
      new EmbedBuilder().setColor('#e8217a')
        .setTitle('Welcome to Vendor Village')
        .setDescription(
          `Hey **${member.user.username}** — welcome to the server.\n\n` +
          `**Vendora** is our AI-powered reselling tool, built to give you a measurable edge:\n\n` +
          `→ AI buyer replies & lowball handlers\n` +
          `→ Product research across Depop, Vinted & eBay\n` +
          `→ Cross-listing generator\n` +
          `→ Profit margin breakdowns\n` +
          `→ Competitor tracking\n` +
          `→ Private session channels\n\n` +
          `**Plans from £9.99/month.**\n${SITE_URL}`
        )
        .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
    ]});
    console.log(`[join] Sent pitch DM to ${member.user.tag}`);
  } catch { /* DMs closed */ }
});

client.on('interactionCreate', async (interaction) => {
  // ── Button interactions ──────────────────────────────────────────────────────
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('spam_')) {
      await handleSpamButton(interaction).catch(e => console.error('[button] spam error:', e.message));
    } else if (interaction.customId.startsWith('open_ticket_')) {
      await handleOpenTicketButton(interaction).catch(e => console.error('[button] open_ticket error:', e.message));
    } else if (interaction.customId === 'ticket_open_direct') {
      await handleTicketDirectButton(interaction).catch(e => console.error('[button] ticket_direct error:', e.message));
    }
    return;
  }

  // ── Modal submissions ────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('ticket_modal_')) {
      await handleTicketModalSubmit(interaction).catch(e => console.error('[modal] ticket error:', e.message));
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  // Defer ephemerally — all responses are private
  try { await interaction.deferReply({ ephemeral: true }); }
  catch { return; }

  // Get subscriber profile
  const profile = await getProfileByDiscordId(user.id);

  // Banned check (owner bypasses)
  if (user.id !== OWNER_ID && profile?.is_banned) {
    return interaction.editReply({ embeds: [
      baseEmbed('#f87171').setTitle('Account Suspended')
        .setDescription('Your Vendora account has been suspended. Please contact the server admins if you believe this is a mistake.')
    ]});
  }

  // Unsubscribed check (owner bypasses)
  if (user.id !== OWNER_ID) {
    if (!profile || profile.subscription_status !== 'active') {
      return interaction.editReply({ embeds: [unsubscribedEmbed()] });
    }
  }

  const tier = user.id === OWNER_ID ? 'elite' : (profile?.tier || 'none');

  // Tier gate check
  const requiredTier = CMD_TIER_REQUIRED[commandName];
  if (requiredTier && TIER_RANK[tier] < TIER_RANK[requiredTier]) {
    return interaction.editReply({ embeds: [tierGateEmbed(commandName, requiredTier)] });
  }

  // Rate limit check (owner bypasses)
  if (user.id !== OWNER_ID) {
    const rl = checkRateLimit(user.id, commandName, tier);
    if (!rl.allowed) {
      if (rl.reason === 'tier_blocked') return interaction.editReply({ embeds: [tierGateEmbed(commandName, 'pro')] });
      return interaction.editReply({ embeds: [rateLimitEmbed(commandName, tier, rl)] });
    }
  }

  try {
    await executeCommand(interaction, commandName, tier, profile);
  } catch (err) {
    console.error(`[cmd] Error in /${commandName}:`, err.message);
    try {
      await interaction.editReply({ embeds: [
        baseEmbed('#f87171').setTitle('Something went wrong')
          .setDescription('An error occurred processing your command. Please try again.')
      ]});
    } catch { /* already replied */ }
  }
});

// ── Express server ────────────────────────────────────────────────────────────
const app = express();

// CORS must come BEFORE express.json() so that errors from body parsing
// (e.g. 413 Payload Too Large) still include CORS headers and the browser
// can read the error response instead of throwing a network error.
// Allow-list of dashboard origins. Add new hosts here as deployments change.
const CORS_ALLOWED_ORIGINS = new Set([
  'https://vendora.site',
  'https://www.vendora.site',
  'https://vendora-vv.netlify.app', // legacy Netlify host (kept during cutover)
  'https://vendora.app',
  'https://www.vendora.app',
  'https://vendora.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'null', // file:// origins
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Echo back the origin if it's in the allow-list, otherwise fall back to the
  // primary Netlify host. We echo (not "*") so Authorization headers are accepted.
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (origin && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    // Preview deployments on Vercel
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://vendora.site');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Whop signs the EXACT bytes it sent, so this route must keep its raw body.
// It has to be registered before express.json() below, or the JSON parser
// consumes the stream first and the signature can never be reproduced.
app.use('/whop-webhook', express.raw({ type: '*/*', limit: '1mb' }));

// Increase body size limit to 25 MB to handle base64-encoded image uploads
app.use(express.json({ limit: '25mb' }));

app.get('/', (_req, res) => res.json({ status: 'ok', bot: client.user?.tag || 'connecting...' }));

// Cross-listing API — called from the dashboard
app.post('/api/crosslist', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const authUser = await verifySupabaseToken(token);
  if (!authUser) return res.status(401).json({ error: 'Invalid token' });

  const discordId = authUser.user_metadata?.provider_id
    || authUser.identities?.find(i => i.provider === 'discord')?.id;

  const profile = discordId ? await getProfileByDiscordId(discordId) : null;
  if (!profile || profile.subscription_status !== 'active') {
    return res.status(403).json({ error: 'Active subscription required' });
  }
  if (TIER_RANK[profile.tier] < TIER_RANK.pro) {
    return res.status(403).json({ error: 'Pro subscription required' });
  }

  const { item, description, condition, price, platforms = ['depop', 'vinted', 'ebay'] } = req.body;
  if (!item) return res.status(400).json({ error: 'Item name required' });

  if (!ai) return res.status(503).json({ error: 'AI unavailable' });

  const platformSection = platforms.map(p => {
    if (p === 'depop')  return '"depop": { "title": "...", "description": "...", "price": 0, "hashtags": ["..."] }';
    if (p === 'vinted') return '"vinted": { "title": "...", "description": "...", "price": 0, "brand": "...", "size": "..." }';
    if (p === 'ebay')   return '"ebay": { "title": "...", "description": "...", "price": 0, "condition": "..." }';
  }).join(',\n  ');

  const prompt = `Generate optimised cross-platform resale listings AND outreach suggestions. Return ONLY valid JSON, no markdown.

Item: ${item}${description ? `\nDescription: ${description}` : ''}${condition ? `\nCondition: ${condition}` : ''}${price ? `\nAsking price: £${price}` : ''}
Platforms: ${platforms.join(', ')}

Rules:
- depop: casual UK tone, title 60-80 chars, 8-10 hashtags (no #), suggest realistic GBP price
- vinted: clean descriptive title, requires brand and size (estimate if unknown), suggest price

Return JSON with this exact structure:
{
  ${platformSection},
  "suggestions": [
    "One specific tip to increase visibility or sell faster (e.g. pricing, timing, photos)",
    "One tip about the item keywords or audience targeting",
    "One tip about cross-platform strategy or republishing cadence"
  ]
}`;

  try {
    const msg = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1600,
      messages: [{ role: 'user', content: prompt }],
    });
    const text      = msg.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Generation failed — could not parse response' });
    const parsed = JSON.parse(jsonMatch[0]);
    const { suggestions, ...listings } = parsed;
    return res.json({ ok: true, listings, suggestions: suggestions || [] });
  } catch (e) {
    console.error('[/api/crosslist] Error:', e.message);
    return res.status(500).json({ error: 'Generation failed' });
  }
});

// Research API — called from the dashboard
app.post('/api/research', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const authUser = await verifySupabaseToken(token);
  if (!authUser) return res.status(401).json({ error: 'Invalid token' });

  const { item, platform } = req.body;
  if (!item) return res.status(400).json({ error: 'Item required' });

  let results = null;
  if (platform === 'depop')  results = await searchDepop(item);
  if (platform === 'vinted') results = await searchVinted(item);
  if (platform === 'ebay')   results = await searchEbay(item);

  return res.json({ ok: true, results: results || [] });
});

// ── Inventory API — called from the dashboard ─────────────────────────────────

// Helper: get discord_id from a verified Supabase auth user object
function discordIdFromUser(user) {
  return user?.user_metadata?.provider_id
    || user?.identities?.find(i => i.provider === 'discord')?.id
    || null;
}

// GET /api/inventory — return the Vinted-auto-synced inventory snapshot.
// If connected but no snapshot yet (first load after connect), auto-triggers
// a background sync and returns syncing:true so the dashboard can show a spinner.
app.get('/api/inventory', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.pro) return res.status(403).json({ error: 'Pro subscription required.' });
  const conn = await getPlatformConn(user.id, 'vinted');
  if (!conn) return res.json({ ok: true, items: [], connected: false });
  const snap = (await getSetting(`vinted_inventory_${user.id}`)) || { items: [], last_synced: null };
  const items = snap.items || [];

  // Auto-trigger a background sync if Vinted is connected but we have no items yet
  if (items.length === 0 && !snap.last_synced) {
    syncVintedInventoryForUser(user.id).catch(e => console.warn('[auto-sync]', e.message));
    return res.json({
      ok: true, connected: true, syncing: true,
      username: conn.platform_username, last_synced: null, items: [],
    });
  }

  // Enrich with days-listed + stale flag (Elite stale-listing detection).
  const now = Date.now();
  const isElite = TIER_RANK[profile.tier] >= TIER_RANK.elite;
  const analysis = isElite ? ((await getSetting(`inventory_analysis_${user.id}`)) || {}) : {};
  const analysisById = {};
  for (const a of (analysis.items || [])) if (a.id) analysisById[a.id] = a;
  const enriched = items.map(it => {
    const daysListed = it.first_seen_at ? Math.floor((now - new Date(it.first_seen_at).getTime()) / 86400000) : null;
    const a = analysisById[it.id];
    return {
      ...it,
      days_listed: daysListed,
      stale: isElite && daysListed != null && daysListed >= STALE_LISTING_DAYS && (it.status || 'active') === 'active',
      score: a?.score ?? null,
      suggested_price: a?.suggested_price ?? null,
    };
  });

  return res.json({
    ok: true,
    connected: true,
    syncing: false,
    tier: profile.tier,
    username: conn.platform_username,
    last_synced: snap.last_synced,
    sync_note: snap.sync_note || null,
    analysis_at: analysis.generated_at || null,
    items: enriched,
  });
});

// Supabase DB webhook — profile INSERT/UPDATE
app.post('/webhook', async (req, res) => {
  console.log('[webhook] Received from', req.ip);
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    console.warn('[webhook] Rejected — bad secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, record, old_record } = req.body || {};
  console.log('[webhook] type:', type, '| discord_id:', record?.discord_id, '| tier:', record?.tier, '| status:', record?.subscription_status);

  if (!record || !['INSERT', 'UPDATE'].includes(type)) return res.json({ ok: true, note: 'ignored' });

  const { discord_id, tier, subscription_status, username } = record;
  if (!discord_id) return res.json({ ok: true, note: 'no discord_id' });

  // Gate: only fire the subscription DM/role flow when tier OR subscription_status actually changed.
  // This prevents credit adjustments (or any other PATCH on profiles) from re-triggering subscription DMs.
  if (type === 'UPDATE' && old_record) {
    const tierChanged   = old_record.tier !== record.tier;
    const statusChanged = old_record.subscription_status !== record.subscription_status;
    if (!tierChanged && !statusChanged) {
      console.log('[webhook] No tier/status change — ignoring update');
      return res.json({ ok: true, note: 'no_subscription_change' });
    }
  }

  try {
    const guild  = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discord_id).catch(() => null);

    if (!member) {
      console.log(`[webhook] Member ${discord_id} not in server`);
      return res.json({ ok: true, note: 'member_not_in_server' });
    }

    if (subscription_status === 'active' && tier && ROLE_IDS[tier]) {
      await assignRole(member, tier);
      const isNew = type === 'INSERT';
      await sendDM(member, { embeds: [
        new EmbedBuilder().setColor(TIER_COLOR[tier] || '#e8217a')
          .setTitle(`Vendora ${TIER_NAMES[tier]} ${isNew ? 'Active' : 'Updated'}`)
          .setDescription(
            `Your **${TIER_NAMES[tier]}** subscription is active.\n\n` +
            `**What's unlocked:**\n` +
            (TIER_RANK[tier] >= 1 ? '→ `/reply` `/lowball` `/price` `/help` `/session`\n' : '') +
            (TIER_RANK[tier] >= 2 ? '→ `/scan` `/research` `/margins` `/pricedrop` `/trends` and more\n' : '') +
            (TIER_RANK[tier] >= 3 ? '→ All Elite commands including `/flip` `/grade` `/negotiate`\n' : '') +
            `\nManage your account: ${DASHBOARD_URL}`
          )
          .addFields(
            { name: 'Plan',    value: `${TIER_NAMES[tier]} — ${TIER_PRICES[tier]}/mo`, inline: true },
            { name: 'Channel', value: '#use-vendora', inline: true }
          )
          .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
      ]});

      // Owner notification — new subscriber
      if (type === 'INSERT') {
        await sendOwnerDM(guild, { embeds: [
          new EmbedBuilder().setColor('#4ade80')
            .setTitle('New Subscriber')
            .addFields(
              { name: 'User',    value: username || member.user.tag, inline: true },
              { name: 'Tier',    value: `${TIER_NAMES[tier]} — ${TIER_PRICES[tier]}/mo`, inline: true },
              { name: 'Discord', value: `<@${discord_id}>`, inline: true }
            )
            .setFooter({ text: 'Vendora Admin' })
        ]});
      }

    } else if (['inactive', 'cancelled'].includes(subscription_status)) {
      await assignRole(member, null);
      await sendDM(member, { embeds: [
        new EmbedBuilder().setColor('#f87171')
          .setTitle('Vendora Subscription Ended')
          .setDescription(`Your subscription has ended and your access role has been removed.\n\nResubscribe anytime: ${DASHBOARD_URL}`)
          .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
      ]});

      // Owner notification — cancellation
      await sendOwnerDM(guild, { embeds: [
        new EmbedBuilder().setColor('#f87171')
          .setTitle('Subscription Cancelled')
          .addFields(
            { name: 'User',    value: username || member.user.tag, inline: true },
            { name: 'Discord', value: `<@${discord_id}>`, inline: true }
          )
          .setFooter({ text: 'Vendora Admin' })
      ]});
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

  const cancelEvents = ['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED'];
  if (!cancelEvents.includes(eventType) || !subId) return res.json({ ok: true });

  const { data, error } = await updateProfile('paypal_subscription_id', subId, {
    subscription_status: 'inactive',
    tier: 'none',
    paypal_subscription_id: null,
  });

  if (error) { console.error('[paypal] Profile update failed:', error); return res.status(500).json({ error }); }
  console.log(`[paypal] Marked ${subId} inactive — rows: ${data?.length || 0}`);
  res.json({ ok: true });
});

// ── Whop ──────────────────────────────────────────────────────────────────────
// Whop is an ALTERNATIVE way to buy a plan, running alongside PayPal — not a
// replacement. Both providers write the same two entitlement fields on profiles
// (tier + subscription_status). The Supabase DB webhook above then assigns the
// Discord role and DMs the user, so nothing here touches roles directly:
// granting a tier is a single PATCH.
//
// IMPORTANT: Whop's own Discord role automation must stay OFF for these plans.
// assignRole() strips every other tier role when it runs, so two systems
// managing the same role ids will fight and flap the user's roles.
//
// Identity is the hard part: Whop's webhook payload contains no Discord id.
// Two paths, in order of preference:
//   1. metadata.discord_id — set when checkout started from the dashboard
//      (see POST /api/whop/checkout), so the buyer is known immediately.
//   2. a claim code — for purchases made from Whop's own marketplace, where we
//      never controlled the checkout. The membership is still recorded; the
//      buyer binds it to their Discord account later via POST /api/whop/claim.
// A purchase is NEVER dropped just because we can't identify the buyer yet.

const WHOP_API_BASE = 'https://api.whop.com/api/v1';
const WHOP_SB_HEADERS = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
});

// Whop follows the Standard Webhooks spec: HMAC-SHA256 over "{id}.{timestamp}.{body}"
// using the base64-decoded secret, compared against the base64 signature.
function verifyWhopSignature(rawBody, headers) {
  if (!WHOP_WEBHOOK_SECRET) return { ok: false, reason: 'WHOP_WEBHOOK_SECRET not set' };

  const id  = headers['webhook-id'];
  const ts  = headers['webhook-timestamp'];
  const sig = headers['webhook-signature'];
  if (!id || !ts || !sig) return { ok: false, reason: 'missing webhook-* headers' };

  // Reject replays. Standard Webhooks recommends a 5 minute tolerance.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: `timestamp outside 5m window (${Math.round(age)}s)` };

  // Standard Webhooks says the secret is base64. Whop issues secrets prefixed
  // "ws_" (not the spec's "whsec_") and does not document how the remainder is
  // encoded — and a hex string is also valid base64 input, so it cannot be told
  // apart by inspection. Rather than guess, try each plausible derivation and
  // report which one matched, so the encoding can be pinned from the logs.
  // This is not a security weakening: every candidate is derived from the real
  // secret, so anyone without it can still forge none of them.
  const body = String(WHOP_WEBHOOK_SECRET).replace(/^(whsec_|ws_)/, '');
  const candidates = [
    ['base64', Buffer.from(body, 'base64')],
    ['hex',    /^[0-9a-fA-F]+$/.test(body) && body.length % 2 === 0 ? Buffer.from(body, 'hex') : null],
    ['utf8',   Buffer.from(body, 'utf8')],
    ['utf8-with-prefix', Buffer.from(String(WHOP_WEBHOOK_SECRET), 'utf8')],
  ].filter(([, k]) => k && k.length);

  // The header is a space-separated list of "v1,<sig>" pairs — more than one is
  // present while a secret is being rotated, and any single match is valid.
  const provided = String(sig).split(' ').map(p => p.split(',')[1]).filter(Boolean);
  const signedContent = `${id}.${ts}.${rawBody.toString('utf8')}`;

  const seen = new Set();
  for (const [label, key] of candidates) {
    const fingerprint = key.toString('hex');
    if (seen.has(fingerprint)) continue; // two encodings collapsed to the same bytes
    seen.add(fingerprint);

    const expected = Buffer.from(crypto.createHmac('sha256', key).update(signedContent).digest('base64'));
    const hit = provided.some(p => {
      const got = Buffer.from(p);
      return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    });
    if (hit) return { ok: true, encoding: label };
  }

  return { ok: false, reason: 'signature mismatch' };
}

// Pull the fields we care about out of a membership payload. Whop nests some of
// these as objects and some as bare ids depending on the event, so each field
// checks a couple of shapes rather than assuming one.
function parseWhopMembership(data) {
  const pick = (...vals) => vals.find(v => typeof v === 'string' && v) || null;
  const planId = pick(data?.plan?.id, data?.plan_id, data?.plan);
  return {
    membership_id: pick(data?.id, data?.membership_id, data?.membership?.id),
    whop_user_id:  pick(data?.user?.id, data?.user_id, data?.user),
    whop_email:    pick(data?.user?.email, data?.email),
    plan_id:       planId,
    product_id:    pick(data?.product?.id, data?.product_id, data?.access_pass?.id),
    status:        pick(data?.status, data?.membership?.status),
    tier:          planId ? (WHOP_PLAN_TIERS[planId] || null) : null,
    metadata:      data?.metadata || {},
  };
}

async function upsertWhopMembership(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/whop_memberships?on_conflict=membership_id`, {
    method: 'POST',
    headers: { ...WHOP_SB_HEADERS(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
  const text = await res.text();
  if (!res.ok) { console.error('[whop] membership upsert failed:', text); return null; }
  return JSON.parse(text || '[]')[0] || null;
}

// Write the tier onto the user's profile. Everything downstream (Discord role,
// welcome DM, dashboard unlock) is triggered by the Supabase DB webhook.
async function grantWhopTier(discordId, membershipId, tier) {
  const profile = await getProfileByDiscordId(discordId);
  if (!profile) return { error: 'no profile for discord_id ' + discordId };

  // Conflict case: this user already has an ACTIVE subscription from another
  // provider (almost always PayPal). We don't silently clobber it — we grant
  // whichever tier is higher so the customer is never worse off, and flag it to
  // the owner, because they are now being billed twice and need a refund or a
  // cancellation on one side. Only a human can decide which.
  const otherSource = profile.subscription_source && profile.subscription_source !== 'whop';
  const doubleBilled = profile.subscription_status === 'active' &&
                       (otherSource || (!profile.subscription_source && profile.paypal_subscription_id));

  let finalTier = tier;
  if (doubleBilled) {
    const existing = profile.tier || 'none';
    if ((TIER_RANK[existing] || 0) > (TIER_RANK[tier] || 0)) finalTier = existing;
    console.warn(`[whop] DOUBLE BILLING — ${discordId} has an active ${profile.subscription_source || 'paypal'} sub (${existing}) and bought ${tier} on Whop. Granting ${finalTier}.`);
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (guild) {
      await sendOwnerDM(guild, { embeds: [
        new EmbedBuilder().setColor('#e8a121')
          .setTitle('Double subscription detected')
          .setDescription(
            `<@${discordId}> just bought **${TIER_NAMES[tier]}** on Whop but already has an active ` +
            `**${TIER_NAMES[existing] || existing}** subscription via ${profile.subscription_source || 'PayPal'}.\n\n` +
            `They are being billed twice. Granted **${TIER_NAMES[finalTier]}** (the higher tier) — ` +
            `refund or cancel one side manually.`
          )
          .addFields({ name: 'Whop membership', value: membershipId, inline: true })
      ]});
    }
  }

  const { data, error } = await updateProfile('discord_id', discordId, {
    tier: finalTier,
    subscription_status: 'active',
    subscription_source: 'whop',
    whop_membership_id: membershipId,
  });
  if (error) return { error };
  console.log(`[whop] Granted ${finalTier} to ${discordId} (membership ${membershipId})`);
  return { data };
}

// Revoke ONLY if this membership is the one currently granting access. The
// whop_membership_id filter is what keeps a Whop cancellation from touching a
// PayPal subscriber — and stops a stale membership from revoking a newer one.
async function revokeWhopTier(membershipId) {
  const { data, error } = await updateProfile('whop_membership_id', membershipId, {
    tier: 'none',
    subscription_status: 'inactive',
    subscription_source: null,
    whop_membership_id: null,
  });
  if (error) { console.error('[whop] revoke failed:', error); return; }
  console.log(`[whop] Revoked membership ${membershipId} — rows: ${data?.length || 0}`);
}

app.post('/whop-webhook', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  const verdict = verifyWhopSignature(raw, req.headers);
  if (!verdict.ok) {
    console.warn('[whop] Rejected webhook —', verdict.reason);
    return res.status(401).json({ error: 'Invalid signature' });
  }
  // Which secret encoding Whop actually signs with — see verifyWhopSignature.
  // Once this is consistent across real events, drop the other candidates.
  console.log('[whop] Signature verified (secret encoding:', verdict.encoding + ')');

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const event = body?.action || body?.event || body?.type;
  const data  = body?.data || body?.payload || body;
  console.log('[whop] Event:', event);

  // Ack fast. Whop retries on non-2xx, and we've already verified + parsed;
  // any failure past this point is ours to fix from logs, not worth a retry storm.
  res.json({ ok: true });

  try {
    const m = parseWhopMembership(data);
    if (!m.membership_id) { console.warn('[whop] No membership id in payload — ignoring'); return; }

    // Unmapped plan = a plan id env var is wrong or a new plan was added in Whop.
    // Record it anyway so the purchase is recoverable, and shout about it.
    if (!m.tier) {
      console.error(`[whop] UNMAPPED PLAN "${m.plan_id}" on membership ${m.membership_id} — check WHOP_PLAN_BASIC/PRO/ELITE. Full payload:`, JSON.stringify(data));
    }

    const metaDiscordId = typeof m.metadata?.discord_id === 'string' ? m.metadata.discord_id : null;
    const entitled = WHOP_ACTIVE_STATUSES.has(String(m.status || '').toLowerCase());
    const deactivating = /deactivat|cancel|expire|invalid/i.test(String(event || ''));

    // Existing row wins for discord_id — a membership already claimed by a user
    // must never be re-pointed at someone else by a later webhook.
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/whop_memberships?membership_id=eq.${encodeURIComponent(m.membership_id)}&select=*`,
      { headers: WHOP_SB_HEADERS() }
    ).catch(() => null);
    const existing = existingRes?.ok ? (await existingRes.json())[0] : null;

    // Checkout metadata is only trustworthy if it actually resolves to a profile.
    // A stale, hand-made or test checkout link can carry a discord_id that no
    // longer exists — binding to it would leave the buyer with no tier AND no
    // claim code, i.e. paid and permanently stuck. Fall back to the claim flow.
    let discordId = existing?.discord_id || null;
    if (!discordId && metaDiscordId) {
      if (await getProfileByDiscordId(metaDiscordId)) discordId = metaDiscordId;
      else console.warn(`[whop] metadata.discord_id ${metaDiscordId} has no profile — falling back to claim code`);
    }

    const stored = await upsertWhopMembership({
      membership_id: m.membership_id,
      whop_user_id:  m.whop_user_id,
      whop_email:    m.whop_email,
      plan_id:       m.plan_id,
      product_id:    m.product_id,
      status:        m.status,
      tier:          m.tier,
      discord_id:    discordId,
      // Only mint a claim code when we genuinely can't identify the buyer.
      claim_code:    existing?.claim_code || (discordId ? null : crypto.randomBytes(5).toString('hex').toUpperCase()),
      claimed_at:    existing?.claimed_at || (discordId ? new Date().toISOString() : null),
      raw:           data,
    });

    if (deactivating || !entitled) { await revokeWhopTier(m.membership_id); return; }
    if (!m.tier) return; // entitled but we don't know to what — owner must fix the mapping

    if (!discordId) {
      console.log(`[whop] Membership ${m.membership_id} (${m.tier}) unclaimed — claim code ${stored?.claim_code}`);
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (guild) {
        await sendOwnerDM(guild, { embeds: [
          new EmbedBuilder().setColor('#e8217a')
            .setTitle('Unclaimed Whop purchase')
            .setDescription(
              `Someone bought **${TIER_NAMES[m.tier]}** on Whop without going through the dashboard, ` +
              `so we don't know their Discord account yet.\n\n` +
              `They need to sign in at ${SITE_URL} and enter their claim code.`
            )
            .addFields(
              { name: 'Claim code', value: stored?.claim_code || 'n/a', inline: true },
              { name: 'Email',      value: m.whop_email || 'unknown',   inline: true }
            )
        ]});
      }
      return;
    }

    await grantWhopTier(discordId, m.membership_id, m.tier);
  } catch (e) {
    console.error('[whop] Handler error:', e);
  }
});

// POST /api/whop/checkout — mint a Whop checkout link that carries the buyer's
// Discord id as metadata, so the webhook can identify them without a claim step.
// Metadata cannot be added as a plain URL query param; it has to be baked into a
// server-created checkout configuration.
app.post('/api/whop/checkout', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id || user.identities?.find(i => i.provider === 'discord')?.id;
  if (!discordId) return res.status(400).json({ error: 'No Discord identity on this account' });

  const { tier } = req.body || {};
  if (!['basic', 'pro', 'elite'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });

  const planId = Object.keys(WHOP_PLAN_TIERS).find(k => WHOP_PLAN_TIERS[k] === tier);
  if (!planId) return res.status(503).json({ error: 'Whop checkout is not configured for this tier' });
  if (!WHOP_API_KEY) return res.status(503).json({ error: 'Whop checkout unavailable' });

  try {
    const r = await fetch(`${WHOP_API_BASE}/checkout_configurations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHOP_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan_id: planId,
        metadata: { discord_id: discordId, source: 'vendora_dashboard' },
        redirect_url: DASHBOARD_URL, // land back on the dashboard after paying
      }),
    });
    const out = await r.json().catch(() => ({}));

    if (!r.ok || !out?.purchase_url) {
      // Fall back to the bare plan link. The buyer can still pay — they just land
      // in the claim flow afterwards instead of being matched automatically.
      console.error('[whop] checkout config failed:', r.status, JSON.stringify(out));
      return res.json({ url: `https://whop.com/checkout/${planId}`, matched: false });
    }

    const url = out.purchase_url.startsWith('http') ? out.purchase_url : `https://whop.com${out.purchase_url}`;
    return res.json({ url, matched: true });
  } catch (e) {
    console.error('[whop] checkout error:', e.message);
    return res.status(502).json({ error: 'Could not start Whop checkout' });
  }
});

// POST /api/whop/claim — bind a Whop purchase made outside the dashboard to the
// signed-in Discord account. The claim code is effectively a bearer token for a
// paid plan, so it is single-use and never returned by any read endpoint.
app.post('/api/whop/claim', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id || user.identities?.find(i => i.provider === 'discord')?.id;
  if (!discordId) return res.status(400).json({ error: 'No Discord identity on this account' });

  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[0-9A-F]{10}$/.test(code)) return res.status(400).json({ error: 'Invalid claim code' });

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/whop_memberships?claim_code=eq.${encodeURIComponent(code)}&select=*`,
    { headers: WHOP_SB_HEADERS() }
  ).catch(() => null);
  const row = r?.ok ? (await r.json())[0] : null;

  if (!row)             return res.status(404).json({ error: 'Claim code not found' });
  if (row.discord_id)   return res.status(409).json({ error: 'This purchase has already been claimed' });
  if (!row.tier)        return res.status(409).json({ error: 'This plan is not set up yet — contact support' });
  if (!WHOP_ACTIVE_STATUSES.has(String(row.status || '').toLowerCase())) {
    return res.status(409).json({ error: 'This membership is no longer active' });
  }

  // Burn the code as we bind it. The claim_code=is.null guard makes this atomic:
  // two racing requests cannot both match, so a code can only ever be spent once.
  const claimRes = await fetch(
    `${SUPABASE_URL}/rest/v1/whop_memberships?membership_id=eq.${encodeURIComponent(row.membership_id)}&discord_id=is.null`,
    {
      method: 'PATCH',
      headers: { ...WHOP_SB_HEADERS(), Prefer: 'return=representation' },
      body: JSON.stringify({ discord_id: discordId, claim_code: null, claimed_at: new Date().toISOString() }),
    }
  );
  const claimed = claimRes.ok ? await claimRes.json() : [];
  if (!claimed.length) return res.status(409).json({ error: 'This purchase has already been claimed' });

  const { error } = await grantWhopTier(discordId, row.membership_id, row.tier);
  if (error) { console.error('[whop] claim grant failed:', error); return res.status(500).json({ error: 'Could not apply your plan' }); }

  console.log(`[whop] ${discordId} claimed membership ${row.membership_id} (${row.tier})`);
  res.json({ ok: true, tier: row.tier });
});

// ── Crosslist job scheduler ────────────────────────────────────────────────────
// Checks every 30 minutes for jobs where next_post_at <= now, DMs the user
async function runCrosslistScheduler() {
  if (!SUPABASE_KEY) return;
  const now = new Date().toISOString();
  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  const jobsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/crosslist_jobs?active=eq.true&next_post_at=lte.${encodeURIComponent(now)}&select=*`,
    { headers: SB_HEADERS }
  ).catch(() => null);
  if (!jobsRes?.ok) return;
  const jobs = await jobsRes.json().catch(() => []);
  if (!jobs?.length) return;

  for (const job of jobs) {
    try {
      const nextPost = new Date(Date.now() + job.interval_hours * 60 * 60 * 1000).toISOString();

      await fetch(`${SUPABASE_URL}/rest/v1/crosslist_jobs?id=eq.${job.id}`, {
        method: 'PATCH',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_posted_at: now, next_post_at: nextPost }),
      });

      if (!job.discord_id) continue;
      const guild  = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) continue;
      const member = await guild.members.fetch(job.discord_id).catch(() => null);
      if (!member) continue;

      const platformList = (job.platforms || []).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');
      await sendDM(member, { embeds: [
        new EmbedBuilder()
          .setColor('#e8217a')
          .setTitle('Time to Republish Your Listing')
          .setDescription(
            `Your auto-republish job for **${job.item_name}** is ready.\n\n` +
            `Delete and re-list on ${platformList} to boost visibility.\n\n` +
            `→ [Open Cross-List Tool](${DASHBOARD_URL})`
          )
          .addFields(
            { name: 'Item',      value: job.item_name, inline: true },
            { name: 'Platforms', value: platformList,  inline: true },
            { name: 'Schedule',  value: `Every ${job.interval_hours >= 168 ? Math.round(job.interval_hours / 168) + ' week(s)' : job.interval_hours + 'h'}`, inline: true }
          )
          .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
      ]});
    } catch (e) {
      console.error('[scheduler] Job error:', job.id, e.message);
    }
  }
}

// ── Token encryption ──────────────────────────────────────────────────────────
// Derive a stable 32-byte key from the Supabase service key so no extra env var needed
const ENCRYPT_KEY = SUPABASE_KEY
  ? crypto.createHash('sha256').update(SUPABASE_KEY).digest()
  : crypto.randomBytes(32);

function encryptToken(text) {
  try {
    const iv      = crypto.randomBytes(16);
    const cipher  = crypto.createCipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
    const enc     = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag     = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
  } catch { return text; }
}

function decryptToken(enc) {
  if (!enc) return '';
  // Encrypted values are "ivHex:tagHex:dataHex" (three hex segments, no dots).
  // A raw/plaintext token (e.g. a JWT) contains dots and no colons — pass it through.
  const looksEncrypted = enc.includes(':') && !enc.includes('.');
  if (!looksEncrypted) return enc; // plaintext / legacy token
  try {
    const [ivHex, tagHex, dataHex] = enc.split(':');
    const iv      = Buffer.from(ivHex, 'hex');
    const tag     = Buffer.from(tagHex, 'hex');
    const data    = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Decryption failed — almost always means ENCRYPT_KEY (derived from
    // SUPABASE_SERVICE_KEY) changed since the token was saved. Return empty
    // so callers treat it as "no token / reconnect" instead of sending the
    // ciphertext as a Bearer token (which causes confusing 401s).
    console.warn('[decrypt] token decryption failed — key may have changed; treating as missing');
    return '';
  }
}

// ── Platform connection DB helpers ────────────────────────────────────────────
async function getPlatformConn(userId, platform) {
  if (!SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_connections?user_id=eq.${userId}&platform=eq.${platform}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows[0] || null;
  } catch { return null; }
}

async function upsertPlatformConn(userId, platform, data) {
  if (!SUPABASE_KEY) return { error: 'SUPABASE_SERVICE_KEY not configured on server' };
  try {
    // Check if a row already exists — if so, PATCH it; otherwise POST (insert).
    // This avoids relying on PostgREST's merge-duplicates which requires a
    // specific unique constraint name and breaks with 409 on some schema setups.
    const existing = await getPlatformConn(userId, platform);
    if (existing) {
      // UPDATE existing row
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/platform_connections?user_id=eq.${userId}&platform=eq.${platform}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: 'return=representation',
          },
          body: JSON.stringify(data),
        }
      );
      const text = await res.text();
      if (!res.ok) {
        console.error(`[upsertPlatformConn] PATCH ${platform} HTTP ${res.status}:`, text.slice(0, 200));
        return { error: `Database error (${res.status}): ${text.slice(0, 100)}` };
      }
      return { ok: true };
    } else {
      // INSERT new row
      const res = await fetch(`${SUPABASE_URL}/rest/v1/platform_connections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ user_id: userId, platform, ...data }),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(`[upsertPlatformConn] POST ${platform} HTTP ${res.status}:`, text.slice(0, 200));
        return { error: `Database error (${res.status}): ${text.slice(0, 100)}` };
      }
      return { ok: true };
    }
  } catch (e) { return { error: e.message }; }
}

async function deletePlatformConn(userId, platform) {
  if (!SUPABASE_KEY) return;
  await fetch(
    `${SUPABASE_URL}/rest/v1/platform_connections?user_id=eq.${userId}&platform=eq.${platform}`,
    { method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
}

// ── Listings DB helpers ───────────────────────────────────────────────────────
async function createListingRecord(userId, data) {
  if (!SUPABASE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/listings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ user_id: userId, ...data }),
    });
    const rows = await res.json();
    return rows[0] || null;
  } catch { return null; }
}

async function getListingsByUser(userId) {
  if (!SUPABASE_KEY) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/listings?user_id=eq.${userId}&status=neq.deleted&order=created_at.desc&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return await res.json();
  } catch { return []; }
}

async function getListingById(listingId) {
  if (!SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/listings?id=eq.${listingId}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows[0] || null;
  } catch { return null; }
}

async function updateListingRecord(listingId, data) {
  if (!SUPABASE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/listings?id=eq.${listingId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
}

async function getDueRelists() {
  if (!SUPABASE_KEY) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/listings?auto_relist=eq.true&status=eq.active&next_relist_at=lte.${new Date().toISOString()}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return await res.json();
  } catch { return []; }
}

// ── Depop API ─────────────────────────────────────────────────────────────────
const DEPOP_UA   = 'Depop/3.15.0 (iPhone14,2; iOS 16.3.1; Scale/3.0)';
const DEPOP_HEADERS = (token) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`,
  'User-Agent': DEPOP_UA,
  'Accept': 'application/json',
  'Accept-Language': 'en-GB,en;q=0.9',
  'X-Depop-Client-Version': '3.15.0',
});

async function depopLogin(email, password) {
  try {
    const deviceId = crypto.randomUUID();
    // Try both field name variants (API has changed over time)
    for (const body of [
      { email, password, device_id: deviceId },
      { login: email, password, device_id: deviceId },
    ]) {
      const res = await fetch('https://api.depop.com/api/v1/auth/email/login/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': DEPOP_UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-GB,en;q=0.9',
          'X-Depop-Client-Version': '3.15.0',
          'X-Depop-Device-Id': deviceId,
          'X-Depop-Platform': 'ios',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const rawText = await res.text();
      console.log(`[depop-login] status: ${res.status} body-key: ${Object.keys(body)[0]} preview: ${rawText.slice(0, 120)}`);
      let data;
      try { data = JSON.parse(rawText); } catch {
        if (res.status === 200) return { error: 'Depop returned an unexpected response. Check Railway logs.' };
        continue;
      }
      if (res.status === 401 || res.status === 403) return { error: 'Depop credentials invalid — check your email and password.' };
      if (res.status === 429) return { error: 'Depop rate limited — wait a few minutes and try again.' };
      if (!res.ok) {
        const msg = data?.message || data?.error_description || data?.error || '';
        if (msg) return { error: msg };
        continue; // try next body variant
      }
      const token = data.access_token;
      if (!token) continue;
      // Fetch username
      const meRes = await fetch('https://api.depop.com/api/v1/me/', {
        headers: DEPOP_HEADERS(token),
        signal: AbortSignal.timeout(8000),
      });
      const me = meRes.ok ? await meRes.json().catch(() => ({})) : {};
      return {
        access_token: token,
        refresh_token: data.refresh_token || '',
        platform_user_id: String(me.id || data.user_id || ''),
        platform_username: me.username || email.split('@')[0],
      };
    }
    return { error: 'Depop login failed — check your email and password.' };
  } catch (e) {
    if (e.name === 'TimeoutError') return { error: 'Depop request timed out — check your connection and try again.' };
    return { error: e.message };
  }
}

// Upload an image to Depop — returns { image_id } or { error }
async function depopUploadImage(accessToken, base64Data, mimeType = 'image/jpeg') {
  try {
    const boundary = `----FormBoundary${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      Buffer.from(base64Data, 'base64'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch('https://api.depop.com/api/v1/products/images/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': DEPOP_UA,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Accept': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { const e = await res.text(); return { error: `Depop image upload failed: ${e.slice(0, 80)}` }; }
    const data = await res.json();
    return { image_id: data.id || data.image_id };
  } catch (e) { return { error: e.message }; }
}

async function depopCreateListing(accessToken, listingData) {
  const {
    title, description = '', price, condition, image_ids = [],
    hashtags = '', depop_category_id = null,
  } = listingData;
  const condMap = { 'New with tags': 1, 'Like New': 2, 'Very Good': 3, 'Good': 4, 'Acceptable': 5 };
  try {
    // Build description: base text + hashtags appended
    const hashtagStr = hashtags
      ? '\n\n' + hashtags.split(/[\s,]+/).filter(Boolean).map(t => t.startsWith('#') ? t : `#${t}`).join(' ')
      : '';
    const fullDesc = `${title}\n\n${description}${hashtagStr}`.trim();

    const body = {
      description: fullDesc,
      price: Math.round(parseFloat(price) * 100),
      currency_name: 'GBP',
      category_id: depop_category_id || 20,
      status: 'active',
      source_country: 'gb',
      condition: condMap[condition] || 3,
    };
    if (image_ids.length) body.picture_ids = image_ids;

    const res = await fetch('https://api.depop.com/api/v1/products/', {
      method: 'POST',
      headers: DEPOP_HEADERS(accessToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = await res.text();
      return { error: `Depop: ${err.slice(0, 120)}` };
    }
    const data = await res.json();
    return { ok: true, listing_id: String(data.id || ''), url: `https://www.depop.com/products/${data.id}/` };
  } catch (e) { return { error: e.message }; }
}

async function depopDeleteListing(accessToken, listingId) {
  try {
    const res = await fetch(`https://api.depop.com/api/v1/products/${listingId}/`, {
      method: 'DELETE',
      headers: DEPOP_HEADERS(accessToken),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: res.ok || res.status === 204 };
  } catch (e) { return { error: e.message }; }
}

// ── Vinted API ────────────────────────────────────────────────────────────────

// vintedProxyOpts — kept for legacy non-Vinted calls (search helpers, pricedrop).
// NOTE: global fetch silently ignores `dispatcher` — use vFetch() for Vinted API calls.
function vintedProxyOpts(extraOpts = {}) {
  if (PROXY_AGENT) return { ...extraOpts, dispatcher: PROXY_AGENT };
  return extraOpts;
}

// vFetch — undici's own fetch with the shared proxy agent wired in.
// Must be used for all Vinted API calls so `dispatcher` is actually honoured.
// Also sanitises header values to Latin-1 (undici requires ByteStrings — any
// char > 255 in a header value throws "Cannot convert argument to a ByteString").
// This protects against DataDome cookies or user-pasted tokens with stray Unicode.
async function vFetch(url, opts = {}) {
  if (opts.headers) {
    const clean = {};
    for (const [k, v] of Object.entries(opts.headers)) {
      clean[k] = typeof v === 'string' ? v.replace(/[^\x00-\xFF]/g, '') : v;
    }
    opts = { ...opts, headers: clean };
  }
  if (PROXY_AGENT && undFetch) {
    return undFetch(url, { ...opts, dispatcher: PROXY_AGENT });
  }
  return fetch(url, opts); // fallback to global fetch (no proxy)
}

// apifyVFetch — same as vFetch but forces Apify's residential proxy regardless
// of PROXY_AGENT. Used as DataDome bypass when the primary proxy is blocked.
// apifyVFetch — fetches a URL through Apify's HTTP proxy using raw http.CONNECT.
// Bypasses undici ProxyAgent entirely: we tunnel through proxy.apify.com:8000
// and then make an HTTPS request to the destination over that socket.
// This gives us the actual proxy HTTP status code (200 = OK, 407 = bad password)
// so errors are always diagnosable.
async function apifyVFetch(url, opts = {}) {
  if (!APIFY_PROXY_READY) return null;

  const parsed   = new URL(url);
  const isHttps  = parsed.protocol === 'https:';
  const destPort = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);
  const destHost = parsed.hostname;
  const proxyAuth = Buffer.from(`auto:${APIFY_PROXY_PASSWORD}`).toString('base64');

  // Strip non-latin1 chars from headers (HTTP/1.1 header restriction)
  const rawHeaders = opts.headers || {};
  const cleanHeaders = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v == null) continue;
    cleanHeaders[k] = typeof v === 'string' ? v.replace(/[^\x00-\xFF]/g, '') : String(v);
  }

  // opts.timeout is the preferred way to pass a timeout to apifyVFetch.
  // AbortSignal.timeout() signals are not listened to here (apifyVFetch uses raw sockets),
  // so opts.signal?.timeout would always be undefined — use opts.timeout directly instead.
  const timeoutMs = opts.timeout ?? 45_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done  = (fn) => { if (settled) return; settled = true; fn(); };

    const timer = setTimeout(() => done(() => reject(new Error('apifyVFetch timeout'))), timeoutMs);

    // Step 1 — open TCP connection to proxy and send CONNECT
    const connectReq = nodeHttp.request({
      host:   'proxy.apify.com',
      port:   8000,
      method: 'CONNECT',
      path:   `${destHost}:${destPort}`,
      headers: { 'Proxy-Authorization': `Basic ${proxyAuth}`, 'Host': `${destHost}:${destPort}` },
    });

    connectReq.on('error', (e) => done(() => { clearTimeout(timer); reject(new Error(`Apify CONNECT error: ${e.message}`)); }));

    connectReq.on('connect', (connectRes, socket, head) => {
      if (connectRes.statusCode !== 200) {
        socket.destroy();
        const hint = connectRes.statusCode === 407
          ? ' (407 = wrong APIFY_PROXY_PASSWORD)'
          : connectRes.statusCode === 403
          ? ' (403 = plan restriction — "auto" group may require upgrade)'
          : '';
        return done(() => { clearTimeout(timer); reject(new Error(`Apify proxy CONNECT failed: HTTP ${connectRes.statusCode}${hint}`)); });
      }

      // Step 2 — wrap the socket in TLS (the Chrome-cipher TLS handshake goes here,
      // to Vinted, through the tunnel — exactly where it's supposed to be)
      const tlsSocket = nodeHttps.createConnection({
        socket,
        host:     destHost,
        servername: destHost,
        ciphers:  CHROME_CIPHERS,
        sigalgs:  CHROME_SIGALGS,
        rejectUnauthorized: true,
      });

      tlsSocket.on('error', (e) => done(() => { clearTimeout(timer); reject(new Error(`Apify TLS error: ${e.message}`)); }));

      // Step 3 — send the actual HTTP request through the TLS tunnel
      const path   = parsed.pathname + parsed.search;
      const method = (opts.method || 'GET').toUpperCase();
      const body   = opts.body ? String(opts.body) : null;

      const reqLines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${destHost}`,
        'Connection: close',
        ...Object.entries(cleanHeaders).map(([k, v]) => `${k}: ${v}`),
        ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []),
        '',
        body || '',
      ];
      tlsSocket.write(reqLines.join('\r\n'));

      // Step 4 — read the response
      const chunks = [];
      tlsSocket.on('data', (chunk) => { chunks.push(chunk); });
      tlsSocket.on('end', () => {
        done(() => {
          clearTimeout(timer);
          try {
            const raw        = Buffer.concat(chunks);
            const headerEnd  = raw.indexOf('\r\n\r\n');
            const headerBuf  = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
            const headerStr  = headerBuf.toString('utf8');
            let   bodyBuf    = headerEnd >= 0 ? raw.slice(headerEnd + 4) : Buffer.alloc(0);
            const statusLine = headerStr.split('\r\n')[0] || '';
            const statusCode = parseInt(statusLine.split(' ')[1] || '0', 10);
            const ok         = statusCode >= 200 && statusCode < 300;

            // Dechunk if Transfer-Encoding: chunked (HTTP/1.1 default for dynamic responses)
            if (/transfer-encoding:\s*chunked/i.test(headerStr)) {
              const decoded = [];
              let i = 0;
              while (i < bodyBuf.length) {
                const crlfPos = bodyBuf.indexOf('\r\n', i);
                if (crlfPos === -1) break;
                const sizeLine = bodyBuf.slice(i, crlfPos).toString('ascii').split(';')[0].trim();
                const size = parseInt(sizeLine, 16);
                if (isNaN(size) || size === 0) break;
                i = crlfPos + 2;
                decoded.push(bodyBuf.slice(i, i + size));
                i += size + 2; // skip chunk data + trailing \r\n
              }
              bodyBuf = Buffer.concat(decoded);
            }

            resolve({
              ok,
              status: statusCode,
              headers: { get: () => null, getSetCookie: () => [] },
              json:    () => Promise.resolve(JSON.parse(bodyBuf.toString('utf8'))),
              text:    () => Promise.resolve(bodyBuf.toString('utf8')),
            });
          } catch (e) {
            reject(new Error(`apifyVFetch parse error: ${e.message}`));
          }
        });
      });
    });

    connectReq.end();
  });
}

// ── Vinted geo-base detection ─────────────────────────────────────────────────
// The proxy may be geolocated to a non-UK country. Vinted redirects
// www.vinted.co.uk → www.vinted.fr (or another locale) based on the proxy IP.
// We detect the actual domain once and cache it for 10 minutes.
let _vintedBase = 'https://www.vinted.co.uk';
let _vintedBaseExpiry = 0;

// Returns just the base URL string (cached 10 min). Fast — no extra HTTP call if cached.
async function getVintedBase() {
  if (Date.now() < _vintedBaseExpiry) return _vintedBase;
  try {
    const r = await vFetch('https://www.vinted.co.uk/', {
      redirect: 'follow',
      headers: { 'User-Agent': VINTED_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-GB,en;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    const detected = new URL(r.url || 'https://www.vinted.co.uk').origin;
    if (detected !== _vintedBase) console.log(`[vinted] Geo base: ${_vintedBase} → ${detected}`);
    _vintedBase = detected;
    _vintedBaseExpiry = Date.now() + 10 * 60 * 1000; // cache for 10 min
  } catch (e) {
    console.warn('[vinted] getVintedBase failed, using default:', e.message);
  }
  return _vintedBase;
}

// Returns { base, cookies } — always fetches fresh DataDome session cookies.
// DataDome cookies are short-lived so they must never be cached.
async function getVintedSession(fetchFn = vFetch) {
  const base = await getVintedBase();
  let cookies = '';
  try {
    const r = await fetchFn(`${base}/`, {
      redirect: 'follow',
      headers: {
        'User-Agent': VINTED_UA,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(8000),
    });
    const setCookies = r.headers.getSetCookie?.() || [];
    cookies = setCookies.map(c => c.split(';')[0]).join('; ');
    console.log(`[vinted] session cookies: ${setCookies.length} (datadome: ${setCookies.some(c => /datadome/i.test(c))})`);
  } catch (e) {
    console.warn('[vinted] session cookie fetch failed (continuing without cookies):', e.message);
  }
  return { base, cookies };
}

// Desktop Chrome UA — must match our Chrome TLS cipher config.
// Using iPhone UA with Chrome ciphers is an inconsistency DataDome flags.
const VINTED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VINTED_HEADERS = (token, base = 'https://www.vinted.co.uk') => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`,
  'User-Agent': VINTED_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Origin': base,
  'Referer': `${base}/`,
  'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
});

async function vintedLogin(usernameOrEmail, password) {
  // 1. Apify residential proxy first — this is the only path that reliably
  //    bypasses DataDome on a server (Railway / datacenter IPs are flagged).
  if (APIFY_PROXY_READY) {
    console.log('[vinted-login] trying Apify residential proxy');
    const r = await legacyVintedLogin(usernameOrEmail, password, apifyVFetch);
    if (!r.error) return r;
    console.warn('[vinted-login] Apify proxy login failed:', r.error);
  }
  // 2. PROXY_URL (user-set residential proxy)
  const r2 = await legacyVintedLogin(usernameOrEmail, password, vFetch);
  if (!r2.error) return r2;
  console.warn('[vinted-login] direct/PROXY_URL login failed:', r2.error);
  // 3. Playwright (rarely available on Railway because of libglib)
  if (vintedBrowser) {
    console.log('[vinted-login] last-resort browser flow');
    const r3 = await vintedBrowser.vintedBrowserLogin(usernameOrEmail, password);
    if (!r3.error) return r3;
    console.warn('[vinted-login] browser flow failed:', r3.error);
  }
  return r2;
}

async function legacyVintedLogin(usernameOrEmail, password, fetchFn = vFetch) {
  try {
    const BASE_HEADERS = {
      'User-Agent': VINTED_UA,
      'Accept-Language': 'en-GB,en;q=0.9',
      'Origin': 'https://www.vinted.co.uk',
      'Referer': 'https://www.vinted.co.uk/',
    };

    // Step 1: Detect geo base + get fresh DataDome session cookies + CSRF token.
    const { base: vintedBase, cookies: bootstrapCookies } = await getVintedSession(fetchFn);
    let cookieStr = bootstrapCookies;
    let csrfToken = '';
    // Extract CSRF from cookies returned by getVintedBase
    cookieStr.split('; ').forEach(pair => {
      if (/csrf[-_]?token/i.test(pair)) csrfToken = pair.split('=').slice(1).join('=');
    });
    console.log(`[vinted-login] base=${vintedBase} cookies=${cookieStr.split(';').length} csrf=${!!csrfToken}`);

    // Step 2: POST credentials with session cookies + CSRF to the detected base domain
    const loginHeaders = {
      ...BASE_HEADERS,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Referer': `${vintedBase}/`,
      'Origin': vintedBase,
      ...(cookieStr && { 'Cookie': cookieStr }),
      ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
    };

    const res = await fetchFn(`${vintedBase}/api/v2/sessions`, {
      method: 'POST',
      headers: loginHeaders,
      body: JSON.stringify({ login: usernameOrEmail, password, remember: true }),
      signal: AbortSignal.timeout(15000),
    });

    const rawText = await res.text();
    console.log(`[vinted-login] status: ${res.status} preview: ${rawText.slice(0, 200)}`);

    let data;
    try { data = JSON.parse(rawText); } catch {
      // HTML response = DataDome challenge page (bot-protection on this IP/fingerprint)
      console.error(`[vinted-login] Non-JSON response (proxy=${!!PROXY_AGENT}) status=${res.status}:`, rawText.slice(0, 400));
      const proxyNote = PROXY_AGENT
        ? 'Proxy active but fingerprint still flagged — check Railway logs for details.'
        : 'No proxy set — add a residential PROXY_URL to Railway env vars.';
      return { error: `Vinted bot-protection on login. ${proxyNote}` };
    }

    if (!res.ok) {
      const msg = data?.error_description || data?.message || data?.error || '';
      if (res.status === 401 || res.status === 403) return { error: 'Vinted credentials invalid — check your username/email and password.' };
      if (res.status === 429) return { error: 'Vinted rate limited — wait a few minutes and try again.' };
      if (res.status === 422) return { error: msg || 'Vinted rejected the login — check your credentials.' };
      return { error: msg || `Vinted login failed (${res.status}).` };
    }

    const user  = data.user || data;
    const token = user.auth_token || data.access_token;
    if (!token) return { error: 'Vinted login succeeded but no token returned. Try again.' };

    return {
      access_token: token,
      refresh_token: '',
      platform_user_id: String(user.id || ''),
      platform_username: user.login || user.username || usernameOrEmail,
    };
  } catch (e) {
    if (e.name === 'TimeoutError') return { error: 'Vinted request timed out — check your connection.' };
    return { error: e.message };
  }
}

// Upload image to Vinted — returns { photo_id } or { error }
// Tries: direct HTTP → Playwright browser (bypasses DataDome completely).
async function vintedUploadImage(accessToken, base64Data, mimeType = 'image/jpeg') {
  // 1. Direct HTTP with Bearer auth
  const direct = await legacyVintedUploadImage(accessToken, base64Data, mimeType, vFetch);
  if (!direct.error) return direct;

  const isDataDome = /datadome|captcha|403|html/i.test(direct.error) || direct.error.includes('<!');
  if (!isDataDome) return direct; // real error — no point retrying

  // 2. Playwright browser — runs requests from within a real browser context,
  //    bypasses DataDome fingerprinting entirely
  if (vintedBrowser?.vintedBrowserUploadPhoto) {
    console.warn('[vinted-upload] DataDome blocked direct call — retrying via Playwright browser');
    const browser = await vintedBrowser.vintedBrowserUploadPhoto(accessToken, base64Data, mimeType);
    if (!browser.error) return browser;
    console.warn('[vinted-upload] Playwright also failed:', browser.error);
  }

  return { error: 'Vinted is blocking photo uploads from the server. Try again in a few minutes.' };
}

async function legacyVintedUploadImage(accessToken, base64Data, mimeType = 'image/jpeg', fetchFn = vFetch) {
  try {
    const boundary = `----FormBoundary${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo[image_type]"\r\n\r\nuser_items\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo[orientation]"\r\n\r\n0\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo[image]"; filename="photo.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      Buffer.from(base64Data, 'base64'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const vintedBase = await getVintedBase();
    const res = await fetchFn(`${vintedBase}/api/v2/photos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': VINTED_UA,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Accept': 'application/json',
        'Origin': 'https://www.vinted.co.uk',
      },
      body,
      signal: AbortSignal.timeout(25000),
    });
    if (!res) return { error: 'DataDome blocked image upload — proxy unavailable.' };
    if (!res.ok) { const e = await res.text(); return { error: /datadome|captcha/i.test(e) ? `DataDome blocked image upload on ${vintedBase}.` : `Vinted image upload failed: ${e.slice(0, 80)}` }; }
    const data = await res.json();
    return { photo_id: data.id || data.photo?.id };
  } catch (e) { return { error: e.message }; }
}

async function vintedCreateListing(accessToken, listingData) {
  // 1. Direct HTTP — fast, but Railway's datacenter IP is usually blocked by DataDome
  const direct = await legacyVintedCreateListing(accessToken, listingData, vFetch);
  if (!direct.error) return direct;

  // DataDome returns 403 with an HTML page (no JSON) — catch that specifically
  const isDataDome = /datadome|captcha|html/i.test(direct.error)
    || direct.error.includes('<!') || direct.error.includes('(403)');
  if (!isDataDome) return direct; // auth/network error — other routes won't help

  console.warn('[vinted-list] DataDome/403 on direct HTTP — trying Playwright browser');

  // 2. Playwright browser — makes the API call from inside a real browser context
  //    with the access_token_web cookie set, bypasses DataDome fingerprinting.
  if (vintedBrowser?.vintedBrowserCreateListing) {
    const browser = await vintedBrowser.vintedBrowserCreateListing(accessToken, listingData);
    if (!browser.error) return browser;
    console.warn('[vinted-list] Playwright also failed:', browser.error);
    // If Playwright worked but Vinted rejected the request (auth/validation), surface that
    if (!/browser unavailable/i.test(browser.error)) return browser;
  }

  return { error: 'Vinted blocked this listing request. Make sure your access_token_web is current (tokens expire ~30 days). Refresh it on the Platforms page and try again.' };
}

async function legacyVintedCreateListing(accessToken, listingData, fetchFn = vFetch) {
  const {
    title, description = '', price, condition, photo_ids = [],
    brand = '', size = '',
    vinted_catalog_id = null, vinted_package_size_id = 2,
  } = listingData;
  // Vinted status_id values (from Vinted API): 6=new_with_tags, 1=new_without_tags,
  // 2=like_new, 3=very_good, 4=good, 5=acceptable
  const condMap = {
    'New with tags': 6, 'New without tags': 1,
    'Like New': 2, 'Like New — barely worn': 2,
    'Very Good': 3, 'Very Good — minor signs of wear': 3,
    'Good': 4, 'Good — visible signs of wear': 4,
    'Acceptable': 5, 'Acceptable — heavily worn': 5,
  };
  try {
    // Use Bearer-auth only — no DataDome session cookies needed for authenticated API calls.
    // The getVintedSession() path (fetching HTML to get DataDome cookies) was causing
    // DataDome to trigger on the HTML request itself, poisoning every subsequent call.
    const vintedBase = await getVintedBase();
    console.log(`[vinted-list-direct] base=${vintedBase} proxy=${!!PROXY_AGENT}`);

    const brandLine = [brand && `Brand: ${brand}`, size && `Size: ${size}`].filter(Boolean).join(' · ');
    const fullDesc  = brandLine ? `${brandLine}\n\n${description}`.trim() : description;

    const body = {
      title,
      description: fullDesc,
      price: String(parseFloat(price).toFixed(2)),
      currency: 'GBP',
      catalog_id: vinted_catalog_id || 1,
      status_id: condMap[condition] || 3,
      package_size_id: vinted_package_size_id || 2,
    };
    if (photo_ids.length) body.photos = photo_ids.map(id => ({ id }));

    const res = await fetchFn(`${vintedBase}/api/v2/items`, {
      method: 'POST',
      headers: VINTED_HEADERS(accessToken, vintedBase),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res) return { error: 'DataDome blocked the direct listing call — proxy unavailable.' };

    if (!res.ok) {
      const err = await res.text();
      console.error(`[vinted-list-direct] HTTP ${res.status} base=${vintedBase}:`, err.slice(0, 400));
      if (/captcha-delivery\.com|datadome/i.test(err)) {
        return { error: `DataDome blocked the direct listing call on ${vintedBase}.` };
      }
      if (/unauthenticated|invalid_auth_token/i.test(err)) {
        return { error: 'Your Vinted session token has expired. Reconnect your Vinted account in the dashboard.' };
      }
      return { error: `Vinted error (${res.status}): ${err.slice(0, 200)}` };
    }
    const data = await res.json();
    const item = data.item || data;
    return { ok: true, listing_id: String(item.id || ''), url: item.url || `${vintedBase}/items/${item.id}` };
  } catch (e) { return { error: e.message }; }
}

// Validate a Vinted access token by calling /api/v2/users/me.
// Returns { valid: true, username, user_id } | { valid: false, error } | { valid: null, warning }
async function validateVintedToken(token) {
  // Try direct HTTP first — it's faster and doesn't need Playwright
  const direct = await legacyValidateVintedToken(token);
  if (direct.valid === true || direct.valid === false) return direct;
  // Got a warning (DataDome/timeout) — try the browser as fallback
  if (vintedBrowser) {
    const r = await vintedBrowser.vintedBrowserValidateToken(token);
    if (r.valid === true || r.valid === false) return r;
  }
  return direct; // return original warning
}

async function legacyValidateVintedToken(token) {
  // Decode JWT payload to extract user_id so we can hit /api/v2/users/{id}
  // instead of /api/v2/users/me — which does not exist on Vinted.
  let jwtUserId = '';
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      jwtUserId = String(payload.user_id || payload.sub || payload.id || payload.uid || '').replace(/\D/g, '');
    }
  } catch {}

  // Use /api/v2/users/{id} if we have the ID from the JWT, otherwise try a
  // lightweight catalog call that doesn't need a user endpoint at all.
  const testPath = jwtUserId
    ? `/api/v2/users/${jwtUserId}`
    : `/api/v2/catalog/items?page=1&per_page=1`;

  try {
    const vintedBase = await getVintedBase();
    const r = await vFetch(`${vintedBase}${testPath}`, {
      headers: VINTED_HEADERS(token),
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      if (text.includes('captcha-delivery.com') || text.includes('datadome') || text.startsWith('<!')) {
        return { valid: null, warning: 'Bot-protection blocked the validation request. Token saved — it will fail with a clear error if incorrect when you use it.' };
      }
      return { valid: false, error: 'Unexpected non-JSON response from Vinted — token may be invalid.' };
    }
    if (!r.ok) {
      if (data?.url?.includes('captcha-delivery.com') || data?.url?.includes('datadome')) {
        return { valid: null, warning: 'Bot-protection blocked the validation request. Token saved.' };
      }
      const code = data?.message_code || data?.error || '';
      if (r.status === 401 || code.includes('unauthenticated') || code.includes('invalid_auth')) {
        return { valid: false, error: 'Token is invalid or expired. Copy a fresh access_token_web cookie from your Vinted browser session and paste it again.' };
      }
      return { valid: null, warning: `Vinted returned ${r.status} during validation — token saved.` };
    }
    // Success — extract user info from the response
    const u = data.user || data;
    const resolvedId = String(u.id || jwtUserId || '');
    return { valid: true, username: u.login || u.username || '', user_id: resolvedId };
  } catch (e) {
    return { valid: null, warning: `Could not reach Vinted to validate token (${e.message}). Token saved.` };
  }
}

// Fetch Vinted analytics data directly (no Playwright needed when we have a valid token).
// Returns { user, items } on success, { error } on failure, { datadome: true } if blocked.
async function fetchVintedAnalyticsDirect(accessToken, userId) {
  try {
    const base = await getVintedBase();
    const headers = VINTED_HEADERS(accessToken, base);
    const targetId = userId || 'me';

    const [meRes, itemsRes] = await Promise.all([
      vFetch(`${base}/api/v2/users/me`, { headers, signal: AbortSignal.timeout(10000) }),
      vFetch(`${base}/api/v2/users/${targetId}/items?per_page=96&page=1&order=newest_first`,
        { headers, signal: AbortSignal.timeout(10000) }),
    ]);

    const meText    = await meRes.text();
    const itemsText = await itemsRes.text();

    if (/captcha-delivery\.com|datadome/i.test(meText + itemsText)) {
      return { datadome: true };
    }

    let user = {}, items = [];
    try {
      const meData = JSON.parse(meText);
      user = meData.user || meData;
    } catch {}
    try {
      const itemsData = JSON.parse(itemsText);
      items = itemsData.items || [];
    } catch {}

    if (!user.id && !user.login) {
      console.warn('[vinted-analytics-direct] /users/me returned unexpected:', meText.slice(0, 200));
    }

    return { user, items };
  } catch (e) {
    return { error: e.message };
  }
}

async function vintedDeleteListing(accessToken, listingId) {
  try {
    const vintedBase = await getVintedBase();
    const res = await vFetch(`${vintedBase}/api/v2/items/${listingId}`, {
      method: 'DELETE',
      headers: VINTED_HEADERS(accessToken, vintedBase),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: res.ok || res.status === 204 };
  } catch (e) { return { error: e.message }; }
}

// ── Shared: upload images to one platform — returns { ids } or { authError } ──
async function uploadImagesToPlatform(token, platform, images = []) {
  // images: [{ base64, mimeType }]
  const ids = [];
  for (const img of images) {
    let r;
    if (platform === 'depop')  r = await depopUploadImage(token, img.base64, img.mimeType);
    if (platform === 'vinted') r = await vintedUploadImage(token, img.base64, img.mimeType);
    if (!r || r.error) {
      console.warn(`[image] ${platform} upload failed:`, r?.error);
      // Propagate auth errors immediately — no point continuing with an expired token
      if (r?.error && (r.error.includes('"unauthenticated"') || r.error.includes('"invalid_auth_token"'))) {
        return { authError: 'Your Vinted session token has expired. Reconnect your Vinted account in the dashboard.' };
      }
      continue;
    }
    ids.push(platform === 'depop' ? r.image_id : r.photo_id);
  }
  return ids;
}

// ── Shared: post listing to one platform ─────────────────────────────────────
async function postToPlatform(userId, platform, listingData) {
  const conn = await getPlatformConn(userId, platform);
  if (!conn?.access_token) return { error: 'Not connected — link your account on the Platforms page first.' };
  const token = decryptToken(conn.access_token);
  if (!token) {
    if (platform === 'vinted') {
      return { error: 'No access token saved for Vinted. Go to Platforms → Enable Auto-Listing and paste your access_token_web cookie value.' };
    }
    return { error: 'Could not read stored token — reconnect your account on the Platforms page.' };
  }

  // Vinted requires at least 3 photos
  if (platform === 'vinted') {
    const imgCount = (listingData.images || []).length;
    if (imgCount < 3) {
      return { error: `Vinted requires at least 3 photos (you uploaded ${imgCount}). Add more photos and try again.` };
    }
  }

  // Upload any images first — returns array of IDs, or { authError } if token is expired
  const uploadResult = await uploadImagesToPlatform(token, platform, listingData.images || []);
  if (uploadResult?.authError) return { error: uploadResult.authError };
  const imageIds = Array.isArray(uploadResult) ? uploadResult : [];
  const data = { ...listingData };
  if (platform === 'depop')  data.image_ids = imageIds;
  if (platform === 'vinted') data.photo_ids  = imageIds;

  if (platform === 'depop')  return depopCreateListing(token, data);
  if (platform === 'vinted') return vintedCreateListing(token, data);
  return { error: 'Platform not supported yet' };
}

async function deleteFromPlatform(userId, platform, listingId) {
  const conn = await getPlatformConn(userId, platform);
  if (!conn?.access_token) return { error: 'Not connected' };
  const token = decryptToken(conn.access_token);
  if (platform === 'depop')  return depopDeleteListing(token, listingId);
  if (platform === 'vinted') return vintedDeleteListing(token, listingId);
  return { error: 'Platform not supported yet' };
}

// ── Auth middleware helper ─────────────────────────────────────────────────────
async function requireAuth(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No token' }); return null; }
  const user = await verifySupabaseToken(token);
  if (!user) { res.status(401).json({ error: 'Invalid token' }); return null; }
  return user;
}

// ── Platform connection endpoints ─────────────────────────────────────────────

// Connect a platform account
// Supports two modes:
//   1. credentials  — { email/username + password } → bot logs in on behalf of user
//   2. manual_token — { token + username }           → user provides their own session token
//      (use when credential login is blocked by Cloudflare on the server IP)
app.post('/api/platform/connect', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { platform, credentials, manual_token, username: manualUsername } = req.body;
  if (!platform) return res.status(400).json({ error: 'platform required' });

  let result;

  // ── Manual token mode ──────────────────────────────────────────────────────
  if (manual_token) {
    if (!manualUsername) return res.status(400).json({ error: 'username required with manual_token' });
    if (!['depop','vinted'].includes(platform)) return res.status(400).json({ error: 'Unsupported platform' });

    // For manual tokens: skip server-side validation because Railway IPs are blocked
    // by Cloudflare (Vinted) and similar bot-protection on Depop. Trust the user's
    // extracted token — if it's wrong it will fail visibly when they try to list.
    if (platform === 'vinted') {
      if (manual_token.length < 20) {
        return res.status(400).json({ error: 'Token looks too short — make sure you copied the full access_token value from your browser cookies.' });
      }
      // Validate the token against Vinted's /api/v2/users/me before saving
      const validation = await validateVintedToken(manual_token);
      if (validation.valid === false) {
        return res.status(400).json({ error: validation.error });
      }
      // valid=true → use username from Vinted's response; valid=null → DataDome blocked, save with warning
      const confirmedUsername = validation.valid === true ? (validation.username || manualUsername) : manualUsername;
      const confirmedUserId   = validation.valid === true ? (validation.user_id   || '')            : '';
      result = {
        access_token:      manual_token,
        refresh_token:     '',
        platform_user_id:  confirmedUserId,
        platform_username: confirmedUsername,
        validation_warning: validation.warning || null,
      };
      console.log(`[manual-token] vinted token validated=${validation.valid} for @${confirmedUsername}`);
      // If validation was bypassed (DataDome), include the warning in the response
      if (validation.warning) {
        // We'll save and respond with a warning flag — dashboard can show it
        res.locals.validationWarning = validation.warning;
      }
    } else if (platform === 'depop') {
      if (manual_token.length < 10) {
        return res.status(400).json({ error: 'Token looks too short — make sure you copied the full token value.' });
      }
      result = {
        access_token:      manual_token,
        refresh_token:     '',
        platform_user_id:  '',
        platform_username: manualUsername,
      };
      console.log(`[manual-token] depop saved without server validation for @${manualUsername}`);
    }
  }
  // ── Credential login mode ──────────────────────────────────────────────────
  else if (credentials) {
    if (platform === 'depop') {
      result = await depopLogin(credentials.email, credentials.password);
    } else if (platform === 'vinted') {
      result = await vintedLogin(credentials.username || credentials.email, credentials.password);
    } else {
      return res.status(400).json({ error: 'Unsupported platform' });
    }
    if (result.error) return res.status(400).json({ error: result.error });
  } else {
    return res.status(400).json({ error: 'credentials or manual_token required' });
  }

  const saveResult = await upsertPlatformConn(user.id, platform, {
    access_token:      encryptToken(result.access_token),
    refresh_token:     result.refresh_token ? encryptToken(result.refresh_token) : null,
    platform_user_id:  result.platform_user_id,
    platform_username: result.platform_username,
    connected_at:      new Date().toISOString(),
    // token_expires_at omitted — column not in schema
  });

  if (!saveResult.ok) {
    console.error(`[platform] upsert failed for ${platform} / user ${user.id}:`, saveResult.error);
    return res.status(500).json({ error: saveResult.error || 'Failed to save connection. Please try again.' });
  }

  console.log(`[platform] ${platform} connected for user ${user.id} (@${result.platform_username}) mode:${manual_token ? 'manual' : 'credentials'}`);

  // Kick off an inventory sync in the background so the dashboard populates immediately
  if (platform === 'vinted') {
    syncVintedInventoryForUser(user.id).catch(e => console.warn('[sync-inventory] post-connect:', e.message));
  }

  res.json({
    ok: true,
    platform,
    username: result.platform_username,
    ...(res.locals.validationWarning && { warning: res.locals.validationWarning }),
  });
});

// Disconnect a platform account
app.delete('/api/platform/:platform/disconnect', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  await deletePlatformConn(user.id, req.params.platform);
  res.json({ ok: true });
});

// ── Vinted OAuth-style connect popup ─────────────────────────────────────────
// Served as a popup window on PC / new tab on mobile.
// Auth token is passed as ?auth=<supabase_jwt> so the page can call
// /api/platform/connect without needing a separate login step.
// On success the page posts { type:'vinted-connected', username } back to
// window.opener and calls window.close().
app.get('/api/vinted/connect-popup', (req, res) => {
  const { auth } = req.query;
  const authJson = JSON.stringify(auth || '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Vinted · Vendora</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#090909;color:#f0f0f0;font-family:'DM Sans',system-ui,sans-serif;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:24px}
  .card{background:#0f0f0f;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:28px 24px;width:100%;max-width:420px;margin-top:16px}
  .logo{display:flex;align-items:center;gap:10px;margin-bottom:20px}
  .logo-mark{width:32px;height:32px;background:linear-gradient(135deg,#e8217a,#c41860);border-radius:4px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;letter-spacing:-.5px;color:#fff}
  .logo-text{font-size:16px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#f0f0f0}
  h2{font-size:17px;font-weight:700;margin-bottom:5px}
  .sub{font-size:13px;color:#888;margin-bottom:18px;line-height:1.55}
  .tabs{display:flex;margin-bottom:20px;border:1px solid rgba(255,255,255,.1);border-radius:6px;overflow:hidden}
  .tab-btn{flex:1;padding:9px 10px;font-size:11px;font-weight:600;font-family:inherit;border:none;cursor:pointer;letter-spacing:.05em;text-transform:uppercase;transition:background .15s,color .15s}
  .tab-btn.active{background:rgba(9,177,186,.16);color:#09b1ba}
  .tab-btn:not(.active){background:transparent;color:#555}
  .tab-btn:not(.active):hover{background:rgba(255,255,255,.04);color:#999}
  .tab-pane{display:none}
  .tab-pane.active{display:block}
  label{display:block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#888;margin-bottom:6px}
  input,textarea{width:100%;background:#141414;border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:11px 14px;font-size:13px;color:#f0f0f0;font-family:inherit;outline:none;transition:border .15s;resize:none}
  input:focus,textarea:focus{border-color:rgba(9,177,186,.5)}
  .field{margin-bottom:14px}
  .btn{width:100%;padding:11px;border-radius:4px;border:none;cursor:pointer;font-size:14px;font-weight:600;font-family:inherit;transition:opacity .15s,background .15s;letter-spacing:.03em}
  .btn-primary{background:linear-gradient(135deg,#09b1ba,#077d84);color:#fff}
  .btn-primary:hover{opacity:.9}
  .btn-primary:disabled{opacity:.5;cursor:not-allowed}
  .notice{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:4px;margin-bottom:16px}
  .notice-icon{font-size:14px;flex-shrink:0;margin-top:1px}
  .notice-text{font-size:12px;color:#999;line-height:1.6}
  .notice-text b{color:#bbb}
  .notice.teal{background:rgba(9,177,186,.05);border-color:rgba(9,177,186,.2)}
  .msg{margin-top:12px;padding:10px 14px;border-radius:4px;font-size:13px;display:none;line-height:1.5}
  .msg.success{background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.2);color:#4ade80}
  .msg.error{background:rgba(232,33,122,.1);border:1px solid rgba(232,33,122,.2);color:#f07}
  .msg.info{background:rgba(9,177,186,.08);border:1px solid rgba(9,177,186,.2);color:#09b1ba}
  .spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;margin-right:8px;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  .step{display:none}
  .step.active{display:block}
  .step-header{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;font-weight:600;color:#bbb}
  .step-num{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(9,177,186,.2);color:#09b1ba;font-size:11px;font-weight:700;flex-shrink:0}
  .cookie-steps{margin:10px 0 2px;display:flex;flex-direction:column;gap:7px}
  .cookie-step{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#999;line-height:1.5}
  .cookie-step b{color:#ccc}
  kbd{display:inline-block;padding:1px 6px;background:#1a1a1a;border:1px solid rgba(255,255,255,.15);border-radius:3px;font-size:11px;color:#bbb;font-family:monospace}
  .back-link{display:block;margin-top:10px;text-align:center;font-size:12px;color:#555;text-decoration:none;cursor:pointer}
  .back-link:hover{color:#999}
  .switch-link{color:#09b1ba;text-decoration:none;font-size:12px}
  .switch-link:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-mark">VV</div>
    <div class="logo-text">Vendora</div>
  </div>
  <h2>Connect Vinted</h2>
  <p class="sub">Link your Vinted account to enable auto-listing, inventory sync, and profit tracking.</p>

  <div class="tabs">
    <button class="tab-btn active" id="tab-btn-auto" onclick="switchTab('auto')">Auto-connect</button>
    <button class="tab-btn" id="tab-btn-manual" onclick="switchTab('manual')">Manual (Cookie)</button>
  </div>

  <!-- ── AUTO TAB ──────────────────────────────────────────────────────── -->
  <div class="tab-pane active" id="tab-auto">
    <div class="field">
      <label>Vinted username</label>
      <input id="vc-user" type="text" placeholder="your_username" autocomplete="username">
    </div>
    <div class="field">
      <label>Vinted password</label>
      <input id="vc-pass" type="password" placeholder="••••••••" autocomplete="current-password">
    </div>
    <button class="btn btn-primary" id="vc-btn" onclick="doLogin()">Sign in &amp; Connect</button>
    <div class="notice" style="margin-top:14px;">
      <span class="notice-icon">🔒</span>
      <div class="notice-text">Your password is sent securely to Vendora's server, used once to log in, then <b>immediately discarded</b>. Only your session token is stored (encrypted).</div>
    </div>
    <div class="msg" id="auto-msg"></div>
    <p style="margin-top:12px;text-align:center;font-size:12px;color:#555;">
      Auto-connect blocked? Use <a class="switch-link" onclick="switchTab('manual');return false;" href="#">Manual (Cookie)</a> instead.
    </p>
  </div>

  <!-- ── MANUAL TAB ─────────────────────────────────────────────────────── -->
  <div class="tab-pane" id="tab-manual">

    <!-- Step 1: username -->
    <div class="step active" id="manual-step1">
      <div class="step-header">
        <span class="step-num">1</span> Enter your Vinted username
      </div>
      <div class="field">
        <label>Vinted username</label>
        <input id="mc-user" type="text" placeholder="your_username" autocomplete="username">
      </div>
      <button class="btn btn-primary" id="mc-step1-btn" onclick="doManualStep1()">Continue →</button>
      <div class="msg" id="manual-step1-msg"></div>
    </div>

    <!-- Step 2: paste cookie (shown after step 1 succeeds) -->
    <div class="step" id="manual-step2">
      <div class="step-header">
        <span class="step-num">2</span> Paste your session cookie
      </div>
      <div class="notice teal">
        <span class="notice-icon">📋</span>
        <div class="notice-text">
          <b>How to get your Vinted cookie:</b>
          <div class="cookie-steps">
            <div class="cookie-step"><b>1.</b>&ensp;Log in to Vinted in your browser</div>
            <div class="cookie-step"><b>2.</b>&ensp;Press <kbd>F12</kbd> → <b>Application</b> tab → <b>Cookies</b> → <b>www.vinted.co.uk</b></div>
            <div class="cookie-step"><b>3.</b>&ensp;Find <b>access_token_web</b> — copy its full <b>Value</b></div>
            <div class="cookie-step"><b>4.</b>&ensp;Paste it below (long string starting with <b>eyJ</b>)</div>
          </div>
        </div>
      </div>
      <div class="field">
        <label>access_token_web value</label>
        <textarea id="mc-token" rows="3" placeholder="eyJ..."></textarea>
      </div>
      <button class="btn btn-primary" id="mc-step2-btn" onclick="doManualStep2()">Save &amp; Connect</button>
      <div class="msg" id="manual-step2-msg"></div>
      <a class="back-link" onclick="resetManual();return false;">← Back</a>
    </div>

  </div><!-- /tab-manual -->
</div>

<script>
const AUTH_TOKEN = ${authJson};
let _manualUsername = '';

function switchTab(tab) {
  const isAuto = tab === 'auto';
  document.getElementById('tab-btn-auto').classList.toggle('active', isAuto);
  document.getElementById('tab-btn-manual').classList.toggle('active', !isAuto);
  document.getElementById('tab-auto').classList.toggle('active', isAuto);
  document.getElementById('tab-manual').classList.toggle('active', !isAuto);
}

function showMsg(id, type, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'msg ' + type;
  el.innerHTML = text;
  el.style.display = 'block';
}

// ── AUTO TAB ──────────────────────────────────────────────────────────────────
async function doLogin() {
  if (!AUTH_TOKEN) return showMsg('auto-msg', 'error', 'Session expired — close this window and try again from the dashboard.');
  const username = document.getElementById('vc-user').value.trim().replace(/^@/, '');
  const password = document.getElementById('vc-pass').value;
  if (!username) return showMsg('auto-msg', 'error', 'Enter your Vinted username.');
  if (!password)  return showMsg('auto-msg', 'error', 'Enter your Vinted password.');

  const btn = document.getElementById('vc-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Signing in to Vinted…';
  showMsg('auto-msg', 'info', 'Opening a browser session — this can take up to 30 seconds…');

  try {
    const res = await fetch('/api/vinted/connect-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json();
    if (!res.ok) {
      showMsg('auto-msg', 'error', json.error || 'Login failed. Check your credentials and try again.');
      btn.disabled = false; btn.textContent = 'Sign in & Connect';
      return;
    }
    showMsg('auto-msg', 'success', '✓ Connected as @' + json.username + '!');
    _notifyDashboard(json.username);
  } catch (e) {
    showMsg('auto-msg', 'error', 'Network error: ' + (e.message || 'please try again'));
    btn.disabled = false; btn.textContent = 'Sign in & Connect';
  }
}

// ── MANUAL TAB ────────────────────────────────────────────────────────────────
async function doManualStep1() {
  if (!AUTH_TOKEN) return showMsg('manual-step1-msg', 'error', 'Session expired — close and try again.');
  const username = document.getElementById('mc-user').value.trim().replace(/^@/, '');
  if (!username) return showMsg('manual-step1-msg', 'error', 'Enter your Vinted username.');

  const btn = document.getElementById('mc-step1-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Checking…';
  showMsg('manual-step1-msg', 'info', 'Verifying username on Vinted…');

  try {
    const res = await fetch('/api/vinted/connect-username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ username }),
    });
    const json = await res.json();
    if (!res.ok) {
      showMsg('manual-step1-msg', 'error', json.error || 'Could not verify username. Check spelling and try again.');
      btn.disabled = false; btn.textContent = 'Continue →';
      return;
    }
    _manualUsername = json.username || username;
    // Advance to step 2
    document.getElementById('manual-step1').classList.remove('active');
    document.getElementById('manual-step2').classList.add('active');
  } catch (e) {
    showMsg('manual-step1-msg', 'error', 'Network error: ' + (e.message || 'try again'));
    btn.disabled = false; btn.textContent = 'Continue →';
  }
}

async function doManualStep2() {
  if (!AUTH_TOKEN) return showMsg('manual-step2-msg', 'error', 'Session expired — close and try again.');
  const token = document.getElementById('mc-token').value.trim();
  if (!token || token.length < 20) {
    return showMsg('manual-step2-msg', 'error', 'Paste the full access_token_web value (it starts with eyJ…).');
  }

  const btn = document.getElementById('mc-step2-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving token…';

  try {
    const res = await fetch('/api/vinted/save-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify({ token }),
    });
    const json = await res.json();
    if (!res.ok) {
      showMsg('manual-step2-msg', 'error', json.error || 'Could not save token.');
      btn.disabled = false; btn.textContent = 'Save & Connect';
      return;
    }
    const expStr = json.expires ? ' · expires ' + new Date(json.expires).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '';
    if (json.warning) {
      showMsg('manual-step2-msg', 'info', '✓ Token saved as @' + _manualUsername + expStr + '. (Server-side check skipped — token structure is valid.)');
    } else {
      showMsg('manual-step2-msg', 'success', '✓ Connected as @' + _manualUsername + expStr + ' — token verified!');
    }
    _notifyDashboard(_manualUsername);
  } catch (e) {
    showMsg('manual-step2-msg', 'error', 'Network error: ' + (e.message || 'try again'));
    btn.disabled = false; btn.textContent = 'Save & Connect';
  }
}

function resetManual() {
  _manualUsername = '';
  document.getElementById('manual-step1').classList.add('active');
  document.getElementById('manual-step2').classList.remove('active');
  const btn = document.getElementById('mc-step1-btn');
  btn.disabled = false; btn.textContent = 'Continue →';
  ['manual-step1-msg','manual-step2-msg'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
  document.getElementById('mc-token').value = '';
}

function _notifyDashboard(username) {
  if (window.opener) {
    setTimeout(() => {
      try { window.opener.postMessage({ type: 'vinted-connected', username }, '*'); } catch {}
      window.close();
    }, 1400);
  } else {
    // Mobile / popup-blocked: opened as new tab — user closes manually
    const btns = document.querySelectorAll('.btn-primary');
    btns.forEach(b => { b.textContent = 'Done — close this tab'; b.disabled = false; b.onclick = () => window.close(); });
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (document.getElementById('tab-auto').classList.contains('active')) doLogin();
    else if (document.getElementById('manual-step1').classList.contains('active')) doManualStep1();
    else if (document.getElementById('manual-step2').classList.contains('active')) doManualStep2();
  }
});
</script>
</body>
</html>`);
});

// POST /api/vinted/connect-login — log in with real Vinted credentials via
// Playwright browser (bypasses DataDome), store the session token + seller ID.
// Password is used once and never persisted.
app.post('/api/vinted/connect-login', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (!vintedBrowser?.vintedBrowserLogin) {
    return res.status(503).json({ error: 'Browser login unavailable — Playwright not running on this server.' });
  }

  let result;
  try {
    result = await Promise.race([
      vintedBrowser.vintedBrowserLogin(username, password),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Login timed out after 120s')), 120000)),
    ]);
  } catch (e) {
    console.warn('[vinted-connect-login] timeout/error:', e.message);
    return res.status(504).json({ error: 'Login timed out. Vinted may be slow — please try again.' });
  }

  if (result?.error) {
    // Surface Vinted-specific messages (wrong password, captcha, etc.)
    return res.status(401).json({ error: result.error });
  }
  if (!result?.access_token) {
    return res.status(401).json({ error: 'Login did not return a session token. Check your credentials and try again.' });
  }

  // Clear any stale inventory + sales before saving fresh connection
  await saveSetting(`vinted_inventory_${user.id}`, { items: [], last_synced: null });
  await saveSetting(`vinted_sales_${user.id}`,     { sales: [], last_synced: null });

  const save = await upsertPlatformConn(user.id, 'vinted', {
    access_token:      encryptToken(result.access_token),
    refresh_token:     result.refresh_token ? encryptToken(result.refresh_token) : null,
    platform_user_id:  result.platform_user_id || '',
    platform_username: result.platform_username || username,
    connected_at:      new Date().toISOString(),
    // token_expires_at omitted — column not in schema
  });
  if (!save.ok) return res.status(500).json({ error: save.error || 'Could not save connection.' });

  const savedUsername = result.platform_username || username;
  console.log(`[vinted-connect-login] @${savedUsername} connected (id=${result.platform_user_id})`);
  res.json({ ok: true, username: savedUsername, seller_id: result.platform_user_id || null });

  // Kick off inventory sync in background now that we have a real token + ID
  syncVintedInventoryForUser(user.id).catch(e => console.warn('[sync-inventory] post-login:', e.message));
});

// ── Vinted via Apify Actor API: user lookup + inventory + profit sync ─────────
// Uses Apify actor REST API — NOT the Apify proxy. Works on the free Apify plan.
//
// Strategy:
//   • Username → ID lookup: APIFY_VINTED_USER_ACTOR with maxItems:1 (fast)
//   • Inventory fetch (have numeric ID): APIFY_VINTED_ACTOR with catalog URL
//       https://www.vinted.co.uk/catalog?seller_ids[]=ID  ← same actor used for
//       keyword search, proven reliable, returns all items for that seller
//   • Inventory fetch (username only, no ID): APIFY_VINTED_USER_ACTOR with member URL

// Helper: run any Apify actor and return the dataset array, or [] on error.
async function apifyRunActor(actorId, input, timeoutSec = 90) {
  // Support both Actor IDs ("user~name") and Task IDs ("user/name" or "user~name-task").
  // Try actor endpoint first; if 404, try task endpoint with tilde notation.
  const tildeId = actorId.replace('/', '~');
  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeoutSec + 5) * 1000),
  };
  const candidates = [
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutSec}`,
    `https://api.apify.com/v2/actor-tasks/${tildeId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutSec}`,
  ];
  for (const url of candidates) {
    const res = await fetch(url, fetchOpts);
    if (res.status === 404) { console.warn(`[apify] 404 for ${url.split('?')[0]} — trying task endpoint`); continue; }
    if (!res.ok) { console.warn(`[apify] ${actorId} → HTTP ${res.status}`); return []; }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }
  return [];
}

// Resolve a Vinted username → numeric user ID.
// Uses APIFY_VINTED_USER_ACTOR with maxItems:1 — only needs one item to extract
// the seller.id, so it completes fast without full-page timeout risk.
// Returns { id, login } on success, null if not found.
async function apifyVintedFetchUserByUsername(username) {
  if (!APIFY_TOKEN) return null;
  const clean = String(username || '').trim().replace(/^@/, '');
  if (!clean) return null;
  const memberUrl = `https://www.vinted.co.uk/member/${encodeURIComponent(clean)}/items`;
  try {
    const items = await apifyRunActor(APIFY_VINTED_USER_ACTOR, {
      startUrls:  [{ url: memberUrl }],
      urls:       [memberUrl],
      maxItems:   1,   // only need 1 item to get seller.id — much faster
      maxResults: 1,
      country:    'gb', countryCode: 'gb',
    }, 60);
    if (!items.length) { console.log(`[apify-user-lookup] no items returned for @${clean}`); return null; }
    // Accept only items where seller.username matches exactly
    const match = items.find(i => {
      const s = i.seller || i.user || {};
      return (s.username || s.login || s.name || '').toLowerCase() === clean.toLowerCase();
    });
    if (!match) { console.log(`[apify-user-lookup] ${items.length} items but none from @${clean}`); return null; }
    const seller   = match.seller || match.user || {};
    const sellerId = seller.id || seller.userId || match?.userId || match?.sellerId;
    const login    = seller.username || seller.login || clean;
    if (sellerId) { console.log(`[apify-user-lookup] @${clean} → id ${sellerId}`); return { id: sellerId, login }; }
    return null;
  } catch (e) { console.warn('[apify-user-lookup]', e.message); return null; }
}

// Fetch a user's active Vinted listings.
// • If we have a numeric seller ID: use the SEARCH actor with a catalog URL filtered
//   by seller_ids[]. This is the same actor used for keyword search and is reliable.
// • If only username: fall back to APIFY_VINTED_USER_ACTOR with member page URL.
async function apifyVintedFetchUserItems(usernameOrId, _base, perPage = 96) {
  if (!APIFY_TOKEN || !usernameOrId) return [];
  const clean = String(usernameOrId).trim();
  const isNumericId = /^\d+$/.test(clean);

  if (isNumericId) {
    // Catalog URL with seller filter — works with the existing search actor, reliable
    const catalogUrl = `https://www.vinted.co.uk/catalog?seller_ids[]=${clean}&order=newest_first&per_page=${Math.min(perPage, 96)}`;
    console.log(`[apify-user-items] fetching by seller_id=${clean} via catalog URL`);
    try {
      const items = await apifyRunActor(APIFY_VINTED_ACTOR, {
        startUrls:  [{ url: catalogUrl }],
        maxItems:   perPage,
        maxResults: perPage,
        country:    'gb', countryCode: 'gb',
      }, 90);
      console.log(`[apify-user-items] catalog URL returned ${items.length} items for seller ${clean}`);
      return items;
    } catch (e) { console.warn('[apify-user-items] catalog URL error:', e.message); return []; }
  }

  // Username-only fallback — member page URL via user actor
  const memberUrl = `https://www.vinted.co.uk/member/${encodeURIComponent(clean)}/items`;
  console.log(`[apify-user-items] no numeric ID, trying member URL for @${clean}`);
  try {
    const items = await apifyRunActor(APIFY_VINTED_USER_ACTOR, {
      startUrls:    [{ url: memberUrl }],
      urls:         [memberUrl],
      profileUrls:  [memberUrl],
      memberUrl:    memberUrl,
      maxItems:     perPage,
      maxResults:   perPage,
      country:      'gb', countryCode: 'gb',
    }, 90);
    console.log(`[apify-user-items] member URL returned ${items.length} items for @${clean}`);
    return items;
  } catch (e) { console.warn('[apify-user-items] member URL error:', e.message); return []; }
}

function normaliseVintedItem(it, base = 'https://www.vinted.co.uk') {
  // Handle both raw Vinted API format and Apify actor output format.
  // Raw API: price = { amount: "45.00", currency_code: "GBP" }
  // Apify:   price = 45.0 (number) or priceNumeric
  const price = typeof it.price === 'object'
    ? parseFloat(it.price?.amount || it.price?.value || 0)
    : parseFloat(it.price || it.priceNumeric || 0);
  // Raw API: photo = { url, full_size_url, thumbnails: [{url}] }
  // Apify:   photo = string URL, or photos = [{ url }]
  const photo =
    it.photo?.full_size_url ||
    it.photo?.url ||
    it.photos?.[0]?.full_size_url ||
    it.photos?.[0]?.url ||
    (typeof it.photo === 'string' ? it.photo : null) ||
    it.photoUrl ||
    it.thumbnailUrl ||
    it.photo?.thumbnails?.[0]?.url ||
    null;
  const id = String(it.id || it.itemId || '');
  return {
    id,
    title:    it.title || it.name || '(untitled)',
    price,
    currency: it.currency || it.price?.currency_code || it.currencyCode || 'GBP',
    photo,
    url:      it.url || it.itemUrl || (id ? `${base}/items/${id}` : null),
    status:   it.status === 'reserved' ? 'reserved' : 'active',
    last_seen_at: new Date().toISOString(),
  };
}

// POST /api/vinted/connect-username — validate username exists on Vinted via
// Playwright (DataDome-safe), then save connection with the numeric seller ID.
app.post('/api/vinted/connect-username', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  if (!username || !/^[A-Za-z0-9_.\-]{2,40}$/.test(username)) {
    return res.status(400).json({ error: 'Enter a valid Vinted username (letters, digits, underscores).' });
  }

  // ── Validate username exists on Vinted before saving ─────────────────────
  // Uses Playwright browser context to bypass DataDome. Also extracts the
  // numeric seller ID (needed for reliable inventory fetching via catalog URL).
  let numericId = '';
  if (vintedBrowser?.vintedBrowserLookupUser) {
    try {
      const lookup = await Promise.race([
        vintedBrowser.vintedBrowserLookupUser(username),
        new Promise((_, rej) => setTimeout(() => rej(new Error('lookup timeout')), 35000)),
      ]);
      if (lookup?.not_found) {
        return res.status(404).json({ error: `@${username} was not found on Vinted. Check the spelling and try again.` });
      }
      if (lookup?.id) {
        numericId = String(lookup.id);
        console.log(`[vinted-connect] @${username} validated → numeric ID ${numericId}`);
      } else if (lookup?.exists) {
        console.log(`[vinted-connect] @${username} page confirmed (no listings, ID not extracted)`);
      } else if (lookup?.error) {
        console.warn(`[vinted-connect] validation error (saving anyway): ${lookup.error}`);
      }
    } catch (e) {
      // Timeout or crash — save anyway (best-effort; don't block the user)
      console.warn(`[vinted-connect] validation failed (saving anyway): ${e.message}`);
    }
  }

  // ── Clear stale data from any previous connection ────────────────────────
  // Wipe both inventory snapshot AND sales history so no other user's items
  // bleed into this account's profit tracker.
  await saveSetting(`vinted_inventory_${user.id}`, { items: [], last_synced: null });
  await saveSetting(`vinted_sales_${user.id}`,     { sales: [], last_synced: null });

  const save = await upsertPlatformConn(user.id, 'vinted', {
    access_token:      encryptToken(''),
    refresh_token:     null,
    platform_user_id:  numericId,
    platform_username: username,
    connected_at:      new Date().toISOString(),
  });
  if (!save.ok) return res.status(500).json({ error: save.error || 'Could not save connection.' });

  res.json({ ok: true, username, seller_id: numericId || null });
  console.log(`[vinted-connect] @${username} saved for user ${user.id} (seller_id=${numericId || 'unknown'})`);

  // Background: trigger initial inventory sync now that we have the seller ID
  syncVintedInventoryForUser(user.id).catch(e => console.warn('[sync-inventory] initial:', e.message));
});

// Resolve the numeric Vinted user ID from the stored access_token_web.
// Calls /api/v2/users/me via direct HTTP, then Playwright fallback.
// Returns the numeric ID string, or null on failure.
async function resolveVintedUserIdFromToken(accessToken) {
  if (!accessToken) return null;
  try {
    const base = await getVintedBase();
    const r = await vFetch(`${base}/api/v2/users/me`, {
      headers: VINTED_HEADERS(accessToken, base),
      signal:  AbortSignal.timeout(10000),
    });
    if (r?.ok) {
      const d = await r.json().catch(() => null);
      const u = d?.user || d;
      if (u?.id) { console.log(`[resolve-userid] direct HTTP → id ${u.id}`); return String(u.id); }
    }
  } catch (e) { console.warn('[resolve-userid] direct HTTP failed:', e.message); }

  // Playwright fallback — bypasses DataDome
  if (vintedBrowser?.vintedBrowserValidateToken) {
    try {
      const r = await vintedBrowser.vintedBrowserValidateToken(accessToken);
      if (r.valid === true && r.user_id) {
        console.log(`[resolve-userid] Playwright → id ${r.user_id}`);
        return String(r.user_id);
      }
    } catch (e) { console.warn('[resolve-userid] Playwright failed:', e.message); }
  }
  return null;
}

// Core sync: pulls user's listings via Apify actor, diffs against last snapshot,
// items that vanished get marked sold (moved into vinted_sales_${userId}).
async function syncVintedInventoryForUser(userId) {
  const conn = await getPlatformConn(userId, 'vinted');
  if (!conn?.platform_username && !conn?.platform_user_id) return { ok: false, reason: 'no-connection' };

  // ── Resolve numeric seller ID if not yet stored ───────────────────────────
  // Without a numeric ID, inventory fetch falls back to the slow/unreliable
  // member-page scrape. Try three paths in order:
  //   1. /api/v2/users/me with the stored access_token_web (fast, no actor needed)
  //   2. Apify actor search (searches username as keyword, finds seller ID from results)
  let sellerId = conn.platform_user_id || '';
  if (!sellerId) {
    console.log(`[sync-inventory] no seller ID for @${conn.platform_username} — attempting resolution`);

    // Path 1: token-based (stored access_token_web → /api/v2/users/me)
    const rawToken = conn.access_token ? decryptToken(conn.access_token) : '';
    if (rawToken) {
      const id = await resolveVintedUserIdFromToken(rawToken);
      if (id) sellerId = id;
    }



    // Path 3: Playwright member page lookup — bypasses DataDome, reads page state
    if (!sellerId && conn.platform_username && vintedBrowser?.vintedBrowserLookupUser) {
      try {
        const r = await vintedBrowser.vintedBrowserLookupUser(conn.platform_username);
        if (r?.id) {
          sellerId = String(r.id);
          console.log(`[sync-inventory] Playwright lookup → id ${sellerId} for @${conn.platform_username}`);
        }
      } catch (e) { console.warn('[sync-inventory] Playwright lookup failed:', e.message); }
    }

    // Persist if resolved so future syncs use catalog URL directly
    if (sellerId) {
      await upsertPlatformConn(userId, 'vinted', { platform_user_id: sellerId });
      console.log(`[sync-inventory] resolved seller ID ${sellerId} for @${conn.platform_username} — saved`);
    } else {
      console.warn(`[sync-inventory] could not resolve seller ID for @${conn.platform_username}`);
    }
  }
  const confirmedSellerId = !!sellerId; // track whether we have a verified numeric ID

  const identifier   = sellerId || conn.platform_username;
  const connUsername = (conn.platform_username || '').toLowerCase();
  const base = 'https://www.vinted.co.uk';
  console.log(`[sync-inventory] fetching items with identifier=${identifier}`);

  // ── Fetch active listings ─────────────────────────────────────────────────────
  // Three strategies, in order of speed / reliability:
  //   1. REST API with stored token (fast, but token expires after ~1 day)
  //   2. Apify actor scrape (no token needed — scrapes public profile via residential proxy)
  //   3. Playwright browser fallback (slowest, often unavailable on Railway)
  let raw = [];

  // ── Strategy 1: Direct REST API via the WARDROBE endpoint ────────────────────
  // CONFIRMED via live probe: /api/v2/wardrobe/{id}/items returns the seller's
  // OWN listings (correct seller, correct count). The old /catalog/items?seller_ids[]
  // path silently ignored the filter and returned random sellers (→ everything
  // got discarded by the username filter → 0 inventory). /users/{id}/items 404s.
  if (sellerId) {
    const rawToken = conn.access_token ? decryptToken(conn.access_token) : '';
    if (rawToken && rawToken.length >= 20) {
      try {
        const vintedBase = await getVintedBase();
        const headers    = VINTED_HEADERS(rawToken, vintedBase);
        for (let page = 1; page <= 5; page++) {
          const r = await vFetch(
            `${vintedBase}/api/v2/wardrobe/${sellerId}/items?per_page=96&page=${page}&order=newest_first`,
            { headers, signal: AbortSignal.timeout(12000) }
          );
          const text = await r.text();
          if (/datadome|captcha/i.test(text)) {
            console.warn('[sync-inventory] DataDome blocked wardrobe request');
            break;
          }
          if (r.status === 401 || r.status === 403) {
            console.warn(`[sync-inventory] wardrobe ${r.status} — token expired`);
            break;
          }
          let data; try { data = JSON.parse(text); } catch { data = {}; }
          const page_items = data.items || [];
          if (!page_items.length) break;
          raw.push(...page_items);
          console.log(`[sync-inventory] wardrobe page ${page}: ${page_items.length} items`);
          if (page_items.length < 96) break;
        }
        if (raw.length > 0) {
          console.log(`[sync-inventory] wardrobe API: ${raw.length} items for seller ${sellerId}`);
        }
      } catch (e) {
        console.warn('[sync-inventory] wardrobe API error:', e.message);
      }
    } else {
      console.log('[sync-inventory] no valid token — cannot fetch wardrobe');
    }
  }

  // NOTE: There is no token-free way to fetch a seller's listings — the Apify
  // actor's SELLER_PROFILE mode returns stats with an empty items[] array.
  // Inventory depends on the wardrobe REST path above (valid token + proxy).

  // ── Strategy 2: Playwright fallback (last resort) ────────────────────────────
  if (!raw.length && sellerId && vintedBrowser?.vintedBrowserFetchPublicUserItems) {
    try {
      const br = await vintedBrowser.vintedBrowserFetchPublicUserItems(sellerId);
      if (br.items?.length > 0) {
        raw = br.items;
        console.log(`[sync-inventory] Playwright: ${raw.length} items for seller ${sellerId}`);
      } else {
        console.warn('[sync-inventory] Playwright also returned 0 items');
      }
    } catch (e) {
      console.warn('[sync-inventory] Playwright error:', e.message);
    }
  }

  if (!raw.length) {
    console.log(`[sync-inventory] all fetch methods returned 0 items for seller ${sellerId || conn.platform_username}`);
  }

  // Filter items to the connected user only when the actor returns seller info.
  // Rule: discard only if seller info IS present AND username clearly belongs to
  // a different user. If seller info is absent, keep the item (trust the URL).
  const live = connUsername
    ? raw.filter(it => {
        const s = it.seller || it.user || {};
        const sName = (s.username || s.login || s.name || it.sellerUsername || '').toLowerCase();
        if (!sName) return true;                   // no seller info → keep (trust URL)
        if (sName === connUsername) return true;   // exact match → keep
        // Check numeric ID match too
        const sId = String(s.id || s.userId || it.sellerId || it.userId || '');
        if (sId && conn.platform_user_id && sId === String(conn.platform_user_id)) return true;
        return false; // different seller — discard
      })
    : raw;

  console.log(`[sync-inventory] ${live.length}/${raw.length} items kept for @${connUsername}`);

  // If all fetch strategies returned nothing, preserve the existing snapshot
  // items but still stamp last_synced so the dashboard stops showing "syncing".
  if (raw.length === 0) {
    const rawToken = conn.access_token ? decryptToken(conn.access_token) : '';
    const hasToken = rawToken && rawToken.length >= 20;
    const note = !hasToken
      ? 'no valid Vinted token — paste a fresh access_token_web on the Platforms page'
      : !APIFY_TOKEN
        ? 'token may be expired and no Apify fallback configured'
        : 'all fetch strategies returned 0 items — check Apify actor and proxy config';
    console.warn(`[sync-inventory] 0 items for @${connUsername}: ${note}`);
    const prevSnap0 = (await getSetting(`vinted_inventory_${userId}`)) || { items: [] };
    await saveSetting(`vinted_inventory_${userId}`, {
      items: prevSnap0.items || [],
      last_synced: new Date().toISOString(),
      sync_note: note,
    });
    return { ok: true, count: 0, sold_now: 0, actor_empty: true };
  }

  // If all items filtered out (wrong seller), same — stamp last_synced to stop spinner
  if (live.length === 0 && raw.length > 0) {
    console.warn(`[sync-inventory] all ${raw.length} items filtered (wrong seller) for @${connUsername}`);
    const prevSnap0 = (await getSetting(`vinted_inventory_${userId}`)) || { items: [] };
    await saveSetting(`vinted_inventory_${userId}`, {
      items: prevSnap0.items || [],
      last_synced: new Date().toISOString(),
      sync_note: 'all items filtered (wrong seller)',
    });
    return { ok: true, count: 0, sold_now: 0, all_filtered: true };
  }

  const prevSnap = (await getSetting(`vinted_inventory_${userId}`)) || { items: [] };
  const prev     = prevSnap.items || [];

  // Preserve first_seen_at across syncs so we can measure how long a listing has
  // been live (used for Elite stale-listing detection). New items get "now".
  const prevFirstSeen = {};
  for (const p of prev) if (p.id) prevFirstSeen[p.id] = p.first_seen_at || p.last_seen_at;
  const nowIso = new Date().toISOString();
  const fresh = live.map(it => {
    const n = normaliseVintedItem(it, base);
    n.first_seen_at = (n.id && prevFirstSeen[n.id]) ? prevFirstSeen[n.id] : nowIso;
    return n;
  });

  // Detect sales: items in prev (active) that are missing from fresh.
  // ONLY run sale detection when we have a confirmed numeric seller ID —
  // if we fell back to the unreliable member-URL path the "vanished" items
  // could belong to a different user, creating phantom sales.
  const freshIds = new Set(fresh.map(i => i.id).filter(Boolean));
  const vanished = confirmedSellerId
    ? prev.filter(p => p.status === 'active' && p.id && !freshIds.has(p.id))
    : [];

  if (confirmedSellerId && !vanished.length) {
    // nothing vanished — nothing to log
  }
  if (vanished.length) {
    const salesSnap = (await getSetting(`vinted_sales_${userId}`)) || { sales: [] };
    const knownSaleIds = new Set((salesSnap.sales || []).map(s => s.id));
    const newSales = vanished.filter(v => !knownSaleIds.has(v.id)).map(v => ({
      ...v, status: 'sold', sold_at: new Date().toISOString(),
    }));
    if (newSales.length) {
      salesSnap.sales = [...newSales, ...(salesSnap.sales || [])].slice(0, 500);
      salesSnap.last_synced = new Date().toISOString();
      await saveSetting(`vinted_sales_${userId}`, salesSnap);
      console.log(`[sync] ${newSales.length} new Vinted sale(s) detected for user ${userId}`);
    }
  }

  const snap = { items: fresh, last_synced: new Date().toISOString() };
  await saveSetting(`vinted_inventory_${userId}`, snap);
  return { ok: true, count: fresh.length, sold_now: vanished.length };
}

// GET /api/vinted/proxy-test — owner-only. Probes Apify proxy step-by-step
// to isolate which layer is broken when Vinted lookups fail.
app.get('/api/vinted/proxy-test', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id || user.identities?.find(i => i.provider === 'discord')?.id;
  if (discordId !== OWNER_ID) return res.status(403).json({ error: 'Owner only' });

  const out = {
    apify_proxy_password_set: !!process.env.APIFY_PROXY_PASSWORD,
    apify_proxy_password_falling_back_to_token: !process.env.APIFY_PROXY_PASSWORD && !!APIFY_TOKEN,
    apify_proxy_agent_ready: !!APIFY_PROXY_READY,
    tests: {},
  };

  // Test 1: Can we reach Apify's proxy at all? Use ipify.org to see what IP we exit from.
  try {
    const t0 = Date.now();
    const r = await apifyVFetch('https://api.ipify.org/?format=json', { timeout: 30000 });
    out.tests.ipify = { ok: !!r?.ok, status: r?.status, ms: Date.now() - t0 };
    if (r?.ok) out.tests.ipify.body = await r.json();
  } catch (e) {
    out.tests.ipify = { ok: false, error: e.message, cause: e.cause?.code || e.cause?.message || String(e.cause || '') };
  }

  // Test 2: Can we reach Vinted at all through the proxy?
  try {
    const t0 = Date.now();
    const r = await apifyVFetch('https://www.vinted.co.uk/', {
      headers: { 'User-Agent': VINTED_UA, 'Accept': 'text/html,*/*' },
      timeout: 30000,
    });
    out.tests.vinted_homepage = { ok: !!r?.ok, status: r?.status, ms: Date.now() - t0 };
  } catch (e) {
    out.tests.vinted_homepage = { ok: false, error: e.message, cause: e.cause?.code || e.cause?.message || String(e.cause || '') };
  }

  // Test 3: The actual user lookup we're trying to do.
  try {
    const t0 = Date.now();
    const r = await apifyVFetch('https://www.vinted.co.uk/api/v2/users?login=test&per_page=1', {
      headers: { ...VINTED_HEADERS('', 'https://www.vinted.co.uk'), Authorization: undefined },
      timeout: 30000,
    });
    out.tests.vinted_user_lookup = { ok: !!r?.ok, status: r?.status, ms: Date.now() - t0 };
  } catch (e) {
    out.tests.vinted_user_lookup = { ok: false, error: e.message, cause: e.cause?.code || e.cause?.message || String(e.cause || '') };
  }

  res.json(out);
});

// POST /api/vinted/save-token — save user-supplied access_token_web for write actions.
// Required only for auto-listing (POST /api/v2/items). Read features (Inventory,
// Profit Tracker, Watchlist, Auto-Buy) work without a token via Apify proxy.
app.post('/api/vinted/save-token', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const token = String(req.body?.token || '').trim();

  // ── 1. Structural check — access_token_web is always a JWT (three base64 segments) ──
  const parts = token.split('.');
  if (!token.startsWith('eyJ') || parts.length !== 3 || parts.some(p => p.length < 4)) {
    return res.status(400).json({ error: 'That doesn\'t look like a valid token. The access_token_web cookie starts with "eyJ" and contains two dots. Make sure you copied the whole value.' });
  }

  // ── 2. JWT payload decode — no network needed ──────────────────────────────
  // Catches expired tokens and tokens that aren't Vinted JWTs before hitting the DB.
  let jwtPayload = null;
  try {
    jwtPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    try {
      // Some JWTs use standard base64 (with padding) rather than base64url
      jwtPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Token payload could not be decoded. Make sure you copied the full access_token_web value without any extra characters.' });
    }
  }
  if (jwtPayload.exp && jwtPayload.exp < Math.floor(Date.now() / 1000)) {
    const expiredAt = new Date(jwtPayload.exp * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return res.status(401).json({ error: `This token expired on ${expiredAt}. Log in to Vinted in your browser, copy a fresh access_token_web cookie, and paste it here.` });
  }

  // Token IS the connection now — no separate username-connect step. If there's
  // no existing connection we create one from the token's embedded user ID.
  const conn = await getPlatformConn(user.id, 'vinted');
  const isFirstConnect = !conn;

  // ── 3. Extract user ID from JWT payload (Vinted embeds it) ───────────────
  // Vinted's access_token_web payload contains the numeric seller ID — required
  // for inventory + profit sync.
  const jwtUserId = String(
    jwtPayload.user_id || jwtPayload.sub || jwtPayload.id || jwtPayload.uid || ''
  ).replace(/\D/g, ''); // keep digits only — sub may be "user:12345"

  // ── 4. Network validation against Vinted's API (best-effort) ──────────────
  // May return valid:null if DataDome blocks the request from Railway's IP.
  // That's acceptable — the JWT expiry + structure checks above already caught stale tokens.
  const validation = await validateVintedToken(token);
  if (validation.valid === false) {
    return res.status(401).json({ error: validation.error || 'Token rejected by Vinted — it may have been revoked or is for a different region. Get a fresh access_token_web and try again.' });
  }

  const resolvedUserId   = validation.user_id || jwtUserId || conn?.platform_user_id || '';
  const resolvedUsername = validation.username || conn?.platform_username || jwtPayload.username || (resolvedUserId ? `seller_${resolvedUserId}` : 'vinted');
  if (!resolvedUserId) {
    return res.status(400).json({ error: 'Could not read your Vinted seller ID from that token. Make sure you copied the full access_token_web value.' });
  }
  console.log(`[vinted-token] resolved seller ID ${resolvedUserId} for @${resolvedUsername}`);

  const save = await upsertPlatformConn(user.id, 'vinted', {
    access_token:      encryptToken(token),
    refresh_token:     null,
    platform_user_id:  resolvedUserId,
    platform_username: resolvedUsername,
    connected_at:      conn?.connected_at || new Date().toISOString(),
    // token_expires_at omitted — column not yet in schema; expiry surfaced in API response only
  });
  if (!save.ok) return res.status(500).json({ error: save.error || 'Could not save token.' });

  // Fresh connection — clear any stale inventory/sales from a previous account.
  if (isFirstConnect) {
    await saveSetting(`vinted_inventory_${user.id}`, { items: [], last_synced: null });
    await saveSetting(`vinted_sales_${user.id}`,     { sales: [], last_synced: null });
  }

  console.log(`[vinted-token] saved for user ${user.id} (@${resolvedUsername}) valid=${validation.valid} firstConnect=${isFirstConnect} exp=${jwtPayload.exp || 'unknown'}`);

  // ── 5. Live probe — confirm the FULL chain (token + residential proxy) works ──
  // Hit the catalog endpoint once with the fresh token. This is exactly what the
  // inventory sync does, so the result tells the user immediately whether their
  // account-linked features will work — or whether the proxy is the blocker.
  let probe = { ok: null };
  if (resolvedUserId) {
    try {
      const vintedBase = await getVintedBase();
      const r = await vFetch(
        `${vintedBase}/api/v2/catalog/items?seller_ids[]=${resolvedUserId}&per_page=20&page=1&order=newest_first`,
        { headers: VINTED_HEADERS(token, vintedBase), signal: AbortSignal.timeout(12000) }
      );
      const text = await r.text();
      if (/datadome|captcha/i.test(text)) {
        probe = { ok: false, reason: 'datadome', message: 'Token works, but Vinted (DataDome) blocked the request from the server. This is a residential-proxy issue (PROXY_URL), not your token.' };
      } else if (r.status === 401 || r.status === 403) {
        probe = { ok: false, reason: 'auth', message: 'Vinted rejected the token immediately. Copy a fresh access_token_web (you may have grabbed an old/partial value).' };
      } else {
        let data; try { data = JSON.parse(text); } catch { data = {}; }
        const n = (data.items || data.catalog_items || []).length;
        probe = { ok: true, items_found: n, message: n > 0 ? `Found ${n} active listing${n !== 1 ? 's' : ''}.` : 'Token works, but no active listings were returned.' };
      }
    } catch (e) {
      probe = { ok: false, reason: 'network', message: `Couldn't reach Vinted: ${e.message}` };
    }
  }

  // Kick off full inventory + profit sync in the background so data populates now.
  syncVintedInventoryForUser(user.id).catch(e => console.warn('[save-token] inventory sync:', e.message));

  res.json({
    ok:      true,
    expires: jwtPayload.exp ? new Date(jwtPayload.exp * 1000).toISOString() : null,
    warning: validation.valid === null ? validation.warning : undefined,
    probe,
  });
});

// DELETE /api/vinted/save-token — clear stored token without disconnecting account
app.delete('/api/vinted/save-token', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const conn = await getPlatformConn(user.id, 'vinted');
  if (!conn) return res.json({ ok: true });
  await upsertPlatformConn(user.id, 'vinted', {
    access_token:      encryptToken(''),
    refresh_token:     null,
    platform_user_id:  conn.platform_user_id,
    platform_username: conn.platform_username,
    connected_at:      conn.connected_at || new Date().toISOString(),
  });
  res.json({ ok: true });
});

// POST /api/vinted/sync-inventory — force an immediate sync
app.post('/api/vinted/sync-inventory', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.pro) return res.status(403).json({ error: 'Pro subscription required.' });
  const r = await syncVintedInventoryForUser(user.id);
  if (!r.ok) return res.status(400).json({ error: r.reason || 'sync failed' });
  res.json({ ok: true, ...r });
});

// GET/POST /api/vinted/sync-profit — read sales (GET) or trigger sync first (POST)
app.get('/api/vinted/sync-profit', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const conn = await getPlatformConn(user.id, 'vinted');
  if (!conn) return res.json({ ok: true, sales: [], connected: false });
  const snap = (await getSetting(`vinted_sales_${user.id}`)) || { sales: [], last_synced: null };
  res.json({
    ok: true,
    connected: true,
    username: conn.platform_username,
    last_synced: snap.last_synced,
    sales: snap.sales || [],
  });
});

app.post('/api/vinted/sync-profit', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.basic) return res.status(403).json({ error: 'Subscription required.' });
  const conn = await getPlatformConn(user.id, 'vinted');
  if (!conn) return res.status(400).json({ error: 'Connect your Vinted account first.' });

  // ── Pull ALL sold items from Vinted's API using stored token ───────────────
  // Paginates through every page so the full historical record is captured,
  // not just the most recent 100 items. Stops at 20 pages (2000 items) max
  // to prevent request timeouts on very large seller accounts.
  let rawToken = decryptToken(conn.access_token || '');
  if (!rawToken || rawToken.length < 20) {
    return res.status(400).json({ error: 'No valid Vinted session token. Go to Platforms → paste a fresh access_token_web to enable profit sync.', token_expired: true });
  }

  // Resolve seller ID + check expiry — decode the JWT payload once.
  let userId = conn.platform_user_id || '';
  try {
    const parts = rawToken.split('.');
    if (parts.length === 3) {
      const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!userId) userId = String(p.user_id || p.sub || p.id || p.uid || '').replace(/\D/g, '');
      // Reject expired tokens up front with a clear, actionable message.
      if (p.exp && p.exp < Math.floor(Date.now() / 1000)) {
        const when = new Date(p.exp * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return res.status(401).json({
          error: `Your Vinted token expired (${when}). Vinted login tokens are short-lived — go to Platforms and paste a fresh access_token_web cookie to sync your sales.`,
          token_expired: true,
        });
      }
    }
  } catch {}
  if (!userId) {
    return res.status(400).json({ error: 'Could not determine your Vinted seller ID. Please disconnect and reconnect your Vinted account from the Platforms page.' });
  }

  // Vinted retired the public sold-items API (/api/v2/users/{id}/items?item_statuses[]=sold
  // now 404s). The only reliable way to record sales is to diff the active
  // wardrobe over time: when a previously-active listing disappears, it sold.
  // syncVintedInventoryForUser() does exactly that and appends to vinted_sales_${id}.
  let syncResult = { ok: false };
  try {
    syncResult = await syncVintedInventoryForUser(user.id);
  } catch (e) {
    console.warn('[sync-profit] inventory diff failed:', e.message);
  }

  const snap = (await getSetting(`vinted_sales_${user.id}`)) || { sales: [], last_synced: null };
  snap.last_synced = new Date().toISOString();
  await saveSetting(`vinted_sales_${user.id}`, snap);

  const note = (syncResult && syncResult.ok)
    ? 'Sales are detected automatically when a listing sells (disappears from your active items). Historical sales from before you connected can\'t be imported — Vinted no longer exposes them.'
    : 'Could not reach your Vinted listings — check that your token is valid on the Platforms page.';

  res.json({
    ok:           true,
    connected:    true,
    username:     conn.platform_username,
    last_synced:  snap.last_synced,
    sales:        snap.sales || [],
    new_sold:     (syncResult && syncResult.sold_now) || 0,
    total_synced: (snap.sales || []).length,
    note,
  });
});

// DELETE /api/vinted/sales — wipe auto-imported sales history for this user.
app.delete('/api/vinted/sales', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  await saveSetting(`vinted_sales_${user.id}`, { sales: [], last_synced: null });
  res.json({ ok: true });
});

// Get connection status for all platforms
app.get('/api/platform/status', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const platforms = ['depop', 'vinted', 'ebay'];
  const connections = {};
  for (const p of platforms) {
    const conn = await getPlatformConn(user.id, p);
    if (conn) {
      let hasToken = false;
      let tokenValid = null;      // true / false / null(unknown)
      let tokenExpiresAt = null;
      try {
        const tok = decryptToken(conn.access_token || '');
        hasToken = !!(tok && tok.length >= 20);
        // For Vinted, decode the JWT exp claim so the dashboard can warn the
        // user before/after the token expires (Vinted access_token_web is short-lived).
        if (hasToken && p === 'vinted') {
          const parts = tok.split('.');
          if (parts.length === 3) {
            try {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              if (payload.exp) {
                tokenExpiresAt = new Date(payload.exp * 1000).toISOString();
                tokenValid = payload.exp > Math.floor(Date.now() / 1000);
              }
            } catch {}
          }
        }
      } catch { hasToken = false; }
      connections[p] = {
        connected: true,
        username:  conn.platform_username,
        connected_at: conn.connected_at,
        has_token: hasToken,
        token_valid: tokenValid,
        token_expires_at: tokenExpiresAt,
      };
    } else {
      connections[p] = { connected: false };
    }
  }
  res.json({ ok: true, connections });
});

// ── Vinted diagnostic test endpoint ──────────────────────────────────────────
// GET /api/vinted/test — owner-only; checks proxy, Playwright, and API access
// Returns a JSON object with the full status of each layer so you can tell
// exactly which layer is broken without reading Railway logs.
app.get('/api/vinted/test', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id || user.identities?.find(i => i.provider === 'discord')?.id;
  if (discordId !== OWNER_ID) return res.status(403).json({ error: 'Owner only' });

  const report = {
    proxy:     { configured: !!PROXY_URL, agent_ready: !!PROXY_AGENT },
    undici:    { available: !!(undFetch && ProxyAgent) },
    playwright:{ module_loaded: !!vintedBrowser, chromium_available: false },
    vinted_reach: null,
    token_test: null,
  };

  // Playwright status
  try {
    if (vintedBrowser) {
      // A cheap way to test: just check if chromium is accessible (chromium !== null in the module)
      // We can infer this from whether browser functions exist
      report.playwright.chromium_available = typeof vintedBrowser.vintedBrowserValidateToken === 'function';
    }
  } catch (e) { report.playwright.error = e.message; }

  // Can we reach vinted.co.uk at all?
  try {
    const t0 = Date.now();
    const base = await getVintedBase();
    report.vinted_reach = { ok: true, base, ms: Date.now() - t0 };
  } catch (e) {
    report.vinted_reach = { ok: false, error: e.message };
  }

  // Test the user's stored Vinted token (if they have one)
  try {
    const conn = await getPlatformConn(user.id, 'vinted');
    if (conn) {
      const rawToken = decryptToken(conn.access_token || '');
      const hasToken = rawToken && rawToken.length >= 20;

      // Surface stored seller ID — if this is empty, profit sync hits /users/me/items (404)
      report.seller_id = {
        stored:    conn.platform_user_id || null,
        ok:        !!(conn.platform_user_id),
        username:  conn.platform_username,
      };

      if (hasToken) {
        const t0 = Date.now();
        const r = await legacyValidateVintedToken(rawToken);
        report.token_test = { ...r, ms: Date.now() - t0, username: conn.platform_username, has_token: true };
      } else {
        report.token_test = { skipped: 'No access_token_web saved — go to Platforms and paste your cookie', username: conn.platform_username, has_token: false };
      }
    } else {
      report.seller_id = { ok: false, stored: null };
      report.token_test = { skipped: 'No Vinted account connected — go to Platforms to connect' };
    }
  } catch (e) {
    report.token_test = { error: e.message };
  }

  // Quick profit sync test — try fetching 1 sold item to confirm the full chain works
  try {
    const conn = await getPlatformConn(user.id, 'vinted');
    if (conn?.platform_user_id) {
      const rawToken = decryptToken(conn.access_token || '');
      if (rawToken && rawToken.length >= 20) {
        const base    = await getVintedBase();
        const headers = VINTED_HEADERS(rawToken, base);
        const t0 = Date.now();
        const r = await vFetch(
          `${base}/api/v2/users/${conn.platform_user_id}/items?item_statuses[]=sold&per_page=1&page=1`,
          { headers, signal: AbortSignal.timeout(10000) }
        );
        const text = await r.text();
        if (/datadome|captcha/i.test(text)) {
          report.profit_sync_test = { ok: false, error: 'DataDome blocked the sold-items request' };
        } else {
          let data; try { data = JSON.parse(text); } catch { data = null; }
          const count = data?.pagination?.total_count ?? data?.items?.length ?? '?';
          report.profit_sync_test = { ok: r.ok, status: r.status, sold_items_total: count, ms: Date.now() - t0 };
        }
      } else {
        report.profit_sync_test = { skipped: 'No token saved' };
      }
    } else {
      report.profit_sync_test = { skipped: 'No seller ID stored — profit sync cannot run' };
    }
  } catch (e) {
    report.profit_sync_test = { ok: false, error: e.message };
  }

  // Catalog inventory test — this is the actual endpoint used by syncVintedInventoryForUser
  try {
    const conn = await getPlatformConn(user.id, 'vinted');
    if (conn?.platform_user_id) {
      const sellerId  = conn.platform_user_id;
      const rawToken  = conn.access_token ? decryptToken(conn.access_token) : '';
      const vintedBase = await getVintedBase();
      const catalogUrl = `${vintedBase}/api/v2/catalog/items?seller_ids[]=${sellerId}&per_page=10&page=1&order=newest_first`;

      // Test 1: with auth
      const hdrs1 = rawToken ? VINTED_HEADERS(rawToken, vintedBase)
        : { 'User-Agent': VINTED_UA, 'Accept': 'application/json', 'Accept-Language': 'en-GB' };
      const t1 = Date.now();
      const r1 = await vFetch(catalogUrl, { headers: hdrs1, signal: AbortSignal.timeout(12000) });
      const text1 = await r1.text();
      const blocked1 = /datadome|captcha/i.test(text1);
      let data1; try { data1 = JSON.parse(text1); } catch { data1 = null; }
      report.catalog_test = {
        url: catalogUrl,
        with_auth: { status: r1.status, blocked: blocked1, items_count: data1?.items?.length ?? 0, keys: data1 ? Object.keys(data1).join(',') : 'parse_error', ms: Date.now() - t1 },
      };

      // Test 2: without auth (anonymous)
      const hdrs2 = { 'User-Agent': VINTED_UA, 'Accept': 'application/json', 'Accept-Language': 'en-GB', 'Origin': vintedBase, 'Referer': `${vintedBase}/` };
      const t2 = Date.now();
      const r2 = await vFetch(catalogUrl, { headers: hdrs2, signal: AbortSignal.timeout(12000) });
      const text2 = await r2.text();
      const blocked2 = /datadome|captcha/i.test(text2);
      let data2; try { data2 = JSON.parse(text2); } catch { data2 = null; }
      report.catalog_test.without_auth = { status: r2.status, blocked: blocked2, items_count: data2?.items?.length ?? 0, keys: data2 ? Object.keys(data2).join(',') : 'parse_error', ms: Date.now() - t2 };

      // If both return 0, show a snippet of the raw response so we can debug
      if ((data1?.items?.length || 0) === 0 && (data2?.items?.length || 0) === 0) {
        report.catalog_test.raw_snippet = text1.slice(0, 300);
      }
    } else {
      report.catalog_test = { skipped: 'No seller ID stored' };
    }
  } catch (e) {
    report.catalog_test = { error: e.message };
  }

  // Apify actor test — checks whether the configured actor/task is reachable
  try {
    const rawId = APIFY_VINTED_ACTOR;
    const tildeId = rawId.replace('/', '~');
    report.apify_test = { actor_id: rawId, token_set: !!APIFY_TOKEN };
    if (APIFY_TOKEN) {
      // Quick check: just hit the actor metadata (not a run) to see if it exists
      const r1 = await fetch(`https://api.apify.com/v2/acts/${rawId}?token=${APIFY_TOKEN}`, { signal: AbortSignal.timeout(8000) });
      report.apify_test.actor_endpoint = { status: r1.status, found: r1.ok };
      if (!r1.ok) {
        const r2 = await fetch(`https://api.apify.com/v2/actor-tasks/${tildeId}?token=${APIFY_TOKEN}`, { signal: AbortSignal.timeout(8000) });
        report.apify_test.task_endpoint = { status: r2.status, found: r2.ok, id_used: tildeId };
      }
    }
  } catch (e) {
    report.apify_test = { ...report.apify_test, error: e.message };
  }

  res.json(report);
});

// ── Listing endpoints ─────────────────────────────────────────────────────────

// Create a listing across one or more platforms
app.post('/api/listing/create', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;

  const profile = await getProfileByDiscordId(
    user.user_metadata?.provider_id || user.identities?.find(i => i.provider === 'discord')?.id
  );
  if (!profile || profile.subscription_status !== 'active') return res.status(403).json({ error: 'Active subscription required' });
  if (TIER_RANK[profile.tier] < TIER_RANK.pro) return res.status(403).json({ error: 'Pro subscription required for listings' });

  const {
    title, description, price, condition,
    platforms = [], autoRelist = false, relistIntervalDays = 7, images = [],
    // Platform-specific fields
    brand = '', size = '',
    vinted_catalog_id = null, vinted_package_size_id = 2,
    depop_category_id = null, hashtags = '',
  } = req.body;
  if (!title || !price) return res.status(400).json({ error: 'title and price required' });
  if (!platforms.length) return res.status(400).json({ error: 'Select at least one platform' });

  // images = [{ base64: '...', mimeType: 'image/jpeg' }, ...]
  const listingData = {
    title, description, price, condition, images,
    brand, size,
    vinted_catalog_id, vinted_package_size_id,
    depop_category_id, hashtags,
  };
  const results = {};
  const platformListingIds = {};

  for (const p of platforms) {
    const r = await postToPlatform(user.id, p, listingData);
    results[p] = r;
    if (r.ok && r.listing_id) platformListingIds[p] = r.listing_id;
    console.log(`[listing] ${p} → ${r.ok ? `listed ${r.listing_id}` : `failed: ${r.error}`}`);
  }

  const successPlatforms = platforms.filter(p => results[p]?.ok);
  if (!successPlatforms.length) return res.status(500).json({ error: 'Failed to list on all platforms', results });

  const nextRelistAt = autoRelist
    ? new Date(Date.now() + relistIntervalDays * 86400000).toISOString()
    : null;

  const record = await createListingRecord(user.id, {
    title, description, price, condition,
    platforms: successPlatforms,
    platform_listing_ids: platformListingIds,
    auto_relist: autoRelist,
    relist_interval_days: relistIntervalDays,
    next_relist_at: nextRelistAt,
    status: 'active',
  });

  res.json({ ok: true, listing_id: record?.id, results });
});

// Get all listings for the authenticated user
app.get('/api/listings', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const listings = await getListingsByUser(user.id);
  res.json({ ok: true, listings });
});

// Delete a listing from all platforms
app.delete('/api/listing/:id', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const listing = await getListingById(req.params.id);
  if (!listing || listing.user_id !== user.id) return res.status(404).json({ error: 'Listing not found' });

  const ids = listing.platform_listing_ids || {};
  const deleteResults = {};
  for (const p of listing.platforms || []) {
    if (ids[p]) {
      deleteResults[p] = await deleteFromPlatform(user.id, p, ids[p]);
    }
  }
  await updateListingRecord(listing.id, { status: 'deleted', auto_relist: false });
  console.log(`[listing] Deleted listing ${listing.id}`);
  res.json({ ok: true, results: deleteResults });
});

// Manually relist — delete old listings, create fresh ones
app.post('/api/listing/:id/relist', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const listing = await getListingById(req.params.id);
  if (!listing || listing.user_id !== user.id) return res.status(404).json({ error: 'Listing not found' });

  const ids = listing.platform_listing_ids || {};
  const newIds = {};
  const results = {};

  for (const p of listing.platforms || []) {
    // Delete old
    if (ids[p]) await deleteFromPlatform(user.id, p, ids[p]);
    // Create fresh
    const r = await postToPlatform(user.id, p, {
      title: listing.title, description: listing.description,
      price: listing.price, condition: listing.condition,
    });
    results[p] = r;
    if (r.ok && r.listing_id) newIds[p] = r.listing_id;
  }

  const nextRelistAt = listing.auto_relist
    ? new Date(Date.now() + (listing.relist_interval_days || 7) * 86400000).toISOString()
    : null;

  await updateListingRecord(listing.id, {
    platform_listing_ids: newIds,
    next_relist_at: nextRelistAt,
  });

  console.log(`[listing] Manual relist ${listing.id}`);
  res.json({ ok: true, results });
});

// Update relist schedule for a listing
app.patch('/api/listing/:id/schedule', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const listing = await getListingById(req.params.id);
  if (!listing || listing.user_id !== user.id) return res.status(404).json({ error: 'Listing not found' });

  const { autoRelist, relistIntervalDays } = req.body;
  const days = parseInt(relistIntervalDays) || listing.relist_interval_days || 7;
  const nextRelistAt = autoRelist
    ? new Date(Date.now() + days * 86400000).toISOString()
    : null;

  await updateListingRecord(listing.id, {
    auto_relist: !!autoRelist,
    relist_interval_days: days,
    next_relist_at: nextRelistAt,
  });
  res.json({ ok: true });
});

// ── Image upload endpoint (upload images before creating a listing) ───────────
// Accepts base64 images and uploads to the user's connected platforms.
// Returns { depop_ids: [], vinted_ids: [] }
app.post('/api/listing/upload-images', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { images = [], platforms = [] } = req.body || {};
  // images: [{ base64: string, mimeType: string }]
  if (!images.length) return res.status(400).json({ error: 'No images provided' });

  const result = {};
  for (const platform of platforms) {
    const conn = await getPlatformConn(user.id, platform);
    if (!conn?.access_token) { result[platform] = { error: 'Not connected' }; continue; }
    const token = decryptToken(conn.access_token);
    const ids = await uploadImagesToPlatform(token, platform, images);
    result[platform] = { ids };
  }
  res.json({ ok: true, result });
});

// ── Photo enhancer — analyse item via GPT-4o vision ──────────────────────────
app.post('/api/photo/analyze', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image required' });
  if (!OPENAI_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured on server' });
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'low' } },
          { type: 'text', text: `Identify the product in this image for a resale listing. Return ONLY valid JSON with no markdown:\n{\n  "itemType": "descriptive name e.g. White Crew-Neck T-Shirt or Nike Air Max 90",\n  "category": "one of: clothing, shoes, electronics, bags, jewellery, books, other",\n  "modifications": [\n    {"id":"m1","label":"Short action e.g. Remove wrinkles","prompt":"detailed editing instruction for AI image model"},\n    {"id":"m2","label":"...","prompt":"..."},\n    {"id":"m3","label":"...","prompt":"..."},\n    {"id":"m4","label":"...","prompt":"..."}\n  ]\n}\nReturn exactly 4 modifications specific to this exact item. Examples by category:\n- clothing: Remove wrinkles, Smooth fabric creases, Add natural shape, Enhance colour vibrancy\n- shoes: Clean laces, Remove scuff marks, Align symmetrically, Brighten sole\n- electronics: Remove screen reflections, Remove surface scratches, Straighten alignment, Enhance finish\n- bags: Shape and structure, Polish hardware, Remove scuffs, Enhance texture\n- jewellery: Enhance sparkle, Clean metal finish, Remove tarnish, Improve clarity\n- other: Remove dust marks, Brighten item, Clean edges, Enhance colours` }
        ]}]
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) { const e = await response.text(); return res.status(502).json({ error: 'OpenAI error: ' + e.slice(0,200) }); }
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '{}';
    const result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    res.json({ ok: true, itemType: result.itemType || 'Product', category: result.category || 'other', modifications: result.modifications || [] });
  } catch (e) { console.error('[photo/analyze]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Photo enhancer — generate enhanced product photo via gpt-image-1 ─────────
app.post('/api/photo/generate', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { image, background = 'white-studio', lighting = 'studio', modifications = [], itemType = '' } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image (base64 PNG) required' });
  if (!OPENAI_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured on server' });

  const BG = {
    'white-studio': 'a pure seamless white studio backdrop with white sweep',
    'black':        'a pure deep black studio backdrop',
    'marble':       'a luxurious white and grey Carrara marble surface and background',
    'wood':         'a warm natural oak wood grain surface with neutral background',
    'concrete':     'an industrial grey concrete texture surface and background',
    'stone':        'a natural grey stone texture surface',
    'sage':         'a muted sage green seamless paper backdrop',
    'cream':        'a warm cream off-white seamless backdrop',
    'navy':         'a deep navy blue seamless backdrop',
    'gradient-pink':'a soft pink-to-white gradient studio backdrop',
  };
  const LIGHT = {
    'studio':   'professional even studio lighting with soft fill and minimal shadows',
    'soft':     'diffused soft-box lighting, flattering with very soft shadows',
    'dramatic': 'strong directional side lighting with deep dramatic shadows',
    'natural':  'warm golden natural daylight streaming from one side',
    'sharp':    'crisp high-contrast harsh studio lighting with defined shadows',
  };

  const bgDesc    = BG[background]    || BG['white-studio'];
  const lightDesc = LIGHT[lighting]   || LIGHT['studio'];
  const modDesc   = modifications.length ? `Apply these product enhancements: ${modifications.join('; ')}.` : '';
  const itemDesc  = itemType ? `The product is a ${itemType}.` : '';

  const prompt = `Professional product photography for an online resale listing. ${itemDesc} Place the product on ${bgDesc}. Lighting: ${lightDesc}. ${modDesc} Product perfectly centred and upright. No mannequins, no hands, no people, no watermarks, no text, no price tags. Photorealistic studio quality, suitable for eBay, Depop, Vinted.`.replace(/\s+/g,' ').trim();

  try {
    const imgBuffer = Buffer.from(image, 'base64');
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('prompt', prompt);
    form.append('size', '1024x1024');
    form.append('quality', 'high');
    form.append('n', '1');
    form.append('image', new Blob([imgBuffer], { type: 'image/png' }), 'image.png');
    const aiRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('[photo/generate] OpenAI error:', errText.slice(0,300));
      let errMsg = 'AI generation failed.';
      try { errMsg = JSON.parse(errText)?.error?.message || errMsg; } catch {}
      return res.status(502).json({ error: errMsg });
    }
    const data = await aiRes.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: 'No image returned from OpenAI' });
    res.json({ ok: true, image: b64 });
  } catch (e) { console.error('[photo/generate]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Photo enhancer — remove.bg background removal ────────────────────────────
app.post('/api/photo/enhance', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { image, mimeType = 'image/jpeg' } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image (base64) required' });

  if (!REMOVE_BG_KEY) {
    return res.status(503).json({ error: 'Background removal unavailable — REMOVE_BG_API_KEY not configured.' });
  }

  try {
    const imgBuffer = Buffer.from(image, 'base64');
    const boundary  = `----FormBoundary${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="photo.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      imgBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\nauto\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const rbRes = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': REMOVE_BG_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Accept': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (!rbRes.ok) {
      const err = await rbRes.text();
      console.error('[photo] remove.bg error:', err.slice(0, 200));
      return res.status(502).json({ error: 'Background removal failed. Please try again.' });
    }

    const data = await rbRes.json();
    // remove.bg returns base64 PNG in data.result_b64
    const resultB64 = data.result_b64 || data.data?.result_b64;
    if (!resultB64) return res.status(502).json({ error: 'Unexpected response from remove.bg' });

    res.json({ ok: true, image: resultB64, mimeType: 'image/png' });
  } catch (e) {
    console.error('[photo] enhance error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Credits helpers ───────────────────────────────────────────────────────────
const SB_HDR = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' });

async function getCredits(userId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=credits`, { headers: SB_HDR() });
  const [row] = await r.json();
  return typeof row?.credits === 'number' ? row.credits : 0;
}

async function setCredits(userId, amount) {
  await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH', headers: SB_HDR(), body: JSON.stringify({ credits: Math.max(0, Math.round(amount)) }),
  });
}

async function deductCredits(userId, amount) {
  const bal = await getCredits(userId);
  if (bal < amount) throw Object.assign(new Error(`Insufficient credits — you have ${bal}, need ${amount}.`), { code: 'INSUFFICIENT_CREDITS', balance: bal });
  await setCredits(userId, bal - amount);
  return bal - amount;
}

async function addCredits(userId, amount) {
  const bal = await getCredits(userId);
  await setCredits(userId, bal + amount);
  return bal + amount;
}

// ── Credits — get balance ──────────────────────────────────────────────────────
app.get('/api/credits/balance', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  try {
    const bal = await getCredits(user.id);
    res.json({ ok: true, credits: bal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Credits — PayPal helpers ───────────────────────────────────────────────────
const PAYPAL_BASE = () => PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

let _ppToken = null; let _ppTokenExp = 0;
async function getPayPalToken() {
  if (_ppToken && Date.now() < _ppTokenExp) return _ppToken;
  const r = await fetch(`${PAYPAL_BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('PayPal auth failed: ' + (await r.text()).slice(0,200));
  const d = await r.json();
  _ppToken = d.access_token;
  _ppTokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return _ppToken;
}

const CREDIT_PACKAGES = {
  credits_500:  { credits: 500,  price: '3.99',  label: '500 Credits'   },
  credits_1000: { credits: 1000, price: '7.99',  label: '1,000 Credits' },
  credits_2500: { credits: 2500, price: '16.99', label: '2,500 Credits' },
  credits_5000: { credits: 5000, price: '29.99', label: '5,000 Credits' },
};

// ── Credits — create PayPal order ─────────────────────────────────────────────
app.post('/api/credits/create-order', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { package: pkg } = req.body || {};
  const pack = CREDIT_PACKAGES[pkg];
  if (!pack) return res.status(400).json({ error: 'Invalid package' });
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) return res.status(503).json({ error: 'Payments not configured' });
  try {
    const token = await getPayPalToken();
    const r = await fetch(`${PAYPAL_BASE()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `${user.id}-${pkg}-${Date.now()}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'GBP', value: pack.price }, description: `Vendora ${pack.label}`, custom_id: `${user.id}|${pkg}` }],
        application_context: { brand_name: 'Vendora', user_action: 'PAY_NOW' },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return res.status(502).json({ error: 'PayPal order creation failed: ' + (await r.text()).slice(0,200) });
    const d = await r.json();
    res.json({ ok: true, orderID: d.id });
  } catch (e) { console.error('[credits/create-order]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Credits — capture PayPal order + credit account ───────────────────────────
app.post('/api/credits/capture-order', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { orderID } = req.body || {};
  if (!orderID) return res.status(400).json({ error: 'orderID required' });
  try {
    const token = await getPayPalToken();
    const r = await fetch(`${PAYPAL_BASE()}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    if (!r.ok || d.status !== 'COMPLETED') return res.status(502).json({ error: 'Payment not completed: ' + JSON.stringify(d).slice(0,200) });
    // Extract package from custom_id: "userId|pkg"
    const customId = d.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id || '';
    const [, pkg] = customId.split('|');
    const pack = CREDIT_PACKAGES[pkg];
    if (!pack) return res.status(400).json({ error: 'Could not determine package from order' });
    const newBal = await addCredits(user.id, pack.credits);
    console.log(`[credits] +${pack.credits} → user ${user.id} (order ${orderID}), new balance: ${newBal}`);
    // Send Vendora-branded DM confirmation
    const discordId = user.user_metadata?.provider_id || user.identities?.find(i=>i.provider==='discord')?.id;
    sendCreditsDM(discordId, pack.credits, newBal, 'purchase');
    res.json({ ok: true, credits_added: pack.credits, new_balance: newBal });
  } catch (e) { console.error('[credits/capture-order]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Credits — redeem a credit code ────────────────────────────────────────────
app.post('/api/credits/redeem', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  const upperCode = code.trim().toUpperCase();
  try {
    // Fetch code
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/credit_codes?code=eq.${encodeURIComponent(upperCode)}&active=eq.true&select=*`, { headers: SB_HDR() });
    const [codeRow] = await cr.json();
    if (!codeRow) return res.status(404).json({ error: 'Code not found or already deactivated.' });
    // Check expiry
    if (codeRow.expires_at && new Date(codeRow.expires_at) < new Date()) return res.status(400).json({ error: 'This code has expired.' });
    // Check max uses
    if (codeRow.max_uses > 0 && codeRow.uses_count >= codeRow.max_uses) return res.status(400).json({ error: 'This code has reached its usage limit.' });
    // Check not already redeemed by this user
    const rr = await fetch(`${SUPABASE_URL}/rest/v1/code_redemptions?code=eq.${encodeURIComponent(upperCode)}&user_id=eq.${encodeURIComponent(user.id)}`, { headers: SB_HDR() });
    const redemptions = await rr.json();
    if (redemptions.length > 0) return res.status(400).json({ error: 'You have already redeemed this code.' });
    // Record redemption
    await fetch(`${SUPABASE_URL}/rest/v1/code_redemptions`, { method: 'POST', headers: SB_HDR(), body: JSON.stringify({ code: upperCode, user_id: user.id }) });
    // Increment uses_count
    await fetch(`${SUPABASE_URL}/rest/v1/credit_codes?code=eq.${encodeURIComponent(upperCode)}`, { method: 'PATCH', headers: SB_HDR(), body: JSON.stringify({ uses_count: codeRow.uses_count + 1 }) });
    // Add credits
    const newBal = await addCredits(user.id, codeRow.credits_amount);
    // DM confirmation
    const discordId = user.user_metadata?.provider_id || user.identities?.find(i=>i.provider==='discord')?.id;
    sendCreditsDM(discordId, codeRow.credits_amount, newBal, 'code');
    res.json({ ok: true, credits_added: codeRow.credits_amount, new_balance: newBal });
  } catch (e) { console.error('[credits/redeem]', e.message); res.status(500).json({ error: e.message }); }
});

// ── PhotoRoom — AI product photo (costs 80 credits) ───────────────────────────
const PHOTOROOM_CREDIT_COST = 80;
const PHOTOROOM_BG_MAP = {
  'white-studio': { color: '#FFFFFF' },
  'soft-grey':    { color: '#E0E0E0' },
  'cream':        { color: '#FAF0E0' },
  'sage':         { color: '#C8D4C0' },
  'blush':        { color: '#F5DADA' },
  'black':        { color: '#111111' },
  'navy':         { color: '#0D1B2A' },
  'marble':       { prompt: 'luxurious white Carrara marble surface with subtle grey veining, professional product photography' },
  'wood':         { prompt: 'natural warm oak wood surface, fine grain, professional product photography' },
  'concrete':     { prompt: 'urban raw grey concrete surface texture, professional product photography' },
  'linen':        { prompt: 'textured cream linen fabric surface, professional product photography' },
  'studio-dark':  { color: '#252525' },
  'gradient-pink':{ color: '#2A0018' },
  'gradient-blue':{ color: '#0A0E1A' },
};

app.post('/api/photo/photoroom', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { image, background = 'white-studio', lighting = 'studio' } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image (base64) required' });
  if (!PHOTOROOM_KEY) return res.status(503).json({ error: 'PhotoRoom not configured — PHOTOROOM_API_KEY missing' });

  // Check + deduct credits
  try {
    await deductCredits(user.id, PHOTOROOM_CREDIT_COST);
  } catch (e) {
    if (e.code === 'INSUFFICIENT_CREDITS') return res.status(402).json({ error: e.message, balance: e.balance });
    return res.status(500).json({ error: e.message });
  }

  try {
    const imgBuffer = Buffer.from(image, 'base64');
    const form = new FormData();
    form.append('imageFile', new Blob([imgBuffer], { type: 'image/png' }), 'image.png');
    form.append('outputSize', '1000x1000');
    form.append('padding', '0.08');

    const bgConfig = PHOTOROOM_BG_MAP[background] || { color: '#FFFFFF' };
    if (bgConfig.color) {
      form.append('background.color', bgConfig.color);
    } else if (bgConfig.prompt) {
      form.append('background.prompt', bgConfig.prompt);
    }

    // Lighting → shadow hint
    const shadowMap = { studio: '0.4', soft: '0.2', dramatic: '0.7', natural: '0.35', sharp: '0.6' };
    form.append('shadow.mode', 'ai.soft');

    const prRes = await fetch('https://image-api.photoroom.com/v2/edit', {
      method: 'POST',
      headers: { 'x-api-key': PHOTOROOM_KEY, 'Accept': 'image/png' },
      body: form,
      signal: AbortSignal.timeout(60000),
    });

    if (!prRes.ok) {
      const errText = await prRes.text();
      console.error('[photo/photoroom] PhotoRoom error:', prRes.status, errText.slice(0,300));
      // Refund credits on API failure
      await addCredits(user.id, PHOTOROOM_CREDIT_COST);
      return res.status(502).json({ error: `PhotoRoom API error (${prRes.status}). Credits refunded.` });
    }

    const imgArrayBuffer = await prRes.arrayBuffer();
    const resultB64 = Buffer.from(imgArrayBuffer).toString('base64');
    const newBal = await getCredits(user.id);
    res.json({ ok: true, image: resultB64, mimeType: 'image/png', new_balance: newBal });
  } catch (e) {
    console.error('[photo/photoroom]', e.message);
    // Refund credits on unexpected error
    try { await addCredits(user.id, PHOTOROOM_CREDIT_COST); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// POST /api/photo/instruct — interpret natural-language editing instructions on an image
// Returns { ok, settings, message } where settings is an object that maps instruction
// keywords to PhotoRoom-compatible parameters the dashboard can pass to /api/photo/photoroom.
app.post('/api/photo/instruct', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { image, instructions } = req.body || {};
  if (!instructions?.trim()) return res.status(400).json({ error: 'instructions required' });

  const systemPrompt = `You are a photo editing assistant for resellers. Given a user's editing instruction, extract structured settings for a product photo editor.
Respond ONLY with valid JSON (no markdown, no explanation). The JSON object may include any of these optional keys:
- "background": one of: "white-studio", "light-grey", "cream", "soft-pink", "black", "navy", "forest-green", "gradient-pink", "gradient-blue", "studio-dark"
- "lighting": one of: "studio", "soft", "dramatic", "natural", "sharp"
- "remove_background": true/false
- "message": a short friendly confirmation of what you're doing (max 80 chars)
Only include keys relevant to the instruction. If nothing specific is requested, return { "message": "No changes detected" }.`;

  try {
    const aiResp = await callAI(systemPrompt, instructions.trim(), 'claude-haiku-4-5-20251001', 300);
    let settings = {};
    try { settings = JSON.parse(aiResp); } catch { settings = { message: aiResp?.slice(0, 200) }; }
    const message = settings.message || 'Settings applied from your instructions.';
    delete settings.message;
    res.json({ ok: true, settings, message });
  } catch (e) {
    console.error('[photo/instruct]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin — get/set user credits ──────────────────────────────────────────────
app.post('/api/admin/credits/adjust', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id || user.identities?.find(i=>i.provider==='discord')?.id || '';
  if (discordId !== OWNER_ID) return res.status(403).json({ error: 'Owner only' });
  const { user_id, amount, mode = 'set' } = req.body || {}; // mode: 'set' | 'add' | 'subtract'
  if (!user_id || typeof amount !== 'number') return res.status(400).json({ error: 'user_id and amount required' });
  try {
    // Accept Discord ID (numeric string) or Supabase UUID — resolve to the profiles.id UUID
    let profileId = user_id;
    let targetDiscordId = null;
    if (/^\d+$/.test(user_id.trim())) {
      // Looks like a Discord ID — look up the profile row by discord_id
      targetDiscordId = user_id.trim();
      const lookup = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?discord_id=eq.${encodeURIComponent(targetDiscordId)}&select=id`,
        { headers: SB_HDR() }
      );
      const [row] = await lookup.json();
      if (!row?.id) return res.status(404).json({ error: `No profile found for Discord ID ${user_id}` });
      profileId = row.id;
    } else {
      // UUID — look up discord_id for the DM
      const lookup = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(profileId)}&select=discord_id`,
        { headers: SB_HDR() }
      );
      const [row] = await lookup.json();
      targetDiscordId = row?.discord_id || null;
    }

    const prevBal = await getCredits(profileId);
    let newBal;
    if (mode === 'set') { await setCredits(profileId, amount); newBal = Math.max(0, Math.round(amount)); }
    else if (mode === 'add') { newBal = await addCredits(profileId, amount); }
    else if (mode === 'subtract') { newBal = await deductCredits(profileId, amount); }
    else return res.status(400).json({ error: 'Invalid mode' });

    // DM when credits were effectively granted (i.e. balance went up)
    const delta = newBal - prevBal;
    if (delta > 0 && targetDiscordId) {
      sendCreditsDM(targetDiscordId, delta, newBal, 'admin');
    }

    res.json({ ok: true, new_balance: newBal });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin — credit codes CRUD ──────────────────────────────────────────────────
app.get('/api/admin/codes', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id || user.identities?.find(i=>i.provider==='discord')?.id || '';
  if (discordId !== OWNER_ID) return res.status(403).json({ error: 'Owner only' });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/credit_codes?order=created_at.desc&select=*`, { headers: SB_HDR() });
    res.json({ ok: true, codes: await r.json() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/codes', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id || user.identities?.find(i=>i.provider==='discord')?.id || '';
  if (discordId !== OWNER_ID) return res.status(403).json({ error: 'Owner only' });
  const { code, credits_amount, max_uses = 1, expires_at = null } = req.body || {};
  if (!code || !credits_amount) return res.status(400).json({ error: 'code and credits_amount required' });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/credit_codes`, {
      method: 'POST', headers: SB_HDR(),
      body: JSON.stringify({ code: code.trim().toUpperCase(), credits_amount: Math.round(credits_amount), max_uses: Math.round(max_uses), expires_at: expires_at || null, active: true }),
    });
    if (!r.ok) { const e = await r.json(); return res.status(400).json({ error: e.message || JSON.stringify(e) }); }
    res.json({ ok: true, code: await r.json() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/codes/:code', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id || user.identities?.find(i=>i.provider==='discord')?.id || '';
  if (discordId !== OWNER_ID) return res.status(403).json({ error: 'Owner only' });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/credit_codes?code=eq.${encodeURIComponent(req.params.code)}`, { method: 'DELETE', headers: SB_HDR() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Usage stats ───────────────────────────────────────────────────────────────
app.get('/api/usage', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';

  // Read from in-memory store
  const userStore = usageStore.get(discordId);
  const usage = {};
  if (userStore) {
    const now = Date.now();
    for (const [group, entry] of userStore.entries()) {
      if (now < entry.resetAt) {
        usage[group] = { used: entry.count, resetAt: entry.resetAt };
      }
    }
  }
  res.json({ usage });
});

// ── Tracker (manual inventory) endpoints ─────────────────────────────────────
// Note: GET /api/inventory is defined above (line ~2743) for the Vinted auto-synced
// inventory snapshot. The POST / DELETE routes below handle the manual tracker items
// used by the /tracker Discord command (stored via dbAddInventory / dbRemoveInventory).
app.post('/api/inventory', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';
  const { item } = req.body || {};
  if (!item?.trim()) return res.status(400).json({ error: 'item required' });
  await dbAddInventory(discordId, item.trim());
  const items = await dbGetInventory(discordId);
  res.json({ ok: true, items });
});

app.delete('/api/inventory/:id', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  await dbRemoveInventory(req.params.id);
  res.json({ ok: true });
});

// ── Watchlist endpoints ────────────────────────────────────────────────────────
// ── Merge stored price-baselines into watchlist items before returning ─────────
// The watchlist cron saves fetched prices in the settings table under
// 'watchlist_price_baselines' (keyed by watchlist row ID). The dashboard
// reads product_meta on each row — we merge them here so the price shows
// immediately instead of being stuck on "Pending" forever.
async function enrichWatchlistItems(items) {
  const baselines = (await getSetting('watchlist_price_baselines')) || {};
  return items.map(item => {
    const b = baselines[item.id];
    if (!b) return item;
    const sym = b.currency === 'GBP' ? '£' : (b.currency || '£');
    return {
      ...item,
      product_meta: {
        title:      b.productName || null,
        price:      b.baseline != null ? `${sym}${Number(b.baseline).toFixed(2)}` : null,
        lowestSeen: b.lowestSeen != null ? `${sym}${Number(b.lowestSeen).toFixed(2)}` : null,
        variants:   (b.variants || []).map(v => v.size).filter(Boolean),
        checked_at: b.checkedAt || null,
      },
    };
  });
}

// Return a decrypted, non-expired Vinted access token from ANY connected
// account. Used for read-only public item fetches (watchlist price tracking)
// where we just need a valid token to bypass DataDome via the proxy.
let _anyVintedTokenCache = { token: '', exp: 0 };
async function getAnyVintedToken() {
  if (_anyVintedTokenCache.token && _anyVintedTokenCache.exp > Math.floor(Date.now() / 1000) + 60) {
    return _anyVintedTokenCache.token;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/platform_connections?platform=eq.vinted&select=access_token`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    const rows = await r.json();
    if (!Array.isArray(rows)) return '';
    for (const row of rows) {
      const tok = decryptToken(row.access_token || '');
      if (!tok || tok.length < 20) continue;
      const parts = tok.split('.');
      if (parts.length !== 3) continue;
      try {
        const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (p.exp && p.exp > Math.floor(Date.now() / 1000) + 60) {
          _anyVintedTokenCache = { token: tok, exp: p.exp };
          return tok;
        }
      } catch {}
    }
  } catch (e) { console.warn('[getAnyVintedToken]', e.message); }
  return '';
}

// Fetch a Vinted item's current price/title via the item detail API, using a
// valid connected token + residential proxy. Returns { title, price, size } or null.
// IMPORTANT: items are domain-specific. A UK item only resolves on vinted.co.uk —
// it 404s on vinted.fr (which is where the proxy often geo-resolves to). So we use
// the item's OWN domain (from its URL) rather than the geo-detected base.
async function fetchVintedItemDirect(itemNumId, baseUrl = 'https://www.vinted.co.uk') {
  const tok = await getAnyVintedToken();
  if (!tok) return null;
  let base;
  try { base = new URL(baseUrl).origin; } catch { base = 'https://www.vinted.co.uk'; }
  try {
    const r = await vFetch(`${base}/api/v2/items/${itemNumId}`, {
      headers: VINTED_HEADERS(tok, base),
      signal:  AbortSignal.timeout(12000),
    });
    const text = await r.text();
    if (/datadome|captcha/i.test(text) || !r.ok) return null;
    let data; try { data = JSON.parse(text); } catch { return null; }
    const it = data?.item;
    if (!it) return null;
    const price = parseFloat(it.price_numeric ?? it.price?.amount ?? it.price ?? 0) || 0;
    return { title: it.title || '', price, size: it.size_title || '', currency: it.price?.currency_code || 'GBP' };
  } catch { return null; }
}

// ── Immediately fetch price for a newly added watchlist item ──────────────────
// Runs in the background after POST /api/watchlist so the item shows a real
// price right away without waiting up to 6 hours for the cron.
async function watchlistImmediateFetch(itemId, url) {
  try {
    const isVintedUrl = /vinted\.(co\.uk|fr|de|be|nl|es|it|pl|pt|se|at|lu|cz|sk|hu|ro|lt|lv|ee|fi|dk)\//i.test(url);
    if (!isVintedUrl) return; // only handle Vinted for now; other platforms use cron

    const idMatch = url.match(/\/items\/(\d+)/);
    if (!idMatch) return;
    const itemNumId = idMatch[1];

    // Primary: Apify actor ITEM_DETAIL mode (purpose-built, residential proxy).
    let item = await apifyVintedItemDetail(url);
    // Fallback: direct item-detail API with a connected token (Vinted often 404s this).
    if (!item || !item.price) {
      const d = await fetchVintedItemDirect(itemNumId, url);
      if (d && d.price) item = d;
    }
    // Last resort: legacy Apify proxy item fetch.
    if (!item || !item.price) {
      const ai = await apifyVintedFetchItem(url).catch(() => null);
      if (ai && parseFloat(ai.price || 0)) {
        item = { title: ai.title || '', price: parseFloat(ai.price), size: ai.size_title || '', currency: ai.currency || 'GBP' };
      }
    }
    if (!item || !item.price) {
      console.warn(`[watchlist-immediate] could not fetch price for ${url}`);
      return;
    }

    const baselines = (await getSetting('watchlist_price_baselines')) || {};
    baselines[itemId] = {
      productName: item.title || url,
      baseline:    item.price,
      lowestSeen:  item.price,
      variants:    item.size ? [{ size: item.size }] : [],
      currency:    item.currency || 'GBP',
      url,
      checkedAt:   new Date().toISOString(),
    };
    await saveSetting('watchlist_price_baselines', baselines);
    console.log(`[watchlist-immediate] ${item.title} @ £${item.price}`);
  } catch (e) {
    console.warn('[watchlist-immediate] Failed for', url, ':', e.message);
  }
}

app.get('/api/watchlist', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.basic) return res.status(403).json({ error: 'Subscription required.' });
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';
  const items = await dbGetWatchlist(discordId);
  const enriched = await enrichWatchlistItems(Array.isArray(items) ? items : []);
  res.json({ items: enriched });
});

app.post('/api/watchlist', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.basic) return res.status(403).json({ error: 'Subscription required.' });
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';
  const { item } = req.body || {};
  if (!item?.trim()) return res.status(400).json({ error: 'item required' });

  // dbAddWatchlist uses Prefer:return=representation — returns [{id,...}]
  const created = await dbAddWatchlist(discordId, item.trim());
  const newId = Array.isArray(created) ? created[0]?.id : created?.id;

  // Kick off immediate price fetch in background (don't await — fast response)
  if (newId && item.trim().startsWith('http')) {
    watchlistImmediateFetch(newId, item.trim()).catch(() => {});
  }

  const items = await dbGetWatchlist(discordId);
  const enriched = await enrichWatchlistItems(Array.isArray(items) ? items : []);
  res.json({ ok: true, items: enriched });
});

app.delete('/api/watchlist/:id', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'no key' });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/watchlist?id=eq.${req.params.id}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Vinted Alerts API (powers Auto-Buy dashboard) ────────────────────────────
app.get('/api/vinted-alerts', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';
  const profile = await getProfileByDiscordId(discordId);
  const tier    = profile?.tier || 'none';
  const max     = TIER_RANK[tier] >= 3 ? 30 : 5;
  const alerts  = await dbGetVintedAlerts(discordId);
  res.json({ alerts, max });
});

app.post('/api/vinted-alerts', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';
  const { keyword, max_price } = req.body || {};
  if (!keyword?.trim()) return res.status(400).json({ error: 'keyword required' });

  const profile = await getProfileByDiscordId(discordId);
  const tier    = profile?.tier || 'none';
  if (TIER_RANK[tier] < 2) return res.status(403).json({ error: 'Pro required' });

  const max      = TIER_RANK[tier] >= 3 ? 30 : 5;
  const existing = await dbGetVintedAlerts(discordId);
  if (existing.length >= max) return res.status(400).json({ error: `Alert limit reached (${max})` });

  // Baseline with Apify so only NEW items trigger alerts
  const initial  = APIFY_TOKEN ? await apifyVintedSearch(keyword.trim(), 20) : [];
  const seenIds  = (initial || []).map(i => i.id).filter(Boolean);

  await dbAddVintedAlert(discordId, keyword.trim(), max_price || null);
  const alerts  = await dbGetVintedAlerts(discordId);
  const newAlert = alerts.find(a => a.keyword === keyword.trim() && (!a.seen_ids?.length));
  if (newAlert) await dbUpdateVintedAlertSeenIds(newAlert.id, seenIds);

  res.json({ ok: true, baselined: seenIds.length, alerts });
});

app.delete('/api/vinted-alerts/:id', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  await dbRemoveVintedAlert(req.params.id);
  res.json({ ok: true });
});

// ── Support ticket ─────────────────────────────────────────────────────────────
app.post('/api/support/ticket', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { message, subject } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || 'unknown';
  const username = user.user_metadata?.full_name || user.user_metadata?.name || 'Unknown';

  // Check if user is banned
  const profile = await getProfileByDiscordId(discordId);
  if (profile?.is_banned) {
    return res.status(403).json({ error: 'Your account has been suspended from submitting support tickets.' });
  }

  // Check strike count
  const strikes = profile?.spam_strikes || 0;

  try {
    const owner = await client.users.fetch(OWNER_ID);
    const ticketId = Date.now().toString(36);

    // Cache ticket data so the Open Ticket button can retrieve it
    ticketStore.set(ticketId, { discordId, username, message: message.slice(0, 1800), subject: subject || 'General enquiry', createdAt: Date.now() });

    const openBtn = new ButtonBuilder()
      .setCustomId(`open_ticket_${discordId}_${ticketId}`)
      .setLabel('🎫 Open Ticket')
      .setStyle(ButtonStyle.Primary);

    const spamBtn = new ButtonBuilder()
      .setCustomId(`spam_${discordId}_${ticketId}`)
      .setLabel(`⚑ Mark as Spam (${strikes}/3 strikes)`)
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(openBtn, spamBtn);

    await owner.send({
      embeds: [new EmbedBuilder()
        .setColor('#e8217a')
        .setTitle('📩 Support Message')
        .addFields(
          { name: 'From', value: `${username} (\`${discordId}\`)`, inline: true },
          { name: 'Subject', value: subject || 'General enquiry', inline: true },
          { name: 'Strikes', value: `${strikes}/3`, inline: true },
          { name: 'Message', value: message.slice(0, 1024) },
        )
        .setFooter({ text: `Ticket ID: ${ticketId}` })
        .setTimestamp()
      ],
      components: [row],
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[support] Failed to DM owner:', e.message);
    res.status(500).json({ error: 'Could not send ticket. Please DM pluniez directly on Discord.' });
  }
});

// ── Shared: find the support text channel reliably ───────────────────────────
function findSupportChannel(guild) {
  if (!guild) return null;
  // Prefer exact ❓｜support name first, then any GuildText channel with "support" in it
  return (
    guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === '❓｜support') ||
    guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name.toLowerCase().includes('support'))
  );
}

// ── Ticket: owner opens thread from DM button ─────────────────────────────────
async function handleOpenTicketButton(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: 'Only the owner can open tickets from here.', ephemeral: true });
  }
  await interaction.deferUpdate();

  const parts          = interaction.customId.split('_'); // open_ticket_<discordId>_<ticketId>
  const targetDiscordId = parts[2];
  const ticketId        = parts[3];
  if (!targetDiscordId) return;

  const data     = ticketStore.get(ticketId) || {};
  const username = data.username || 'user';
  const message  = data.message  || '*(message not cached — see original DM)*';
  const subject  = data.subject  || 'General enquiry';

  const guild = client.guilds.cache.first();
  if (!guild) return;

  const supportChannel = findSupportChannel(guild);
  if (!supportChannel) {
    return interaction.editReply({ content: '⚠️ Could not find a support channel.', components: [] });
  }

  const threadName = `ticket-${username.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}-${ticketId}`;

  let thread;
  try {
    thread = await supportChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      type: ChannelType.PrivateThread,
      reason: `Support ticket for ${username} (${targetDiscordId})`,
    });
  } catch {
    thread = await supportChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      reason: `Support ticket for ${username} (${targetDiscordId})`,
    });
  }

  try { await thread.members.add(targetDiscordId); } catch { /* user left guild */ }
  try { await thread.members.add(OWNER_ID); }        catch { /* owner already in */ }

  await thread.send({
    content: `<@${targetDiscordId}> <@${OWNER_ID}>`,
    embeds: [new EmbedBuilder()
      .setColor('#e8217a')
      .setTitle('🎫 Support Ticket Opened')
      .addFields(
        { name: 'User',      value: `<@${targetDiscordId}> (\`${targetDiscordId}\`)`, inline: true },
        { name: 'Subject',   value: subject,                                          inline: true },
        { name: 'Ticket ID', value: `\`${ticketId}\``,                               inline: true },
        { name: 'Original Message', value: message.slice(0, 1024) },
      )
      .setFooter({ text: 'Closes after 24h of inactivity  •  /ticket close to close manually' })
      .setTimestamp()
    ],
  });

  // DM the user with the thread link
  try {
    const targetUser = await client.users.fetch(targetDiscordId);
    await targetUser.send({ embeds: [new EmbedBuilder()
      .setColor('#e8217a')
      .setTitle('🎫 Your Support Ticket Has Been Opened')
      .setDescription(
        `The Vendora team has opened a ticket for your message.\n\n` +
        `**[Click here to view your ticket](${thread.url})**\n\n` +
        `Reply in the thread and we'll get back to you. The ticket closes automatically after **24 hours of inactivity**.`
      )
      .addFields({ name: 'Subject', value: subject, inline: true })
      .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
    ]});
  } catch { /* DMs closed */ }

  // Update the owner DM buttons to show ticket opened
  const openedBtn = new ButtonBuilder()
    .setCustomId(`ticket_opened_${ticketId}`)
    .setLabel(`✓ Ticket Opened`)
    .setStyle(ButtonStyle.Success)
    .setDisabled(true);
  const spamBtn = new ButtonBuilder()
    .setCustomId(`spam_${targetDiscordId}_${ticketId}`)
    .setLabel('⚑ Mark as Spam')
    .setStyle(ButtonStyle.Danger);
  await interaction.editReply({ components: [new ActionRowBuilder().addComponents(openedBtn, spamBtn)] });
}

// ── Ticket: user clicks Open Ticket from support channel embed ─────────────────
async function handleTicketDirectButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket_modal_${interaction.user.id}_${Date.now().toString(36)}`)
    .setTitle('Open a Support Ticket');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ticket_subject')
        .setLabel('What is this about?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Role not assigned after payment')
        .setRequired(true)
        .setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ticket_message')
        .setLabel('Describe your issue')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Please include as much detail as possible…')
        .setRequired(true)
        .setMaxLength(1000)
    ),
  );
  await interaction.showModal(modal);
}

// ── Ticket: modal submitted from support channel embed ─────────────────────────
async function handleTicketModalSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const discordId = interaction.user.id;
  const username  = interaction.user.username;
  const subject   = interaction.fields.getTextInputValue('ticket_subject');
  const message   = interaction.fields.getTextInputValue('ticket_message');
  const ticketId  = Date.now().toString(36);

  const profile = await getProfileByDiscordId(discordId);
  if (profile?.is_banned) {
    return interaction.editReply({ content: '⛔ Your support access has been suspended.' });
  }
  const strikes = profile?.spam_strikes || 0;

  const guild = interaction.guild;
  const supportChannel = findSupportChannel(guild);
  if (!supportChannel) {
    return interaction.editReply({ content: '⚠️ Support channel not found. Please DM the server owner directly.' });
  }

  const threadName = `ticket-${username.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}-${ticketId}`;
  let thread;
  try {
    thread = await supportChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      type: ChannelType.PrivateThread,
      reason: `Support ticket from ${username} (${discordId})`,
    });
  } catch {
    thread = await supportChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      reason: `Support ticket from ${username} (${discordId})`,
    });
  }

  try { await thread.members.add(discordId); } catch { /* guild issues */ }
  try { await thread.members.add(OWNER_ID); }  catch { /* already in */ }

  await thread.send({
    content: `<@${discordId}> <@${OWNER_ID}>`,
    embeds: [new EmbedBuilder()
      .setColor('#e8217a')
      .setTitle('🎫 Support Ticket Opened')
      .addFields(
        { name: 'User',      value: `<@${discordId}> (\`${discordId}\`)`, inline: true },
        { name: 'Subject',   value: subject,                               inline: true },
        { name: 'Ticket ID', value: `\`${ticketId}\``,                    inline: true },
        { name: 'Message',   value: message.slice(0, 1024) },
      )
      .setFooter({ text: 'Closes after 24h of inactivity  •  /ticket close to close manually' })
      .setTimestamp()
    ],
  });

  // Notify owner by DM
  try {
    const owner = await client.users.fetch(OWNER_ID);
    const spamBtn = new ButtonBuilder()
      .setCustomId(`spam_${discordId}_${ticketId}`)
      .setLabel(`⚑ Mark as Spam (${strikes}/3)`)
      .setStyle(ButtonStyle.Danger);
    await owner.send({
      embeds: [new EmbedBuilder()
        .setColor('#e8217a')
        .setTitle('📩 New Support Ticket (via server)')
        .addFields(
          { name: 'From',    value: `${username} (\`${discordId}\`)`, inline: true },
          { name: 'Subject', value: subject,                           inline: true },
          { name: 'Thread',  value: `[View ticket](${thread.url})`,   inline: true },
          { name: 'Message', value: message.slice(0, 1024) },
        )
        .setFooter({ text: `Ticket ID: ${ticketId}` })
        .setTimestamp()
      ],
      components: [new ActionRowBuilder().addComponents(spamBtn)],
    });
  } catch { /* DMs closed */ }

  ticketStore.set(ticketId, { discordId, username, message, subject, createdAt: Date.now() });

  return interaction.editReply({
    content: `✅ **Ticket opened!** [Click here to go to your ticket](${thread.url})\n\nThe support team has been notified and will respond shortly. Your ticket closes automatically after 24 hours of inactivity.`,
  });
}

// ── Spam strike handler (button interactions) ─────────────────────────────────
async function handleSpamButton(interaction) {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('spam_')) return;
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: 'Only the owner can mark tickets as spam.', ephemeral: true });
  }

  await interaction.deferUpdate();

  const parts = interaction.customId.split('_'); // spam_<discordId>_<ticketId>
  const targetDiscordId = parts[1];

  if (!targetDiscordId || targetDiscordId === 'undefined') {
    return interaction.editReply({ content: '⚠️ Could not identify the user for this ticket.' });
  }

  // Increment strikes in Supabase
  const profile = await getProfileByDiscordId(targetDiscordId);
  const currentStrikes = (profile?.spam_strikes || 0) + 1;
  const isBanned = currentStrikes >= 3;

  await updateProfile('discord_id', targetDiscordId, {
    spam_strikes: currentStrikes,
    is_banned: isBanned,
  });

  // Update the message
  const label = isBanned
    ? `🚫 User Banned (3/3 strikes reached)`
    : `✓ Spam Marked — ${currentStrikes}/3 strikes`;

  const disabledBtn = new ButtonBuilder()
    .setCustomId(`spam_done_${targetDiscordId}`)
    .setLabel(label)
    .setStyle(isBanned ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(true);

  await interaction.editReply({ components: [new ActionRowBuilder().addComponents(disabledBtn)] });

  // DM the user to warn/ban them
  try {
    const targetUser = await client.users.fetch(targetDiscordId);
    if (isBanned) {
      await targetUser.send({
        embeds: [new EmbedBuilder().setColor('#f87171')
          .setTitle('⛔ Account Suspended — Vendora Support')
          .setDescription(
            'Your Vendora support access has been **permanently suspended** after 3 spam violations.\n\n' +
            'Your account remains active for the Vendora tools, but you can no longer submit support tickets.\n\n' +
            'If you believe this is a mistake, contact the server admins directly.'
          )
          .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
        ]
      });
      console.log(`[support] User ${targetDiscordId} banned after 3 spam strikes`);
    } else {
      await targetUser.send({
        embeds: [new EmbedBuilder().setColor('#e8a121')
          .setTitle('⚠️ Support Warning — Vendora')
          .setDescription(
            `A message you sent to Vendora support has been marked as spam.\n\n` +
            `**Strike ${currentStrikes} of 3.** After 3 strikes your support access will be permanently suspended.\n\n` +
            `Please only use the support form for genuine issues.`
          )
          .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
        ]
      });
    }
  } catch { /* DMs closed */ }
}

// ── Notification preferences ───────────────────────────────────────────────────
app.get('/api/notifications', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  if (!SUPABASE_KEY) return res.json({ prefs: {} });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=notification_prefs`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await r.json();
    res.json({ prefs: rows[0]?.notification_prefs || {} });
  } catch { res.json({ prefs: {} }); }
});

app.post('/api/notifications', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { prefs } = req.body || {};
  if (!prefs) return res.status(400).json({ error: 'prefs required' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'no key' });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ notification_prefs: prefs }),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Owner-only middleware ─────────────────────────────────────────────────────
async function requireOwner(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id;
  if (discordId !== OWNER_ID) { res.status(403).json({ error: 'Owner only' }); return null; }
  return user;
}

// ── Discord channels — returns all text channels grouped by category ──────────
app.get('/api/discord/channels', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch(); // ensure cache is populated
    const channels = guild.channels.cache
      .filter(c => c.type === ChannelType.GuildText)
      .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0))
      .map(c => ({
        id:       c.id,
        name:     c.name,
        category: c.parent?.name || 'Uncategorised',
      }));
    return res.json({ ok: true, channels });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Admin: post support channel embed ────────────────────────────────────────
app.post('/api/admin/post-support-embed', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const guild = client.guilds.cache.first();
  if (!guild) return res.status(500).json({ error: 'Bot not in any guild' });

  const supportChannel = findSupportChannel(guild);
  if (!supportChannel) return res.status(404).json({ error: 'Could not find a support channel' });

  const openBtn = new ButtonBuilder()
    .setCustomId('ticket_open_direct')
    .setLabel('🎫 Open a Ticket')
    .setStyle(ButtonStyle.Primary);

  await supportChannel.send({
    embeds: [new EmbedBuilder()
      .setColor('#e8217a')
      .setTitle('Vendora Support')
      .setDescription(
        'Need help with your subscription, role, or anything else?\n\n' +
        'Click the button below to open a **private support ticket**. ' +
        'Only you and the Vendora team will be able to see it.\n\n' +
        '**Typical response time:** within a few hours.'
      )
      .addFields({
        name: '📋 Before opening a ticket',
        value:
          '• Check your role assigned correctly after payment\n' +
          '• Try `/help` to see all available commands\n' +
          '• Make sure your issue hasn\'t already been addressed in announcements',
      })
      .setFooter({ text: 'Vendora — The Reseller\'s Edge  •  Tickets close after 24h of inactivity' })
      .setTimestamp()
    ],
    components: [new ActionRowBuilder().addComponents(openBtn)],
  });

  res.json({ ok: true });
});

// ── Admin: get bot config ─────────────────────────────────────────────────────
app.get('/api/admin/config', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const rateLimits = await getSetting('rate_limits') || {};
  const toggles    = await getSetting('bot_toggles')  || BOT_TOGGLES;
  res.json({ rate_limits: rateLimits, toggles });
});

// ── Admin: save bot config ────────────────────────────────────────────────────
app.post('/api/admin/config', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const { rate_limits, toggles } = req.body || {};

  if (rate_limits && typeof rate_limits === 'object') {
    // Merge into live RATE_LIMITS
    for (const [group, limits] of Object.entries(rate_limits)) {
      if (RATE_LIMITS[group]) Object.assign(RATE_LIMITS[group], limits);
    }
    await saveSetting('rate_limits', rate_limits);
  }

  if (toggles && typeof toggles === 'object') {
    Object.assign(BOT_TOGGLES, toggles);
    await saveSetting('bot_toggles', toggles);
  }

  console.log('[admin] Config updated');
  res.json({ ok: true });
});

// ── Admin: DM blast ───────────────────────────────────────────────────────────
app.post('/api/admin/announce/dm', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const { message, target } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  // Fetch discord IDs from Supabase profiles
  let query = `${SUPABASE_URL}/rest/v1/profiles?select=discord_id,tier&subscription_status=eq.active`;
  if (target && target !== 'all') {
    if (target === 'pro_elite') {
      query += `&or=(tier.eq.pro,tier.eq.elite)`;
    } else {
      query += `&tier=eq.${target}`;
    }
  }

  let profiles = [];
  try {
    const r = await fetch(query, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    profiles = await r.json();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch profiles' });
  }

  let sent = 0, failed = 0;
  for (const p of profiles) {
    if (!p.discord_id) continue;
    try {
      const member = await client.users.fetch(p.discord_id);
      await member.send(message);
      sent++;
    } catch { failed++; }
  }

  console.log(`[admin] DM blast — sent: ${sent}, failed: ${failed}`);
  res.json({ ok: true, sent, failed, total: profiles.length });
});

// ── Admin: post to channel ────────────────────────────────────────────────────
app.post('/api/admin/announce/channel', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const { message, channel_id, channel_name } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();

    let channel;
    if (channel_id) {
      // Prefer ID-based lookup — reliable even if channel is renamed
      channel = guild.channels.cache.get(channel_id);
    } else {
      // Fallback: name-based lookup
      const targetName = (channel_name || 'use-vendora').replace(/^#/, '');
      channel = guild.channels.cache.find(c => c.name === targetName && c.type === ChannelType.GuildText);
    }

    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    await channel.send(message);
    res.json({ ok: true, channel: channel.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cross-Country Arbitrage Finder (credit-powered) ──────────────────────────
// Uses the Vinted scraper's CROSS_COUNTRY mode to compare the same item across
// EU markets, converts everything to GBP, and surfaces where it's cheapest to
// buy vs the UK resale price.
const ARBITRAGE_CREDIT_COST = 60;
const ARBITRAGE_COUNTRIES   = ['uk', 'fr', 'de', 'es', 'it'];
const COUNTRY_NAMES = { uk: '🇬🇧 UK', fr: '🇫🇷 France', de: '🇩🇪 Germany', es: '🇪🇸 Spain', it: '🇮🇹 Italy', nl: '🇳🇱 Netherlands', pl: '🇵🇱 Poland', be: '🇧🇪 Belgium' };

// GBP per 1 unit of currency. Live (open.er-api.com, no key) with 12h cache + fallback.
let _fxCache = { at: 0, rates: null };
async function getGbpRates() {
  if (_fxCache.rates && Date.now() - _fxCache.at < 12 * 3600 * 1000) return _fxCache.rates;
  const fallback = { GBP: 1, EUR: 0.85, PLN: 0.20, USD: 0.79, SEK: 0.075, DKK: 0.114, CZK: 0.034, RON: 0.17, HUF: 0.0022 };
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/GBP', { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d?.rates) {
      const rates = { GBP: 1 };
      for (const [cur, perGbp] of Object.entries(d.rates)) if (perGbp > 0) rates[cur] = 1 / perGbp;
      _fxCache = { at: Date.now(), rates };
      return rates;
    }
  } catch {}
  return fallback;
}

app.post('/api/arbitrage', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.basic) return res.status(403).json({ error: 'Subscription required.' });
  if (!APIFY_TOKEN) return res.status(503).json({ error: 'Scraper not configured.' });

  const query = String(req.body?.query || '').trim();
  if (query.length < 2) return res.status(400).json({ error: 'Enter a product to search (e.g. "nike air max 90").' });
  let countries = Array.isArray(req.body?.countries) && req.body.countries.length ? req.body.countries : ARBITRAGE_COUNTRIES;
  countries = countries.filter(c => COUNTRY_NAMES[c]).slice(0, 6);
  if (!countries.includes('uk')) countries.unshift('uk'); // always need UK as the resale benchmark

  // Check balance up front (don't deduct until we have results).
  const balance = await getCredits(user.id);
  if (balance < ARBITRAGE_CREDIT_COST) {
    return res.status(402).json({ error: `This scan costs ${ARBITRAGE_CREDIT_COST} credits — you have ${balance}.`, balance, cost: ARBITRAGE_CREDIT_COST });
  }

  let items;
  try {
    items = await apifyRunVinted({ mode: 'CROSS_COUNTRY', query, countries, maxItems: 48, includePhotos: false }, 120);
  } catch (e) {
    return res.status(502).json({ error: `Scan failed: ${e.message}` });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(404).json({ error: 'No live listings found for that search across those markets. Try a broader or differently-worded query.' });
  }

  // Charge only now that we have results.
  let creditsLeft;
  try { creditsLeft = await deductCredits(user.id, ARBITRAGE_CREDIT_COST); }
  catch (e) { return res.status(402).json({ error: e.message, balance: e.balance }); }

  const rates = await getGbpRates();
  const toGbp = (price, cur) => (parseFloat(price) || 0) * (rates[(cur || 'GBP').toUpperCase()] || 1);

  // Group by country
  const byCountry = {};
  for (const it of items) {
    if (it.isSold) continue;
    const c = (it.country || '').toLowerCase();
    if (!COUNTRY_NAMES[c]) continue;
    const gbp = toGbp(it.price, it.currency);
    if (!gbp) continue;
    (byCountry[c] = byCountry[c] || []).push({
      title: it.title || '', url: it.url || '', size: it.size || '',
      price: parseFloat(it.price) || 0, currency: (it.currency || 'GBP').toUpperCase(), gbp,
    });
  }

  const median = arr => { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  const countriesOut = Object.entries(byCountry).map(([c, list]) => {
    list.sort((a, b) => a.gbp - b.gbp);
    return {
      country: c, name: COUNTRY_NAMES[c], count: list.length,
      cheapest: list[0], median_gbp: Math.round(median(list.map(i => i.gbp))),
    };
  });

  // UK resale benchmark = median UK price (fallback: overall median)
  const ukList = byCountry.uk || [];
  const allGbp = items.map(i => toGbp(i.price, i.currency)).filter(Boolean);
  const ukBenchmark = ukList.length ? Math.round(median(ukList.map(i => i.gbp))) : Math.round(median(allGbp));

  // Opportunities: non-UK cheapest vs UK benchmark
  const opportunities = countriesOut
    .filter(c => c.country !== 'uk' && c.cheapest)
    .map(c => {
      const buy = c.cheapest.gbp;
      const grossMargin = ukBenchmark - buy;
      return {
        ...c,
        buy_gbp: Math.round(buy),
        uk_resale_gbp: ukBenchmark,
        gross_margin_gbp: Math.round(grossMargin),
        margin_pct: buy > 0 ? Math.round((grossMargin / buy) * 100) : 0,
      };
    })
    .sort((a, b) => b.gross_margin_gbp - a.gross_margin_gbp);

  res.json({
    ok: true,
    query,
    credits_left: creditsLeft,
    cost: ARBITRAGE_CREDIT_COST,
    uk_benchmark_gbp: ukBenchmark,
    countries: countriesOut.sort((a, b) => (a.cheapest?.gbp || 1e9) - (b.cheapest?.gbp || 1e9)),
    opportunities,
    scanned: items.length,
  });
});

// POST /api/admin/post-promo — service-key-gated. Posts the Vendora promo embed
// (with a "Buy here" link button) to a Discord channel. Defaults to the promo channel.
app.post('/api/admin/post-promo', async (req, res) => {
  const key = req.headers['x-debug-key'] || req.query.key;
  if (!SUPABASE_KEY || key !== SUPABASE_KEY) return res.status(403).json({ error: 'forbidden' });
  const channelId = String(req.query.channel || '1510201320018018364');
  const PRICING = 'https://vendora.site/#pricing';
  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') {
      return res.status(404).json({ error: `Channel ${channelId} not found or not text-postable` });
    }

    const embed = new EmbedBuilder()
      .setColor('#e8217a')
      .setTitle('⚡ Vendora — The Reseller\'s Edge')
      .setThumbnail('https://vendora.site/favicon.png')
      .setDescription(
        'Vendora is the all-in-one toolkit for Vinted resellers — built right into Vendor Village.\n\n' +
        '**Stop guessing. Start flipping smarter.** Vendora does the grind for you: it watches Vinted for underpriced listings and DMs you the moment a deal drops, writes & optimises your listings with AI, syncs your live inventory and real profit, and tells you what to restock before the market moves.'
      )
      .addFields(
        { name: '🔎 Find & win deals', value: 'Auto-Buy keyword alerts ping you on Discord the instant a matching listing appears — **Elite scans every 5 minutes.**' },
        { name: '🤖 List smarter', value: 'AI Listing Optimiser, Auto-Draft copywriting, and one-tap Photo Enhancer so every listing converts.' },
        { name: '📦 Run your shop', value: 'Live inventory sync, automatic profit tracking, price-drop watchlist, and a resell calendar of upcoming drops.' },
        { name: '💷 Plans', value: '**Basic** £9.99  ·  **Pro** £24.99  ·  **Elite** £49.99 / month — annual saves ~2 months.' },
        { name: '​', value: `**→ [Buy here](${PRICING})** and get your edge today.` },
      )
      .setFooter({ text: 'Vendora — The Reseller\'s Edge' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🛒 Buy here').setURL(PRICING),
    );

    const sent = await channel.send({ embeds: [embed], components: [row] });
    console.log(`[promo] Posted Vendora promo to #${channel.name} (${channelId})`);
    res.json({ ok: true, channel: channel.name, message_id: sent.id });
  } catch (e) {
    console.error('[promo] post failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/announcement — public, returns active site banner or null
app.get('/api/announcement', async (req, res) => {
  try {
    const data = await getSetting('site_announcement');
    if (!data || !data.message) return res.json({ active: false });
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.json({ active: false });
    }
    res.json({ active: true, message: data.message, created_at: data.created_at, expires_at: data.expires_at });
  } catch (e) { res.json({ active: false }); }
});

// POST /api/admin/announcement — owner only, set site banner
app.post('/api/admin/announcement', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const { message, duration_hours } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required.' });
  const hours = parseFloat(duration_hours) || 0;
  const expires_at = hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : null;
  await saveSetting('site_announcement', { message: message.trim(), created_at: new Date().toISOString(), expires_at });
  res.json({ ok: true, expires_at });
});

// DELETE /api/admin/announcement — owner only, remove site banner
app.delete('/api/admin/announcement', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  await saveSetting('site_announcement', { message: null });
  res.json({ ok: true });
});

// ── Version staging endpoints ─────────────────────────────────────────────────

app.get('/api/version', async (req, res) => {
  try {
    const live = (await getSetting('app_version_live')) || { version: '6.0', short: 'v6.0', builtAt: '2026-05-14' };
    // Check if requester is the owner
    let isOwner = false;
    try {
      const token = req.headers['authorization']?.replace('Bearer ', '');
      if (token) {
        const user = await verifySupabaseToken(token);
        if (user) {
          const discordId = user.user_metadata?.provider_id
            || user.identities?.find(i => i.provider === 'discord')?.id;
          if (discordId === OWNER_ID) isOwner = true;
        }
      }
    } catch {}
    if (isOwner) {
      const staged = await getSetting('app_version_staged');
      if (staged) return res.json({ ...staged, staged: true, liveVersion: live.version });
    }
    res.json(live);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/version/publish', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const staged = await getSetting('app_version_staged');
  if (!staged) return res.status(400).json({ error: 'No staged version to publish' });
  const live = await getSetting('app_version_live');
  if (live) await saveSetting('app_version_previous', live);
  await saveSetting('app_version_live', staged);
  await saveSetting('app_version_staged', null);

  // Auto-add to changelog entries in Supabase
  try {
    const entry = {
      version:     staged.version,
      title:       staged.title || staged.notes || 'Update',
      changes:     staged.changes || (staged.notes ? [staged.notes] : []),
      publishedAt: new Date().toISOString(),
    };
    const existing = (await getSetting('app_changelog_entries')) || [];
    await saveSetting('app_changelog_entries', [entry, ...existing]);
  } catch(e) { console.warn('[version] changelog save failed:', e.message); }

  console.log(`[version] Published v${staged.version}`);
  res.json({ ok: true, version: staged.version });
});

app.post('/api/admin/version/revert', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  // Revert: discard staged OR roll back live to previous
  const staged = await getSetting('app_version_staged');
  if (staged) {
    await saveSetting('app_version_staged', null);
    console.log(`[version] Reverted staged v${staged.version}`);
    return res.json({ ok: true, action: 'staged_discarded', version: (await getSetting('app_version_live'))?.version });
  }
  const previous = await getSetting('app_version_previous');
  if (!previous) return res.status(400).json({ error: 'No previous version to revert to' });
  await saveSetting('app_version_live', previous);
  await saveSetting('app_version_previous', null);
  console.log(`[version] Rolled back to v${previous.version}`);
  res.json({ ok: true, action: 'rolled_back', version: previous.version });
});

app.post('/api/admin/version/stage', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const { version, notes, title, changes } = req.body || {};
  if (!version) return res.status(400).json({ error: 'version required' });
  const entry = {
    version:  String(version),
    title:    title || notes || '',
    notes:    notes || title || '',
    changes:  Array.isArray(changes) ? changes : [],
    stagedAt: new Date().toISOString(),
  };
  await saveSetting('app_version_staged', entry);
  console.log(`[version] Staged v${version}`);
  res.json({ ok: true, version });
});

app.get('/api/admin/version/changelog-entries', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const entries = (await getSetting('app_changelog_entries')) || [];
  res.json({ ok: true, entries });
});

// ── Admin: update pricing (stored in Supabase; PayPal plans are separate) ─────
app.post('/api/admin/pricing', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const { pricing } = req.body || {};
  if (!pricing) return res.status(400).json({ error: 'pricing object required' });
  await saveSetting('pricing', pricing);
  console.log('[admin] Pricing updated:', pricing);
  res.json({ ok: true });
});

app.get('/api/admin/pricing', async (req, res) => {
  if (!await requireOwner(req, res)) return;
  const pricing = await getSetting('pricing') || {
    basic:  { monthly: 9.99,  annual: 99.99  },
    pro:    { monthly: 24.99, annual: 249.99 },
    elite:  { monthly: 49.99, annual: 499.99 },
  };
  res.json({ pricing });
});

// ── Auto-relist cron job — runs every hour ────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  console.log('[cron] Checking for due relists...');
  const due = await getDueRelists();
  if (!due.length) { console.log('[cron] No relists due.'); return; }

  for (const listing of due) {
    console.log(`[cron] Relisting ${listing.id} — ${listing.title}`);
    const ids = listing.platform_listing_ids || {};
    const newIds = {};

    for (const p of listing.platforms || []) {
      if (ids[p]) await deleteFromPlatform(listing.user_id, p, ids[p]);
      const r = await postToPlatform(listing.user_id, p, {
        title: listing.title, description: listing.description,
        price: listing.price, condition: listing.condition,
      });
      if (r.ok && r.listing_id) newIds[p] = r.listing_id;
      console.log(`[cron] ${p} relist → ${r.ok ? r.listing_id : r.error}`);
    }

    const nextRelistAt = new Date(Date.now() + (listing.relist_interval_days || 7) * 86400000).toISOString();
    await updateListingRecord(listing.id, { platform_listing_ids: newIds, next_relist_at: nextRelistAt });
  }

  console.log(`[cron] Processed ${due.length} relist(s).`);
});

// ── Vinted inventory + sales sync cron — runs every 6 hours ─────────────────
// For every connected Vinted user, pulls live listings via Playwright browser
// (DataDome already solved) and diffs against the last snapshot.
// Items that vanish from the live feed are recorded as sales.
// Map a list of profile UUIDs → their active subscription tier in one query.
async function getTiersForUserIds(userIds) {
  const map = {};
  if (!SUPABASE_KEY || !userIds.length) return map;
  try {
    const list = userIds.map(encodeURIComponent).join(',');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=in.(${list})&select=id,tier,subscription_status`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    const rows = await r.json();
    if (Array.isArray(rows)) for (const p of rows) {
      map[p.id] = (p.subscription_status === 'active') ? (p.tier || 'none') : 'none';
    }
  } catch (e) { console.warn('[getTiersForUserIds]', e.message); }
  return map;
}

// Inventory + sales sync. allowedTiers=null → every connected user (6-hourly
// baseline). allowedTiers=['elite'] → Elite only (hourly — faster sync perk).
async function runVintedInventorySync(allowedTiers, label) {
  if (!SUPABASE_KEY) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/platform_connections?platform=eq.vinted&select=user_id,platform_user_id,platform_username`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const conns = await r.json();
    if (!Array.isArray(conns)) return;
    let pool = conns.filter(c => c.platform_user_id);
    if (allowedTiers) {
      const tierMap = await getTiersForUserIds([...new Set(pool.map(c => c.user_id))]);
      pool = pool.filter(c => allowedTiers.includes(tierMap[c.user_id]));
    }
    if (!pool.length) return;
    let synced = 0, sales = 0;
    for (const c of pool) {
      try {
        const out = await syncVintedInventoryForUser(c.user_id);
        if (out.ok) { synced++; sales += out.sold_now || 0; }
      } catch (e) {
        console.warn(`[cron:vinted-sync:${label}] failed for ${c.platform_username}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1500)); // spread Apify/proxy load
    }
    console.log(`[cron:vinted-sync:${label}] Synced ${synced}/${pool.length}, ${sales} new sale(s).`);
  } catch (e) {
    console.error(`[cron:vinted-sync:${label}] Fatal:`, e.message);
  }
}

// Everyone every 6h; Elite additionally every hour (faster inventory + profit).
cron.schedule('17 */6 * * *', () => runVintedInventorySync(null, 'all'));
cron.schedule('37 * * * *',   () => runVintedInventorySync(['elite'], 'elite'));

// ── Price drop watchlist cron — runs every 6 hours ───────────────────────────
// Checks live Depop + Vinted prices for all watched items, DMs users when a
// significant drop is detected (≥10% below their stored baseline).
async function runWatchlistCheck(allowedTiers, label) {
  if (!SUPABASE_KEY) return;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/watchlist?select=*&order=added_at.asc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    let items = await r.json();
    if (!Array.isArray(items) || !items.length) return;
    if (allowedTiers) {
      const tierMap = await getTiersForDiscordIds([...new Set(items.map(w => w.discord_id))]);
      items = items.filter(w => allowedTiers.includes(tierMap[w.discord_id]));
    }
    if (!items.length) return;

    // Load price baselines from settings table (keyed by watchlist item id)
    const baselineKey = 'watchlist_price_baselines';
    let baselines = (await getSetting(baselineKey)) || {};

    let alertCount = 0, checkedCount = 0;

    for (const wl of items) {
      try {
        const isUrl    = wl.item?.startsWith('http');
        const stored   = baselines[wl.id];
        const displayName = stored?.productName || wl.item;

        let currentLow, currentAvg, dropVariants = [], currency = 'GBP';

        if (isUrl) {
          const isVintedUrl = /vinted\.(co\.uk|fr|de|be|nl|es|it|pl|pt|se|at|lu|cz|sk|hu|ro|lt|lv|ee|fi|dk)\//i.test(wl.item);

          if (isVintedUrl) {
            // ── Vinted URL: item detail API with connected token + proxy ──────
            const idM = wl.item.match(/\/items\/(\d+)/);
            let vintedItem = await apifyVintedItemDetail(wl.item);
            if ((!vintedItem || !vintedItem.price) && idM) {
              const d = await fetchVintedItemDirect(idM[1], wl.item);
              if (d && d.price) vintedItem = d;
            }
            if (!vintedItem || !vintedItem.price) {
              const ai = await apifyVintedFetchItem(wl.item).catch(() => null);
              if (ai && parseFloat(ai.price || 0)) vintedItem = { title: ai.title, price: parseFloat(ai.price), size: ai.size_title, currency: ai.currency || 'GBP' };
            }
            if (!vintedItem) {
              console.warn(`[cron:watchlist] Vinted fetch failed for ${wl.item}`);
              continue;
            }
            checkedCount++;
            const price = parseFloat(vintedItem.price || '0');
            if (!price) continue;
            currentLow = price;
            currentAvg = price;
            currency   = vintedItem.currency || 'GBP';
            const vintedName     = vintedItem.title || wl.item;
            const vintedVariants = [{ size: vintedItem.size || vintedItem.size_title || null, price }];

            if (!stored) {
              baselines[wl.id] = { platform: 'vinted', productName: vintedName, baseline: price, lowestSeen: price, variants: vintedVariants, currency, url: wl.item, checkedAt: new Date().toISOString() };
              console.log(`[cron:watchlist] Baselined Vinted "${vintedName}" at ${currency} ${price.toFixed(2)}`);
              continue;
            }

            const vintedBaseline = stored.baseline || price;
            const vintedPct = ((vintedBaseline - price) / vintedBaseline) * 100;
            if (vintedPct >= 10) dropVariants.push({ size: vintedItem.size_title || null, price, baseline: vintedBaseline, pct: vintedPct });
            baselines[wl.id] = { ...stored, productName: vintedName, lowestSeen: Math.min(price, stored.lowestSeen || price), variants: vintedVariants, checkedAt: new Date().toISOString() };

          } else {
            // ── Other URL: scrape the product page ────────────────────────────
            let product;
            try { product = await scrapeProductPage(wl.item); }
            catch (e) {
              console.warn(`[cron:watchlist] Scrape failed for ${wl.item}: ${e.message}`);
              continue;
            }
            if (!product?.variants?.length) continue;
            checkedCount++;

            currentLow = product.lowestPrice;
            currentAvg = product.variants.reduce((s, v) => s + v.price, 0) / product.variants.length;
            currency   = product.currency || 'GBP';

            if (!stored) {
              baselines[wl.id] = { platform: stored?.platform, productName: product.name, baseline: currentAvg, lowestSeen: currentLow, variants: product.variants, currency, url: wl.item, checkedAt: new Date().toISOString() };
              console.log(`[cron:watchlist] Baselined URL "${product.name}" at £${currentLow.toFixed(2)}`);
              continue;
            }

            for (const v of product.variants) {
              const baseline = (stored.variants || []).find(sv => sv.size === v.size)?.price || stored.baseline;
              if (!baseline) continue;
              const pct = ((baseline - v.price) / baseline) * 100;
              if (pct >= 10) dropVariants.push({ size: v.size, price: v.price, baseline, pct });
            }

            baselines[wl.id] = { ...stored, productName: product.name, lowestSeen: Math.min(currentLow, stored.lowestSeen || currentLow), variants: product.variants, checkedAt: new Date().toISOString() };
          }

        } else {
          // ── Text-based item (legacy): search Depop + Vinted ─────────────────
          const [depopR, vintedR] = await Promise.all([searchDepop(wl.item), searchVinted(wl.item)]);
          const allPrices = [...(depopR || []), ...(vintedR || [])]
            .map(x => parseFloat((x.price || '').replace('£', '')))
            .filter(p => !isNaN(p) && p > 0);
          if (!allPrices.length) continue;
          checkedCount++;
          currentLow = Math.min(...allPrices);
          currentAvg = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
          if (!stored) {
            baselines[wl.id] = { baseline: currentAvg, low: currentLow, item: wl.item, checkedAt: new Date().toISOString() };
            continue;
          }
          const dropPct = ((stored.baseline - currentLow) / stored.baseline) * 100;
          if (dropPct >= 10) dropVariants.push({ size: null, price: currentLow, baseline: stored.baseline, pct: dropPct });
          baselines[wl.id] = { ...stored, baseline: currentAvg, low: currentLow, checkedAt: new Date().toISOString() };
        }

        // ── Send alert if any variant dropped ──────────────────────────────────
        if (dropVariants.length > 0) {
          try {
            const discordUser = await client.users.fetch(wl.discord_id).catch(() => null);
            if (discordUser) {
              const sym   = currency === 'GBP' ? '£' : currency;
              const lines = dropVariants.slice(0, 10).map(v =>
                v.size
                  ? `**${v.size}** — ${sym}${v.price.toFixed(2)} *(was ${sym}${v.baseline.toFixed(2)}, −${v.pct.toFixed(0)}%)*`
                  : `${sym}${v.price.toFixed(2)} *(was ${sym}${v.baseline.toFixed(2)}, −${v.pct.toFixed(0)}%)*`
              );
              const embed = new EmbedBuilder().setColor('#e8a121')
                .setTitle(`📉 Price Drop — ${displayName.slice(0, 60)}`)
                .addFields(
                  { name: 'Drops detected', value: lines.join('\n').slice(0, 1024) },
                  ...(isUrl ? [{ name: 'Product page', value: wl.item.slice(0, 500) }] : []),
                )
                .setFooter({ text: 'Vendora Watchlist • /pricedrop' });
              await discordUser.send({ embeds: [embed] });
              alertCount++;
              console.log(`[cron:watchlist] Alerted ${wl.discord_id} — "${displayName}" (${dropVariants.length} variants dropped)`);
            }
          } catch (e) {
            console.warn(`[cron:watchlist] DM failed for ${wl.discord_id}:`, e.message);
          }
        }

        // Legacy manual signal
        if (wl.price_drop_signal === true) {
          try {
            const discordUser = await client.users.fetch(wl.discord_id).catch(() => null);
            if (discordUser) {
              await discordUser.send(`📉 **Price Drop Alert — ${displayName}**\nA price drop has been detected. Check the platform now.`);
              await fetch(`${SUPABASE_URL}/rest/v1/watchlist?id=eq.${wl.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
                body: JSON.stringify({ price_drop_signal: false }),
              });
            }
          } catch {}
        }

      } catch (e) {
        console.warn(`[cron:watchlist] Error checking "${wl.item}":`, e.message);
      }
    }

    // Persist updated baselines
    await saveSetting(baselineKey, baselines);
    console.log(`[cron:watchlist:${label}] Done. Checked ${checkedCount}/${items.length}, sent ${alertCount} alerts.`);
  } catch (e) {
    console.error(`[cron:watchlist:${label}] Fatal error:`, e.message);
  }
}

// Everyone every 6h; Elite additionally every hour (faster price-drop alerts).
cron.schedule('0 */6 * * *', () => runWatchlistCheck(null, 'all'));
cron.schedule('53 * * * *',  () => runWatchlistCheck(['elite'], 'elite'));

// ── Monthly credits grant ──────────────────────────────────────────────────────
// Called by dashboard on login — idempotent per calendar month
const MONTHLY_CREDITS = { pro: 500, elite: 1500 };

app.post('/api/credits/monthly-grant', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  try {
    const profile = await getProfileByUserId(user.id);
    if (!profile) return res.status(404).json({ error: 'profile not found' });
    const tier = profile.tier;
    const grant = MONTHLY_CREDITS[tier];
    if (!grant) return res.json({ ok: true, granted: 0, reason: 'no grant for tier' });

    const now     = new Date();
    const monthKey = `monthly_credits_${now.getFullYear()}_${now.getMonth() + 1}`;
    const already  = await getSetting(`${monthKey}_${user.id}`);
    if (already) return res.json({ ok: true, granted: 0, reason: 'already granted this month' });

    const newBal = await addCredits(user.id, grant);
    await saveSetting(`${monthKey}_${user.id}`, true);

    const discordId = user.user_metadata?.provider_id
      || user.identities?.find(i => i.provider === 'discord')?.id || '';
    if (discordId) sendCreditsDM(discordId, grant, newBal, 'admin').catch(() => {});

    console.log(`[monthly-credits] Granted ${grant} to ${user.id} (${tier}), new balance: ${newBal}`);
    res.json({ ok: true, granted: grant, newBalance: newBal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Simple listing fetch — same approach as seller-analyse ────────────────────
// Just fetches the page HTML, strips tags, returns raw text. Let Claude extract
// the structured fields itself — same pattern that works for Seller Intel.
async function fetchListingText(url) {
  const out = { platform: 'unknown', host: '', title: '', text: '' };
  try { out.host = new URL(url).hostname.replace(/^www\./, ''); } catch { return out; }
  if (out.host.includes('vinted.')) out.platform = 'Vinted';
  else if (out.host.includes('depop.')) out.platform = 'Depop';
  else if (out.host.includes('ebay.')) out.platform = 'eBay';

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    const html = await r.text();
    out.title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').replace(/\s*[-|].*$/,'').trim().slice(0, 160);

    // Keep OG / meta / JSON-LD BEFORE stripping tags — they carry price, brand, etc.
    const ogBlock = [...html.matchAll(/<meta\s+(?:property|name)="(og:[^"]+|description|twitter:[^"]+|product:[^"]+)"\s+content="([^"]+)"/gi)]
      .map(m => `[${m[1]}] ${m[2]}`).join('\n');
    const ldBlock = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/gi)]
      .map(m => m[1].trim()).join('\n').slice(0, 2500);

    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3500);

    out.text = [
      ogBlock ? `META TAGS:\n${ogBlock}` : '',
      ldBlock ? `STRUCTURED DATA:\n${ldBlock}` : '',
      `PAGE TEXT:\n${bodyText}`,
    ].filter(Boolean).join('\n\n');
  } catch (e) {
    console.warn('[listing-fetch]', e.message);
  }
  return out;
}

async function scrapeListingForOptimiser(url) {
  const out = { platform: 'unknown', title: '', description: '', price: '', brand: '', size: '', condition: '', photos: 0, raw: '' };
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return out; }

  // ── Vinted: use public item API via proxy, fall back to Playwright browser ──
  if (host.includes('vinted.')) {
    out.platform = 'Vinted';
    const idMatch = url.match(/\/items\/(\d+)/);
    if (idMatch) {
      const applyItem = (it) => {
        out.title       = it.title || '';
        out.description = it.description || '';
        out.price       = it.price?.amount ? `£${it.price.amount}` : (it.total_item_price?.amount ? `£${it.total_item_price.amount}` : (typeof it.price === 'string' ? `£${it.price}` : ''));
        out.brand       = it.brand || it.brand_dto?.title || '';
        out.size        = it.size || it.size_title || '';
        out.condition   = it.status || '';
        out.photos      = Array.isArray(it.photos) ? it.photos.length : 0;
      };
      // 1) direct proxy fetch
      try {
        const base = await getVintedBase();
        const r = await vFetch(`${base}/api/v2/items/${idMatch[1]}`, {
          headers: {
            'User-Agent': VINTED_UA,
            'Accept': 'application/json',
            'Accept-Language': 'en-GB,en;q=0.9',
            'Referer': `${base}/`,
          },
          signal: AbortSignal.timeout(10000),
        });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && ct.includes('application/json')) {
          const j = await r.json();
          applyItem(j.item || j);
          if (out.title) return out;
        } else {
          console.warn('[optimise] vinted direct api blocked', r.status, ct);
        }
      } catch (e) { console.warn('[optimise] vinted api fail', e.message); }

      // 2) browser fallback — navigates to the real page, solves DataDome
      if (vintedBrowser?.vintedBrowserFetchItem) {
        try {
          const br = await vintedBrowser.vintedBrowserFetchItem(url);
          if (br?.ok && br.data) {
            const it = br.data.item || br.data;
            out.title       = it.title || out.title;
            out.description = it.description || out.description;
            out.price       = it.price?.amount ? `£${it.price.amount}` : out.price;
            out.brand       = it.brand || it.brand_dto?.title || out.brand;
            out.size        = it.size || it.size_title || out.size;
            out.condition   = it.status || out.condition;
            out.photos      = Array.isArray(it.photos) ? it.photos.length : (out.photos || 0);
            if (out.title) return out;
          } else {
            console.warn('[optimise] vinted browser fetch failed', br?.status || br?.error);
          }
        } catch (e) { console.warn('[optimise] vinted browser error', e.message); }
      }
    }
    // Both paths blocked — fall through to generic HTML fetch for OG tags / slug.
  }

  // ── Depop: try product HTML — __NEXT_DATA__ carries the listing JSON ────────
  if (host.includes('depop.')) {
    out.platform = 'Depop';
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        const html = await r.text();
        const nextMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
        if (nextMatch) {
          try {
            const j = JSON.parse(nextMatch[1]);
            const prod = j?.props?.pageProps?.product || j?.props?.pageProps?.productDetails || null;
            if (prod) {
              out.title       = prod.description?.split('\n')[0]?.slice(0,100) || '';
              out.description = prod.description || '';
              out.price       = prod.priceAmount ? `£${prod.priceAmount}` : (prod.price?.priceAmount ? `£${prod.price.priceAmount}` : '');
              out.brand       = prod.brandName || prod.brand?.name || '';
              out.size        = (prod.variants?.[0]?.name) || prod.size || '';
              out.condition   = prod.condition || '';
              out.photos      = Array.isArray(prod.pictures) ? prod.pictures.length : (Array.isArray(prod.images) ? prod.images.length : 0);
              return out;
            }
          } catch {}
        }
        // fallback: meta tags
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
        const descMatch  = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
        const priceMatch = html.match(/£\s*(\d+(?:\.\d{2})?)/);
        out.title       = titleMatch?.[1] || '';
        out.description = descMatch?.[1] || '';
        out.price       = priceMatch?.[1] ? `£${priceMatch[1]}` : '';
        return out;
      }
    } catch (e) { console.warn('[optimise] depop fail', e.message); }
  }

  // ── eBay / generic: rich browser headers, parse OG + JSON-LD ────────────────
  if (host.includes('ebay.')) out.platform = 'eBay';
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    if (r.ok) {
      const html = await r.text();
      const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1];
      const ogDesc  = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)?.[1];
      const metaDesc= html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1];
      const titleTag= html.match(/<title[^>]*>([^<]{3,160})<\/title>/i)?.[1];
      const priceOg = html.match(/<meta\s+property="(?:product:price:amount|og:price:amount)"\s+content="([^"]+)"/i)?.[1];
      const pricePound = html.match(/£\s*(\d+(?:\.\d{2})?)/)?.[1];
      out.title       = ogTitle || (titleTag || '').replace(/\s*[|-].*$/,'').trim();
      out.description = ogDesc || metaDesc || '';
      out.price       = priceOg ? `£${priceOg}` : (pricePound ? `£${pricePound}` : '');
      // JSON-LD Product fallback
      const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/gi)];
      for (const m of ldMatches) {
        try {
          const obj = JSON.parse(m[1]);
          const arr = Array.isArray(obj) ? obj : [obj];
          for (const o of arr) {
            if (o['@type'] === 'Product' || (Array.isArray(o['@type']) && o['@type'].includes('Product'))) {
              out.title       = out.title       || o.name || '';
              out.description = out.description || o.description || '';
              out.brand       = out.brand       || (typeof o.brand === 'string' ? o.brand : o.brand?.name) || '';
              const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
              if (offer?.price && !out.price) out.price = `£${offer.price}`;
            }
          }
        } catch {}
      }
      return out;
    }
  } catch (e) { console.warn('[optimise] generic fetch fail', e.message); }

  // Last-resort: extract product keywords from the URL slug so Claude + Brave
  // have *something* to work with. Vinted/Depop slugs are descriptive.
  if (!out.title) {
    try {
      const path = new URL(url).pathname;
      const parts = path.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      // strip leading numeric id (Vinted "12345678-nike-air-max" → "nike-air-max")
      const slug = last.replace(/^\d+[-_]?/, '').replace(/\.(html?|php)$/, '');
      const readable = decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
      if (readable.length >= 3) out.title = readable;
    } catch {}
  }
  return out;
}

// ── Listing Optimiser ──────────────────────────────────────────────────────────
app.post('/api/listing/optimise', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.basic) return res.status(403).json({ error: 'Subscription required.' });

  const { url } = req.body || {};
  if (!url?.startsWith('http')) return res.status(400).json({ error: 'Valid URL required.' });

  try {
    if (!ai) return res.status(500).json({ error: 'AI service unavailable.' });

    const page = await fetchListingText(url);

    let webCtx = '';
    try {
      const q = (page.title || url).slice(0, 140);
      const hits = await webSearch(q, 5);
      if (Array.isArray(hits) && hits.length) {
        webCtx = hits.map(h => `• ${h.title}: ${h.description}`).join('\n').slice(0, 1500);
      }
    } catch {}

    const prompt = `You are a reselling expert. Below is the raw scraped content of a product listing. Extract the actual title, price, description, brand, size, condition, and any other detail you can find in the text, then analyse the listing and give specific, actionable improvement suggestions.

Listing URL: ${url}
Platform: ${page.platform}
Page <title>: ${page.title || '(empty)'}

SCRAPED CONTENT (meta tags, JSON-LD, and stripped body text):
${page.text || '(page could not be fetched)'}
${webCtx ? `\nWEB MARKET CONTEXT:\n${webCtx}` : ''}

Every suggestion MUST reference the actual product from the scraped content above — its real brand, size, price, or description wording. Do not give generic advice.

Return a JSON object with this exact shape:
{
  "score": <number 0-100 rating the current listing quality>,
  "title": "<the real listing title you extracted>",
  "meta": "<platform and price, e.g. Vinted · £45>",
  "suggestions": [
    { "category": "Title", "heading": "<short improvement label>", "detail": "<specific suggestion referencing the real listing>" },
    { "category": "Description", "heading": "...", "detail": "..." },
    { "category": "Pricing", "heading": "...", "detail": "..." },
    { "category": "Photos", "heading": "...", "detail": "..." },
    { "category": "Keywords", "heading": "...", "detail": "..." }
  ]
}

Categories must be one of: Title, Description, Pricing, Photos, Keywords, General.
Give 4-7 suggestions. Return ONLY the JSON, no markdown.`;

    if (!ai) return res.status(500).json({ error: 'AI service unavailable.' });
    const aiRes = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = aiRes.content[0].text.trim().replace(/^```json?\s*/,'').replace(/\s*```$/,'');
    const data = JSON.parse(raw);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[listing-optimise]', e.message, e.stack?.split('\n').slice(0,3).join(' | '));
    res.status(500).json({ error: `Failed to analyse listing: ${e.message}` });
  }
});

// ── Auto-Draft ─────────────────────────────────────────────────────────────────
app.post('/api/listing/draft', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.basic) return res.status(403).json({ error: 'Subscription required.' });

  const { name, condition, size, details, platform, price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Item name required.' });

  const platformNote = platform === 'vinted'  ? 'Vinted (max 500 chars in description, conversational tone)'
                     : platform === 'depop'   ? 'Depop (casual, emoji-friendly, youth audience)'
                     : platform === 'ebay'    ? 'eBay (detailed, keyword-rich, formal)'
                     : 'all platforms (universal, professional)';

  const prompt = `You are a professional reselling listing copywriter. Write a complete, optimised listing.

Item: ${name}
Condition: ${condition}
${size ? `Size/Spec: ${size}` : ''}
${details ? `Details: ${details}` : ''}
${price ? `Seller's asking price: £${price}` : ''}
Target platform: ${platformNote}

Return ONLY a JSON object with this exact shape:
{
  "title": "<optimised listing title, max 80 chars, keyword-rich>",
  "description": "<full listing description, well-formatted, platform-appropriate>",
  "price": "<suggested price as a number e.g. 45.00, or use seller's price if provided>",
  "keywords": ["keyword1","keyword2","keyword3","keyword4","keyword5","keyword6"]
}

No markdown, just the JSON.`;

  try {
    if (!ai) return res.status(500).json({ error: 'AI service unavailable.' });
    const aiRes = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw  = aiRes.content[0].text.trim().replace(/^```json?\s*/,'').replace(/\s*```$/,'');
    const data = JSON.parse(raw);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[listing-draft]', e.message);
    res.status(500).json({ error: 'Failed to generate draft.' });
  }
});

// ── Seller Intelligence ────────────────────────────────────────────────────────
app.post('/api/seller/analyse', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.basic) return res.status(403).json({ error: 'Subscription required.' });

  const { url } = req.body || {};
  if (!url?.startsWith('http')) return res.status(400).json({ error: 'Valid URL required.' });

  try {
    const pageRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    const html  = await pageRes.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').slice(0, 100);
    const text  = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0, 3000);

    // Brave search for additional intel
    const sellerName = title.split(/[-|@]/)[0].trim();
    const braveData  = await webSearch(`${sellerName} reseller feedback rating`, 4).catch(() => null);
    const webContext = braveData?.map(r => `${r.title}: ${r.description}`).join('\n') || '';

    const prompt = `You are a reselling competitive intelligence analyst. Analyse this seller profile.

Seller URL: ${url}
Page content: ${text}
${webContext ? `Web context:\n${webContext}` : ''}

Return ONLY a JSON object:
{
  "sellerName": "<seller username>",
  "meta": "<platform · number of listings or followers if detectable>",
  "report": "<3-4 paragraph analysis: pricing behaviour, category focus, sell-through patterns, strengths and weaknesses>",
  "stats": [
    { "label": "Category Focus", "value": "<main category>", "color": null },
    { "label": "Pricing Style", "value": "<e.g. Premium / Discount / Mid>", "color": null },
    { "label": "Est. Activity", "value": "<e.g. High / Medium / Low>", "color": "var(--green)" }
  ],
  "strategy": "<specific 2-3 actionable recommendations for competing with or sourcing from this seller>"
}

No markdown, just JSON.`;

    if (!ai) return res.status(500).json({ error: 'AI service unavailable.' });
    const aiRes = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw  = aiRes.content[0].text.trim().replace(/^```json?\s*/,'').replace(/\s*```$/,'');
    const data = JSON.parse(raw);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[seller-analyse]', e.message);
    res.status(500).json({ error: 'Failed to analyse seller. The page may be protected.' });
  }
});

// ── Flip Score ─────────────────────────────────────────────────────────────────
app.post('/api/flip/score', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.pro) return res.status(403).json({ error: 'Pro subscription required.' });

  const { url } = req.body || {};
  if (!url?.startsWith('http')) return res.status(400).json({ error: 'Valid URL required.' });

  try {
    const page = await fetchListingText(url);

    const searchQ  = `${page.title || url} sold price ebay UK`;
    const soldData = await webSearch(searchQ.slice(0, 160), 6).catch(() => null);
    const soldCtx  = Array.isArray(soldData) && soldData.length
      ? soldData.map(r => `• ${r.title}: ${r.description}`).join('\n').slice(0, 1500)
      : '';

    const prompt = `You are a professional reseller. Extract the item details (brand, title, price, size, condition) from the scraped content below, then score this flip opportunity.

Listing URL: ${url}
Platform: ${page.platform}
Page <title>: ${page.title || '(empty)'}

SCRAPED CONTENT (meta tags, JSON-LD, and stripped body text):
${page.text || '(page could not be fetched)'}
${soldCtx ? `\nSOLD COMP DATA FROM WEB:\n${soldCtx}` : '\n(No sold comp data available — use reselling knowledge.)'}

Ground every number in the data above. If a detail genuinely isn't in the scraped content, state that in the breakdown sub-line rather than inventing it.

Return ONLY a JSON object:
{
  "score": <integer 0-100>,
  "verdict": "<one of: Strong Buy / Good Flip / Marginal / Avoid>",
  "analysis": "<3-4 sentences: demand assessment, competition level, price vs market, risk factors>",
  "breakdown": [
    { "label": "Demand", "value": "<High/Med/Low>", "sub": "<one line reason>" },
    { "label": "Competition", "value": "<High/Med/Low>", "sub": "<one line reason>" },
    { "label": "Est. Days to Sell", "value": "<number or range>", "sub": "at list price" },
    { "label": "Est. Profit", "value": "<£X or range>", "sub": "after fees" }
  ]
}

No markdown, just JSON.`;

    if (!ai) return res.status(500).json({ error: 'AI service unavailable.' });
    const aiRes = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw  = aiRes.content[0].text.trim().replace(/^```json?\s*/,'').replace(/\s*```$/,'');
    const data = JSON.parse(raw);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[flip-score]', e.message);
    res.status(500).json({ error: 'Failed to score this flip.' });
  }
});

// ── Price Elasticity ───────────────────────────────────────────────────────────
app.post('/api/price/elasticity', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.pro) return res.status(403).json({ error: 'Pro subscription required.' });

  const { item, condition } = req.body || {};
  if (!item) return res.status(400).json({ error: 'Item name required.' });

  try {
    const [soldRes, priceRes] = await Promise.allSettled([
      webSearch(`${item} sold price UK resale${condition && condition !== 'any' ? ` ${condition}` : ''}`, 6),
      webSearch(`${item} eBay sold listings UK 2024 2025`, 4),
    ]);

    const webCtx = [soldRes, priceRes]
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
      .flatMap(r => r.value.map(x => `${x.title}: ${x.description}`))
      .join('\n');

    const prompt = `You are a reselling market analyst with access to sold price data.

Item: ${item}
Condition: ${condition || 'any'}
Market data from web:
${webCtx || 'Limited data — use general reselling knowledge for this item category.'}

Generate a price elasticity curve for reselling this item in the UK. Model at least 6 price points.

Return ONLY a JSON object:
{
  "item": "<item name, corrected if needed>",
  "insight": "<2-3 sentences identifying the sweet spot and explaining the key tradeoffs>",
  "curve": [
    { "price": "30", "days": "1-2", "profit": "£8", "roi": "27", "sweet_spot": false, "verdict": "Too cheap" },
    { "price": "40", "days": "3-5", "profit": "£16", "roi": "40", "sweet_spot": false, "verdict": "Fast flip" },
    { "price": "50", "days": "7-10", "profit": "£24", "roi": "48", "sweet_spot": true, "verdict": null },
    ...
  ]
}

Profit should account for ~12% platform fees and £3-5 postage. ROI is (profit/buy_price)*100 assuming buy price is 20-30% below market.
No markdown, just JSON.`;

    if (!ai) return res.status(500).json({ error: 'AI service unavailable.' });
    const aiRes = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw  = aiRes.content[0].text.trim().replace(/^```json?\s*/,'').replace(/\s*```$/,'');
    const data = JSON.parse(raw);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[price-elasticity]', e.message);
    res.status(500).json({ error: 'Failed to model price curve.' });
  }
});

// ── Resell Calendar ────────────────────────────────────────────────────────────
app.get('/api/resell/calendar', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.basic) return res.status(403).json({ error: 'Subscription required.' });

  const category = req.query.category || 'all';
  const catQuery = category === 'all' ? 'sneakers streetwear luxury' : category;

  try {
    const [drops, events, seasonal] = await Promise.allSettled([
      webSearch(`upcoming ${catQuery} drops release dates UK 2025`, 6),
      braveNewsSearch(`${catQuery} resell hype upcoming drop collab 2025`, 5),
      webSearch(`${catQuery} seasonal demand resale market UK 2025`, 4),
    ]);

    const webCtx = [drops, events, seasonal]
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
      .flatMap(r => r.value.map(x => `${x.title}: ${x.description || x.url || ''}`))
      .join('\n');

    const now       = new Date();
    const monthName = now.toLocaleString('en-GB', { month: 'short' }).toUpperCase();
    const day       = now.getDate();

    const prompt = `You are a reselling market intelligence analyst. Generate a resell calendar of upcoming events based on the live web data below.

Category filter: ${category}
Today: ${now.toLocaleDateString('en-GB')}
Live web data:
${webCtx || 'Use your general knowledge of the reselling market for upcoming events.'}

Generate 6-10 calendar events relevant to UK resellers. Include:
- Confirmed sneaker/collab drops with dates
- Platform sale events (Vinted, Depop promotions)
- Seasonal demand windows (back-to-school, Christmas, etc.)
- Hype events (fashion weeks, sports events affecting prices)

Return ONLY a JSON object:
{
  "events": [
    {
      "month": "APR",
      "day": "19",
      "title": "Nike x Sacai Zoom Cortez Drop",
      "category": "Sneakers",
      "urgency": "high",
      "description": "Limited global release. Expect 3-5x resale immediately after launch.",
      "action": "Source now — list day-of-release for peak price"
    }
  ]
}

urgency must be: high, medium, or low.
Sort by date ascending. Use real upcoming dates where you have data; estimate month for seasonal events.
No markdown, just JSON.`;

    if (!ai) return res.status(500).json({ error: 'AI service unavailable.' });
    const aiRes = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw  = aiRes.content[0].text.trim().replace(/^```json?\s*/,'').replace(/\s*```$/,'');
    const data = JSON.parse(raw);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[resell-calendar]', e.message);
    res.status(500).json({ error: 'Failed to load calendar.' });
  }
});

// ── Vinted alert cron — runs every 30 minutes ────────────────────────────────
// For each saved vinted_alert, run an Apify Vinted search, diff against seen_ids,
// and DM the user about any new matching listings.
// ── Vinted token refresh helper ───────────────────────────────────────────────
// Silently refreshes a user's Vinted access token using the stored refresh token.
// Stores the new token in Supabase with an updated token_expires_at.
// Returns the new raw access_token string, or null on failure.
async function refreshVintedTokenIfNeeded(userId, conn) {
  if (!conn?.refresh_token || !vintedBrowser?.refreshVintedAccessToken) return null;
  try {
    const rawRefresh = decryptToken(conn.refresh_token);
    if (!rawRefresh) return null;

    console.log(`[token-refresh] Refreshing Vinted token for user ${userId}…`);
    const result = await vintedBrowser.refreshVintedAccessToken(rawRefresh);

    if (result.error) {
      console.warn(`[token-refresh] Failed for user ${userId}:`, result.error);
      // DM the user so they know to reconnect — don't let the failure be silent
      try {
        const profile = await fetchProfile(userId);
        const discordId = profile?.discord_id;
        if (discordId && discordClient?.users) {
          const du = await discordClient.users.fetch(discordId).catch(() => null);
          if (du) {
            await du.send({
              embeds: [baseEmbed('#e8a121')
                .setTitle('⚠️ Vinted Session Expired')
                .setDescription(
                  'Your Vinted session token has expired and could not be automatically refreshed.\n\n' +
                  '**To restore profit tracking, auto-buy alerts, and listing features:**\n' +
                  '→ Go to your [Vendora dashboard](https://vendora.app) → **Platforms** → disconnect and reconnect your Vinted account.'
                )],
            }).catch(() => {});
          }
        }
      } catch {}
      return null;
    }

    // Save new access token (and possibly new refresh token) to Supabase
    await upsertPlatformConn(userId, 'vinted', {
      access_token:     encryptToken(result.access_token),
      ...(result.refresh_token && result.refresh_token !== rawRefresh
        ? { refresh_token: encryptToken(result.refresh_token) }
        : {}),
      // token_expires_at omitted — column not in schema
    });

    console.log(`[token-refresh] Token refreshed for user ${userId}`);
    return result.access_token;
  } catch (e) {
    console.error('[token-refresh] Error:', e.message);
    return null;
  }
}

// ── Token refresh cron — runs every hour ──────────────────────────────────────
// Checks every connected Vinted account and refreshes the access token if it
// will expire within 2 days. Ensures features like auto-buy never fail mid-session
// due to a stale token.
cron.schedule('45 * * * *', async () => {
  if (!SUPABASE_KEY || !vintedBrowser?.refreshVintedAccessToken) return;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_connections?platform=eq.vinted&select=user_id,access_token,refresh_token`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const conns = await r.json();
    if (!Array.isArray(conns) || !conns.length) return;

    const twoDaysMs = 2 * 86400000;
    const toRefresh = conns.filter(c => {
      if (!c.refresh_token) return false; // no refresh token — can't refresh
      // Parse expiry from the JWT 'exp' claim (seconds since epoch)
      try {
        if (c.access_token) {
          const raw  = decryptToken(c.access_token);
          const parts = raw?.split('.');
          if (parts?.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (payload.exp) {
              const expiresAt = payload.exp * 1000; // convert to ms
              // Refresh if expiring within 2 days
              return expiresAt < Date.now() + twoDaysMs;
            }
          }
        }
      } catch {}
      // No exp in JWT — refresh as a precaution (token age unknown)
      return true;
    });

    if (!toRefresh.length) {
      console.log('[cron:token-refresh] All Vinted tokens valid for >2 days, skipping');
      return;
    }

    console.log(`[cron:token-refresh] Refreshing ${toRefresh.length} expiring token(s)…`);
    for (const conn of toRefresh) {
      await refreshVintedTokenIfNeeded(conn.user_id, conn);
      await new Promise(r => setTimeout(r, 3000));
    }
    console.log('[cron:token-refresh] Done');
  } catch (e) {
    console.error('[cron:token-refresh] Fatal:', e.message);
  }
});

// ── Token-expiry DM notifier — runs hourly ───────────────────────────────────
// Vinted's access_token_web is short-lived and the cookie-paste flow stores no
// refresh token, so most tokens just silently expire — breaking Inventory,
// Profit, Auto-Buy and listing features. This DMs the user (once per token) to
// paste a fresh one. Connections WITH a refresh token are handled by the
// refresh cron above, so we skip them here to avoid double-notifying.
cron.schedule('25 * * * *', async () => {
  if (!SUPABASE_KEY || !client) return;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_connections?platform=eq.vinted&select=user_id,access_token,refresh_token`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const conns = await r.json();
    if (!Array.isArray(conns) || !conns.length) return;

    const SOON_MS = 12 * 3600 * 1000;
    let notified = 0;
    for (const c of conns) {
      try {
        if (c.refresh_token) continue; // handled by refresh cron
        const raw = decryptToken(c.access_token || '');
        const parts = raw?.split('.');
        if (!raw || parts?.length !== 3) continue;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload.exp) continue;

        const expMs = payload.exp * 1000;
        if (expMs >= Date.now() + SOON_MS) continue; // not expiring soon
        const expired = expMs < Date.now();

        // Dedup: only one DM per distinct token expiry.
        const notifyKey = `vinted_token_notified_${c.user_id}`;
        if ((await getSetting(notifyKey)) === payload.exp) continue;

        const profile   = await getProfileByUserId(c.user_id);
        const discordId = profile?.discord_id;
        if (!discordId) continue;
        const du = await client.users.fetch(discordId).catch(() => null);
        if (!du) continue;

        const whenStr = new Date(expMs).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        await du.send({ embeds: [ new EmbedBuilder()
          .setColor(expired ? '#f87171' : '#e8a121')
          .setTitle(expired ? '⚠️ Vinted Token Expired' : '⏳ Vinted Token Expiring Soon')
          .setDescription(
            `Your Vinted session token ${expired ? '**has expired**' : `expires around **${whenStr}**`}.\n\n` +
            `While it's expired, **Inventory, Profit Tracker, Auto-Buy and listing features won't update.**\n\n` +
            `**Fix it in ~30 seconds:**\n` +
            `→ Open Vinted in your browser (logged in)\n` +
            `→ F12 → Application → Cookies → \`www.vinted.co.uk\`\n` +
            `→ Copy the **access_token_web** value\n` +
            `→ Paste it on your [Vendora dashboard](${DASHBOARD_URL}) → **Platforms**`
          )
          .setFooter({ text: 'Vendora · sent once per token' })
          .setTimestamp() ] }).catch(() => {});

        await saveSetting(notifyKey, payload.exp);
        notified++;
        console.log(`[cron:token-expiry] notified ${discordId} (exp ${whenStr})`);
        await new Promise(r => setTimeout(r, 1500));
      } catch {}
    }
    if (notified) console.log(`[cron:token-expiry] Done — ${notified} DM(s) sent.`);
  } catch (e) {
    console.error('[cron:token-expiry] Fatal:', e.message);
  }
});

// ── AI inventory suggestions cron — every 8 hours ────────────────────────────
// For every connected Vinted user, loads their inventory snapshot and asks the
// AI for specific improvement suggestions on stale listings (listed > 3 days).
// Results stored in Supabase under inventory_suggestions_{userId}.
async function generateInventorySuggestionsForUser(userId, items) {
  if (!ai || !items?.length) return;
  try {
    const STALE_DAYS = 3;
    const now        = Date.now();

    // Only analyse listings that have been up long enough to have real view data
    const stale = items.filter(item => {
      const ts = item.created_at ? new Date(item.created_at).getTime() : 0;
      return (now - ts) > STALE_DAYS * 86400000;
    }).slice(0, 10); // cap at 10 to control AI spend

    if (!stale.length) return;

    const existing = (await getSetting(`inventory_suggestions_${userId}`)) || {};

    for (const item of stale) {
      const itemId = String(item.id || item.item_id || '');
      if (!itemId) continue;

      // Skip items we generated suggestions for in the last 24h
      const prev = existing[itemId];
      if (prev?.generated_at && (now - new Date(prev.generated_at).getTime()) < 86400000) continue;

      const daysListed = item.created_at
        ? Math.floor((now - new Date(item.created_at).getTime()) / 86400000)
        : null;

      const context = [
        `Title: ${item.title || '—'}`,
        `Price: £${item.price?.amount || item.price || '—'}`,
        item.brand_title    ? `Brand: ${item.brand_title}`    : null,
        item.size_title     ? `Size: ${item.size_title}`      : null,
        item.status         ? `Condition: ${item.status}`     : null,
        daysListed != null  ? `Days listed: ${daysListed}`    : null,
        item.favourite_count != null ? `Favourites: ${item.favourite_count}` : null,
        item.view_count      != null ? `Views: ${item.view_count}`            : null,
      ].filter(Boolean).join('\n');

      const text = await callAI(
        'You are Vendora\'s listing optimization expert for Vinted UK. Analyze this listing and give exactly 2 specific, actionable improvement suggestions to increase views and speed up the sale. Each suggestion must be concrete — mention exact words to add/change, specific price points, or precise description edits. Do NOT give generic advice.',
        context,
        'claude-haiku-4-5-20251001',
        250,
      );

      if (text) {
        existing[itemId] = {
          item_title:   (item.title || '').slice(0, 60),
          suggestions:  text.trim(),
          generated_at: new Date().toISOString(),
        };
      }

      await new Promise(r => setTimeout(r, 600)); // small gap between AI calls
    }

    await saveSetting(`inventory_suggestions_${userId}`, existing);
    console.log(`[ai-suggestions] Generated suggestions for user ${userId} (${stale.length} items checked)`);
  } catch (e) {
    console.error('[ai-suggestions] Error:', e.message);
  }
}

cron.schedule('30 */8 * * *', async () => {
  if (!SUPABASE_KEY || !ai) return;
  console.log('[cron:ai-suggestions] Starting AI inventory suggestion pass…');
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_connections?platform=eq.vinted&select=user_id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const conns = await r.json();
    if (!Array.isArray(conns)) return;

    for (const conn of conns) {
      try {
        const snapshot = await getSetting(`vinted_inventory_${conn.user_id}`);
        if (!snapshot?.items?.length) continue;
        await generateInventorySuggestionsForUser(conn.user_id, snapshot.items);
        await new Promise(r => setTimeout(r, 4000)); // spread AI load across users
      } catch (e) {
        console.warn(`[cron:ai-suggestions] Error for user ${conn.user_id}:`, e.message);
      }
    }
    console.log('[cron:ai-suggestions] Done');
  } catch (e) {
    console.error('[cron:ai-suggestions] Fatal:', e.message);
  }
});

// ── Auto-buy fast poll — every 2 minutes ─────────────────────────────────────
// Runs keyword searches every 2 min for alerts that have auto_buy = true.
// Uses the Playwright browser (DataDome already solved) instead of Apify —
// this cuts detection latency from ~30 min down to ~2 min, which is fast
// enough to win the competition for desirable items.
// If the user has a connected Vinted account, attempts to auto-purchase.
cron.schedule('*/2 * * * *', async () => {
  if (!SUPABASE_KEY || !vintedBrowser?.vintedBrowserSearchItems) return;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vinted_alerts?auto_buy=eq.true&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const alerts = await r.json();
    if (!Array.isArray(alerts) || !alerts.length) return;

    for (const alert of alerts) {
      try {
        const { items, error } = await vintedBrowser.vintedBrowserSearchItems(alert.keyword, alert.max_price, 20);
        if (error) { console.warn(`[auto-buy] Search error for "${alert.keyword}":`, error); continue; }
        if (!items.length) continue;

        const seenIds  = new Set(alert.seen_ids || []);
        const newItems = items.filter(i => {
          const id = String(i.id || '');
          return id && !seenIds.has(id);
        });
        if (!newItems.length) continue;

        // Look up the user's connected Vinted account for auto-purchasing
        let platformConn = null;
        try {
          const ur = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?discord_id=eq.${alert.discord_id}&select=id`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
          );
          const profiles = await ur.json();
          if (profiles?.[0]?.id) platformConn = await getPlatformConn(profiles[0].id, 'vinted');
        } catch {}

        for (const item of newItems.slice(0, 3)) {
          const itemId = String(item.id || '');
          const price  = item.price?.amount || item.priceNum || item.price || '?';
          const title  = (item.title || 'New listing').slice(0, 80);
          const url    = item.url || `https://www.vinted.co.uk/items/${itemId}`;

          let purchaseResult = null;

          // Attempt auto-purchase if user has a valid stored token
          if (platformConn?.access_token && itemId) {
            try {
              // Refresh token if needed before purchase attempt
              let rawToken = decryptToken(platformConn.access_token);
              if (platformConn.token_expires_at && new Date(platformConn.token_expires_at).getTime() < Date.now() + 3600000) {
                const refreshed = await refreshVintedTokenIfNeeded(platformConn.user_id, platformConn);
                if (refreshed) rawToken = refreshed;
              }
              if (rawToken) {
                console.log(`[auto-buy] Attempting purchase of item ${itemId} (keyword: "${alert.keyword}")`);
                purchaseResult = await vintedBrowser.vintedBrowserBuyItem(rawToken, itemId);
                console.log(`[auto-buy] Item ${itemId}:`, purchaseResult?.ok ? '✅ purchased' : `❌ ${purchaseResult?.error}`);
              }
            } catch (e) {
              console.warn('[auto-buy] Purchase threw:', e.message);
              purchaseResult = { error: e.message };
            }
          }

          // DM the user whether purchase succeeded or failed
          try {
            const discordUser = await client.users.fetch(alert.discord_id);
            const bought = purchaseResult?.ok;

            const embed = new EmbedBuilder()
              .setColor(bought ? '#4ade80' : '#e8217a')
              .setTimestamp();

            if (bought) {
              embed
                .setTitle(`✅ Auto-Bought — "${alert.keyword}"`)
                .setDescription(`**${title}**\nPrice: £${price}\n\n[View on Vinted](${url})`)
                .setFooter({ text: 'Vendora Auto-Buy · Check your Vinted app to confirm the order' });
              if (purchaseResult.transaction_id) {
                embed.addFields({ name: 'Transaction ID', value: purchaseResult.transaction_id, inline: true });
              }
            } else {
              const failNote = purchaseResult?.error
                ? `\n⚠️ **Auto-buy failed:** ${purchaseResult.error.slice(0, 120)}`
                : '';
              embed
                .setTitle(`🔔 Auto-Buy Alert — "${alert.keyword}"`)
                .setDescription(`**${title}**\nPrice: £${price}${failNote}\n\n**[→ Buy Now on Vinted](${url})**`)
                .setFooter({ text: 'Vendora Auto-Buy · Found within 2 min of listing' });
            }

            if (alert.max_price) embed.addFields({ name: 'Under', value: `£${alert.max_price}`, inline: true });

            const components = !bought && itemId ? [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Buy on Vinted →').setURL(url).setStyle(ButtonStyle.Link)
              ),
            ] : [];

            await discordUser.send({ embeds: [embed], components });
          } catch (e) {
            console.warn(`[auto-buy] DM failed for ${alert.discord_id}:`, e.message);
          }
        }

        // Update seen_ids so we don't re-alert for these items
        const allIds = [...new Set([...seenIds, ...items.map(i => String(i.id || '')).filter(Boolean)])];
        await dbUpdateVintedAlertSeenIds(alert.id, allIds.slice(-500));
      } catch (e) {
        console.warn(`[auto-buy] Error for alert "${alert.keyword}":`, e.message);
      }
    }
  } catch (e) {
    console.error('[auto-buy] Fatal:', e.message);
  }
});

// Map a list of Discord IDs → their active subscription tier in one query.
async function getTiersForDiscordIds(discordIds) {
  const map = {};
  if (!SUPABASE_KEY || !discordIds.length) return map;
  try {
    const list = discordIds.map(encodeURIComponent).join(',');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?discord_id=in.(${list})&select=discord_id,tier,subscription_status`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    const rows = await r.json();
    if (Array.isArray(rows)) for (const p of rows) {
      map[p.discord_id] = (p.subscription_status === 'active') ? (p.tier || 'none') : 'none';
    }
  } catch (e) { console.warn('[getTiersForDiscordIds]', e.message); }
  return map;
}

// Process Vinted keyword alerts for users whose tier is in `allowedTiers`.
// Shared by the Elite (5-min) and Pro (30-min) crons so each tier gets a
// different check cadence — speed is the core Elite differentiator.
async function processVintedAlerts(allowedTiers, label) {
  if (!APIFY_TOKEN || !SUPABASE_KEY) return;
  let alertCount = 0;
  try {
    const all = await dbGetVintedAlerts(null);
    if (!all?.length) return;
    const tierMap = await getTiersForDiscordIds([...new Set(all.map(a => a.discord_id))]);
    const alerts = all.filter(a => allowedTiers.includes(tierMap[a.discord_id]));
    if (!alerts.length) return;

    for (const alert of alerts) {
      try {
        const items = await apifyVintedSearch(alert.keyword, 20);
        if (!items?.length) continue;

        const seenIds  = new Set(alert.seen_ids || []);
        const newItems = items.filter(i => i.id && !seenIds.has(i.id));
        const filtered = alert.max_price
          ? newItems.filter(i => i.priceNum > 0 && i.priceNum <= alert.max_price)
          : newItems;

        if (filtered.length) {
          try {
            const discordUser = await client.users.fetch(alert.discord_id);
            const lines = filtered.slice(0, 5).map(i =>
              `• **[${(i.title || 'Item').slice(0, 60)}](${i.url})** — ${i.price}${i.brand ? ` · ${i.brand}` : ''}`
            );
            const embed = new EmbedBuilder()
              .setColor('#e8217a')
              .setTitle(`🔔 New Vinted Listings — "${alert.keyword}"`)
              .setDescription(lines.join('\n') + (filtered.length > 5 ? `\n*+${filtered.length - 5} more*` : ''))
              .setFooter({ text: `Vendora Vinted Alerts · /vinted-alert list to manage` })
              .setTimestamp();
            if (alert.max_price) embed.addFields({ name: 'Filter', value: `Under £${alert.max_price}`, inline: true });
            await discordUser.send({ embeds: [embed] });
            alertCount++;
          } catch (e) {
            console.warn(`[cron:vinted-alerts:${label}] DM failed for ${alert.discord_id}:`, e.message);
          }
        }

        const allIds = [...new Set([...seenIds, ...items.map(i => i.id).filter(Boolean)])];
        await dbUpdateVintedAlertSeenIds(alert.id, allIds.slice(-500));
      } catch (e) {
        console.warn(`[cron:vinted-alerts:${label}] Error checking "${alert.keyword}":`, e.message);
      }
    }
    if (alertCount) console.log(`[cron:vinted-alerts:${label}] Checked ${alerts.length} alerts, sent ${alertCount} DMs.`);
  } catch (e) {
    console.error(`[cron:vinted-alerts:${label}] Fatal:`, e.message);
  }
}

// Elite alerts every 5 minutes (wins items first); Pro alerts every 30 minutes.
cron.schedule('*/5 * * * *',  () => processVintedAlerts(['elite'], 'elite'));
cron.schedule('*/30 * * * *', () => processVintedAlerts(['pro'],   'pro'));

// ── Vinted alert toggle (auto_buy, max_price) ────────────────────────────────
// PATCH /api/vinted/alert/:id — update fields on a Vinted alert owned by the user.
// Supports toggling auto_buy on/off and updating max_price.
app.patch('/api/vinted/alert/:id', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id;
  if (!discordId) return res.status(400).json({ error: 'No Discord ID on account' });

  const alertId = req.params.id;
  const { auto_buy, max_price } = req.body;

  // Verify this alert belongs to this Discord user
  const alerts = await dbGetVintedAlerts(discordId);
  const alert   = alerts.find(a => String(a.id) === String(alertId));
  if (!alert) return res.status(404).json({ error: 'Alert not found or does not belong to you' });

  const update = {};
  if (typeof auto_buy === 'boolean') update.auto_buy = auto_buy;
  if (max_price !== undefined)        update.max_price = max_price === null ? null : Number(max_price);
  if (!Object.keys(update).length)    return res.status(400).json({ error: 'Nothing to update — send auto_buy or max_price' });

  await dbUpdateVintedAlert(alertId, update);
  res.json({ ok: true, alert: { ...alert, ...update } });
});

// GET /api/inventory/suggestions — AI improvement suggestions for the user's listings
// Populated by the every-8-hours AI suggestions cron. Returns a map of
// item_id → { item_title, suggestions, generated_at }.
app.get('/api/inventory/suggestions', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const suggestions = (await getSetting(`inventory_suggestions_${user.id}`)) || {};
  res.json({ ok: true, suggestions });
});

const STALE_LISTING_DAYS = 14;

// POST /api/inventory/analyse-all — Elite-only. Scores every active listing in
// one pass and flags stale ones with a suggested price drop. Returns results
// sorted worst-first so the seller sees what to fix first.
app.post('/api/inventory/analyse-all', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const profile = await getProfileByUserId(user.id);
  if (!profile || TIER_RANK[profile.tier] < TIER_RANK.elite) return res.status(403).json({ error: 'Elite plan required.' });
  if (!ai) return res.status(500).json({ error: 'AI service unavailable.' });

  const snap  = (await getSetting(`vinted_inventory_${user.id}`)) || { items: [] };
  const items = (snap.items || []).filter(i => (i.status || 'active') === 'active').slice(0, 30);
  if (!items.length) return res.json({ ok: true, analysed: 0, items: [], note: 'No active listings to analyse — sync your inventory first.' });

  const now = Date.now();
  const results = [];
  for (const item of items) {
    const price      = parseFloat(item.price) || 0;
    const daysListed = item.first_seen_at ? Math.floor((now - new Date(item.first_seen_at).getTime()) / 86400000) : 0;
    const stale      = daysListed >= STALE_LISTING_DAYS;
    let score = null, suggested_price = null, tips = [];
    try {
      const raw = await callAI(
        'You are Vendora\'s Vinted listing analyst. Return ONLY a JSON object: {"score": <0-100 listing quality>, "suggested_price": <number, a realistic price to sell faster — may equal current price if already good>, "tips": ["<specific tip>", "<specific tip>"]}. Tips must be concrete (exact title words, price points, photo/description fixes). No markdown.',
        `Title: ${item.title || '—'}\nCurrent price: £${price.toFixed(2)}\nDays listed: ${daysListed}\nBrand: ${item.brand || '—'}\nCondition: ${item.condition || '—'}`,
        'claude-haiku-4-5-20251001',
        300,
      );
      const j = JSON.parse((raw || '{}').replace(/^```json?\s*/, '').replace(/\s*```$/, ''));
      score = typeof j.score === 'number' ? j.score : null;
      suggested_price = typeof j.suggested_price === 'number' ? j.suggested_price : null;
      tips = Array.isArray(j.tips) ? j.tips.slice(0, 3) : [];
    } catch (e) { /* skip item on parse/AI error */ }

    results.push({
      id: item.id, title: item.title || '(untitled)', url: item.url || null,
      price, days_listed: daysListed, stale, score, suggested_price, tips,
    });
    await new Promise(r => setTimeout(r, 400));
  }

  results.sort((a, b) => (a.score ?? 101) - (b.score ?? 101)); // worst first
  await saveSetting(`inventory_analysis_${user.id}`, { items: results, generated_at: new Date().toISOString() });
  res.json({ ok: true, analysed: results.length, items: results });
});

// ── Avatar refresh ─────────────────────────────────────────────────────────────
app.get('/api/user/avatar', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  try {
    const discordId = user.user_metadata?.provider_id
      || user.identities?.find(i => i.provider === 'discord')?.id || '';
    if (!discordId) return res.status(400).json({ error: 'No Discord ID' });

    const discordUser = await client.users.fetch(discordId, { force: true }).catch(() => null);
    if (!discordUser) return res.json({ ok: true, avatarUrl: null });

    const avatarUrl = discordUser.displayAvatarURL({ size: 256, extension: 'png' });

    // Update Supabase profile
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ avatar_url: avatarUrl }),
    });

    res.json({ ok: true, avatarUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[http] Listening on port ${PORT}`));

// Initialise version — seed live only if it has never been set; NEVER auto-seed staged
(async () => {
  try {
    const live = await getSetting('app_version_live');
    if (!live) {
      await saveSetting('app_version_live', { version: '6.1', short: 'v6.1', builtAt: '2026-05-14' });
      console.log('[version] Initialised app_version_live = 6.1');
    }
    // Clean up any stale staged entry that was auto-seeded with the same version as live.
    // This prevents the "publish loop" where the staged toast reappears every bot restart.
    const currentLive = await getSetting('app_version_live');
    const staged = await getSetting('app_version_staged');
    if (staged && staged.version === currentLive?.version) {
      await saveSetting('app_version_staged', null);
      console.log('[version] Cleared stale staged entry — matches live, nothing to approve');
    }
  } catch(e) { console.warn('[version] init error:', e.message); }
})();

if (TOKEN) {
  client.login(TOKEN).catch(err => console.error('[discord] Login failed:', err.message));
} else {
  console.error('[discord] Cannot login — DISCORD_BOT_TOKEN missing');
}
