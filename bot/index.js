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

// Residential proxy support for Vinted (DataDome blocks datacenter IPs)
// We import undici's OWN fetch — Node's global fetch silently ignores `dispatcher`.
let ProxyAgent, undFetch;
try { ({ ProxyAgent, fetch: undFetch } = require('undici')); }
catch (e) { console.warn('[proxy] undici unavailable — proxy will be disabled:', e.message); }

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
const PROXY_URL        = process.env.PROXY_URL; // optional residential proxy e.g. http://user:pass@host:port

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
    PROXY_AGENT = new ProxyAgent({
      uri: PROXY_URL,
      connect: { ciphers: CHROME_CIPHERS, sigalgs: CHROME_SIGALGS },
    });
    console.log('[proxy] Proxy agent ready (Chrome TLS) — Vinted requests will route through residential proxy');
  } catch (e) {
    console.error('[proxy] Failed to create ProxyAgent:', e.message);
  }
} else if (PROXY_URL && !ProxyAgent) {
  console.warn('[proxy] PROXY_URL is set but undici ProxyAgent failed to load — proxy DISABLED');
}

const PORT            = process.env.PORT || 3000;
const OWNER_ID       = '731207920007643167';
const DASHBOARD_URL  = 'https://vendora-vv.netlify.app/vendora-dashboard';
const SITE_URL       = 'https://vendora-vv.netlify.app';

console.log('[boot] Config — GUILD_ID:', GUILD_ID, '| PORT:', PORT);
if (!TOKEN)         console.warn('[warn] DISCORD_BOT_TOKEN not set');
if (!GUILD_ID)      console.warn('[warn] DISCORD_GUILD_ID not set');
if (!SUPABASE_KEY)  console.warn('[warn] SUPABASE_SERVICE_KEY not set');
if (!ANTHROPIC_KEY)    console.warn('[warn] ANTHROPIC_API_KEY not set — AI commands will fail');
if (!OPENAI_KEY)       console.warn('[warn] OPENAI_API_KEY not set — AI photo enhancement will fail');
if (!PHOTOROOM_KEY)    console.warn('[warn] PHOTOROOM_API_KEY not set — PhotoRoom enhancement will fail');
if (!PAYPAL_CLIENT_ID) console.warn('[warn] PAYPAL_CLIENT_ID not set — credit purchases will fail');
if (!PAYPAL_SECRET)    console.warn('[warn] PAYPAL_CLIENT_SECRET not set — credit purchases will fail');

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
  flip: 'flip',
};
const CMD_TIER_REQUIRED = {
  scan: 'pro', research: 'pro', margins: 'pro',
  pricedrop: 'pro', trends: 'pro', tracker: 'pro', sold: 'pro', competitor: 'pro',
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

async function searchVinted(query) {
  try {
    const url = `https://www.vinted.co.uk/api/v2/catalog/items?search_text=${encodeURIComponent(query)}&per_page=12&order=newest_first`;
    const res = await fetch(url, vintedProxyOpts({
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }));
    if (!res.ok) return null;
    const data = await res.json();
    return (data.items || []).map(i => ({
      title:    i.title || '',
      price:    i.total_item_price ? `£${i.total_item_price.amount}` : '—',
      url:      i.url || '',
      brand:    i.brand_title || '',
      condition: i.status || '',
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
  new SlashCommandBuilder().setName('analytics').setDescription('Full sales analytics summary [Elite]'),
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
      await dbAddWatchlist(user.id, rawUrl);
      const wl = await dbGetWatchlist(user.id);

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

    // Fetch real account data
    const discordId = user.id;
    let realCtx = '';

    // Get listing data from Supabase
    try {
      const [listingsRes, profileRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/listings?user_id=eq.${profile?.id || 'none'}&status=eq.active&select=*`, {
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        }).catch(() => null),
        fetch(`${SUPABASE_URL}/rest/v1/profiles?discord_id=eq.${discordId}&select=*`, {
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        }).catch(() => null),
      ]);

      const listings = listingsRes?.ok ? (await listingsRes.json()) : [];
      const profData  = profileRes?.ok  ? (await profileRes.json())?.[0] : null;

      const activeCount = listings.length;
      const platforms   = [...new Set((listings.flatMap(l => l.platforms || [])))];
      const cmdToday    = profData?.commands_used_today || {};
      const totalCmds   = Object.values(cmdToday).reduce((a, b) => a + (b?.count || 0), 0);
      const tier        = profile?.tier || 'unknown';
      const since       = profData?.created_at ? new Date(profData.created_at).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'unknown';

      // Watchlist + inventory counts
      const [wlRes, invRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/watchlist?discord_id=eq.${discordId}&select=id`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }).catch(() => null),
        fetch(`${SUPABASE_URL}/rest/v1/inventory?discord_id=eq.${discordId}&select=id`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }).catch(() => null),
      ]);
      const wlCount  = wlRes?.ok  ? (await wlRes.json()).length  : 0;
      const invCount = invRes?.ok ? (await invRes.json()).length : 0;

      realCtx = `REAL ACCOUNT DATA for Discord user ${discordId}:\n` +
        `- Subscription: ${tier} (since ${since})\n` +
        `- Active listings on Vendora: ${activeCount}${platforms.length ? ` (on ${platforms.join(', ')})` : ''}\n` +
        `- Watchlist items: ${wlCount}\n` +
        `- Inventory tracker items: ${invCount}\n` +
        `- Bot commands used today: ${totalCmds}\n\n` +
        `Note: full cross-platform sales data requires platform API integration. Provide insights from the available data.`;
    } catch (e) {
      realCtx = 'Could not retrieve full account data. Provide general analytics advice.';
    }

    const text = await callAI(
      `You are Vendora's analytics system for a UK reseller on the ${profile?.tier || 'Pro'} plan.\n\n${realCtx}\n\nProvide a concise analytics summary with: their current reselling footprint from the data, what these numbers suggest about their activity level, 3 specific actionable insights to improve their results, and what features they should be using more given their tier.`,
      'Generate my analytics summary.',
      'claude-haiku-4-5-20251001', 700
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121').setTitle('Analytics Summary — Elite')
        .setDescription(text.slice(0, 4000))
        .setFooter({ text: 'Based on your Vendora account data' })
    ]});
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
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://vendora-vv.netlify.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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

// GET /api/inventory — fetch all items for the authenticated user
app.get('/api/inventory', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = discordIdFromUser(user);
  if (!discordId) return res.status(400).json({ error: 'Discord ID not found' });
  const items = await dbGetInventory(discordId);
  return res.json({ ok: true, items });
});

// POST /api/inventory — add an item, return full updated list
app.post('/api/inventory', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = discordIdFromUser(user);
  if (!discordId) return res.status(400).json({ error: 'Discord ID not found' });
  const { item } = req.body || {};
  if (!item?.trim()) return res.status(400).json({ error: 'Item name required' });
  const result = await dbAddInventory(discordId, item.trim());
  if (result?.error) return res.status(500).json({ error: result.error });
  const items = await dbGetInventory(discordId);
  return res.json({ ok: true, items });
});

// DELETE /api/inventory/:id — remove a specific item by its Supabase row ID
app.delete('/api/inventory/:id', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = discordIdFromUser(user);
  if (!discordId) return res.status(400).json({ error: 'Discord ID not found' });
  // Verify the item belongs to this user before deleting
  const items = await dbGetInventory(discordId);
  const owns = items.some(i => String(i.id) === String(req.params.id));
  if (!owns) return res.status(403).json({ error: 'Not your item' });
  await dbRemoveInventory(req.params.id);
  return res.json({ ok: true });
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
  try {
    const [ivHex, tagHex, dataHex] = enc.split(':');
    const iv      = Buffer.from(ivHex, 'hex');
    const tag     = Buffer.from(tagHex, 'hex');
    const data    = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch { return enc; }
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
    const res  = await fetch(`${SUPABASE_URL}/rest/v1/platform_connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({ user_id: userId, platform, ...data }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[upsertPlatformConn] ${platform} HTTP ${res.status}:`, text.slice(0, 200));
      return { error: `Database error (${res.status}): ${text.slice(0, 100)}` };
    }
    return { ok: true };
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
async function getVintedSession() {
  const base = await getVintedBase();
  let cookies = '';
  try {
    const r = await vFetch(`${base}/`, {
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
  try {
    const BASE_HEADERS = {
      'User-Agent': VINTED_UA,
      'Accept-Language': 'en-GB,en;q=0.9',
      'Origin': 'https://www.vinted.co.uk',
      'Referer': 'https://www.vinted.co.uk/',
    };

    // Step 1: Detect geo base + get fresh DataDome session cookies + CSRF token.
    const { base: vintedBase, cookies: bootstrapCookies } = await getVintedSession();
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

    const res = await vFetch(`${vintedBase}/api/v2/sessions`, {
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
async function vintedUploadImage(accessToken, base64Data, mimeType = 'image/jpeg') {
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
    const res = await vFetch(`${vintedBase}/api/v2/photos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': VINTED_UA,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Accept': 'application/json',
        'Origin': 'https://www.vinted.co.uk',
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { const e = await res.text(); return { error: `Vinted image upload failed: ${e.slice(0, 80)}` }; }
    const data = await res.json();
    return { photo_id: data.id || data.photo?.id };
  } catch (e) { return { error: e.message }; }
}

async function vintedCreateListing(accessToken, listingData) {
  const {
    title, description = '', price, condition, photo_ids = [],
    brand = '', size = '',
    vinted_catalog_id = null, vinted_package_size_id = 2,
  } = listingData;
  const condMap = { 'New with tags': 6, 'Like New': 2, 'Very Good': 3, 'Good': 4, 'Acceptable': 5 };
  try {
    // ── Step 1: Detect geo base + fresh DataDome session cookies ─────────────
    // Must post to same domain the cookies were issued for.
    const { base: vintedBase, cookies: sessionCookieStr } = await getVintedSession();
    console.log(`[vinted-list] base=${vintedBase} cookies=${sessionCookieStr.split(';').length}`);

    // ── Step 2: Build the listing body ────────────────────────────────────────
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

    // ── Step 3: POST to the CORRECT geo domain with session cookies ───────────
    const listingHeaders = {
      ...VINTED_HEADERS(accessToken, vintedBase),
      ...(sessionCookieStr && { 'Cookie': sessionCookieStr }),
    };

    const res = await vFetch(`${vintedBase}/api/v2/items`, {
      method: 'POST',
      headers: listingHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[vinted-list] HTTP ${res.status} base=${vintedBase} proxy=${!!PROXY_AGENT}:`, err.slice(0, 400));

      // DataDome challenge
      if (err.includes('captcha-delivery.com') || err.includes('datadome')) {
        return { error: `Vinted bot-protection triggered on ${vintedBase}. Check Railway logs for details.` };
      }
      // Explicit Vinted auth failure (message_code in response body, not just HTTP status)
      if (err.includes('"unauthenticated"') || err.includes('"invalid_auth_token"')) {
        return { error: 'Your Vinted session token has expired. Reconnect your Vinted account in the dashboard.' };
      }
      // Everything else — show the real error so the user knows what's happening
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
  try {
    const vintedBase = await getVintedBase();
    const r = await vFetch(`${vintedBase}/api/v2/users/me`, {
      headers: VINTED_HEADERS(token),
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      // HTML = DataDome blocked the validation request
      if (text.includes('captcha-delivery.com') || text.includes('datadome') || text.startsWith('<!')) {
        return { valid: null, warning: 'Could not validate token server-side (bot-protection on this endpoint). Token saved — it will fail with a clear error if incorrect when you list.' };
      }
      return { valid: false, error: 'Unexpected response from Vinted — token may be invalid.' };
    }
    if (!r.ok) {
      // DataDome challenge returns JSON like {"url":"https://geo.captcha-delivery.com/..."}
      // Must check this BEFORE treating it as an auth error.
      if (data?.url?.includes('captcha-delivery.com') || data?.url?.includes('datadome')) {
        return { valid: null, warning: 'Could not validate token server-side (bot-protection on this endpoint). Token saved — it will fail with a clear error if incorrect when you list.' };
      }
      const code = data?.message_code || data?.error || '';
      if (r.status === 401 || code.includes('unauthenticated') || code.includes('invalid_auth')) {
        return { valid: false, error: 'Token is invalid or expired. Make sure you copied the full `access_token` value from your Vinted browser cookies.' };
      }
      // Any other non-OK response — don't block the save, just warn
      return { valid: null, warning: `Vinted returned ${r.status} during validation — token saved, test by attempting a listing.` };
    }
    const u = data.user || data;
    return { valid: true, username: u.login || u.username || '', user_id: String(u.id || '') };
  } catch (e) {
    return { valid: null, warning: `Could not reach Vinted to validate token (${e.message}). Token saved — test by attempting a listing.` };
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
  if (!conn?.access_token) return { error: 'Not connected — link your account in the dashboard first.' };
  const token = decryptToken(conn.access_token);
  if (!token) return { error: 'Could not decrypt stored token — reconnect your account in the dashboard.' };

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
  });

  if (!saveResult.ok) {
    console.error(`[platform] upsert failed for ${platform} / user ${user.id}:`, saveResult.error);
    return res.status(500).json({ error: saveResult.error || 'Failed to save connection. Please try again.' });
  }

  console.log(`[platform] ${platform} connected for user ${user.id} (@${result.platform_username}) mode:${manual_token ? 'manual' : 'credentials'}`);
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

// Get connection status for all platforms
app.get('/api/platform/status', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const platforms = ['depop', 'vinted', 'ebay'];
  const connections = {};
  for (const p of platforms) {
    const conn = await getPlatformConn(user.id, p);
    connections[p] = conn
      ? { connected: true, username: conn.platform_username, connected_at: conn.connected_at }
      : { connected: false };
  }
  res.json({ ok: true, connections });
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

// ── Inventory endpoints ────────────────────────────────────────────────────────
app.get('/api/inventory', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';
  const items = await dbGetInventory(discordId);
  res.json({ items });
});

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
app.get('/api/watchlist', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';
  const items = await dbGetWatchlist(discordId);
  res.json({ items });
});

app.post('/api/watchlist', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const discordId = user.user_metadata?.provider_id
    || user.identities?.find(i => i.provider === 'discord')?.id || '';
  const { item } = req.body || {};
  if (!item?.trim()) return res.status(400).json({ error: 'item required' });
  await dbAddWatchlist(discordId, item.trim());
  const items = await dbGetWatchlist(discordId);
  res.json({ ok: true, items });
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

// ── Price drop watchlist cron — runs every 6 hours ───────────────────────────
// Checks live Depop + Vinted prices for all watched items, DMs users when a
// significant drop is detected (≥10% below their stored baseline).
cron.schedule('0 */6 * * *', async () => {
  console.log('[cron:watchlist] Starting live price-drop check...');
  if (!SUPABASE_KEY) return;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/watchlist?select=*&order=added_at.asc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const items = await r.json();
    if (!items?.length) { console.log('[cron:watchlist] No watchlist items.'); return; }

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
          // ── URL-based item: re-scrape the product page ──────────────────────
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

          // Find per-variant drops ≥10%
          for (const v of product.variants) {
            const baseline = (stored.variants || []).find(sv => sv.size === v.size)?.price || stored.baseline;
            if (!baseline) continue;
            const pct = ((baseline - v.price) / baseline) * 100;
            if (pct >= 10) dropVariants.push({ size: v.size, price: v.price, baseline, pct });
          }

          // Update stored data
          baselines[wl.id] = { ...stored, productName: product.name, lowestSeen: Math.min(currentLow, stored.lowestSeen || currentLow), variants: product.variants, checkedAt: new Date().toISOString() };

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
    console.log(`[cron:watchlist] Done. Checked ${checkedCount}/${items.length} items, sent ${alertCount} alerts.`);
  } catch (e) {
    console.error('[cron:watchlist] Fatal error:', e.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[http] Listening on port ${PORT}`));

if (TOKEN) {
  client.login(TOKEN).catch(err => console.error('[discord] Login failed:', err.message));
} else {
  console.error('[discord] Cannot login — DISCORD_BOT_TOKEN missing');
}
