process.on('uncaughtException',  err => console.error('[crash] uncaughtException:', err));
process.on('unhandledRejection', err => console.error('[crash] unhandledRejection:', err));

console.log('[boot] Loading modules...');

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ChannelType,
  PermissionFlagsBits, PermissionsBitField,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
} = require('discord.js');
const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cron     = require('node-cron');
const crypto   = require('crypto');

console.log('[boot] Modules loaded');

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID       = process.env.DISCORD_GUILD_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://fqfanqtybvnurhzkoxwr.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const BRAVE_KEY       = process.env.BRAVE_SEARCH_API_KEY;
const REMOVE_BG_KEY   = process.env.REMOVE_BG_API_KEY;
const PORT            = process.env.PORT || 3000;
const OWNER_ID       = '731207920007643167';
const DASHBOARD_URL  = 'https://vendora-vv.netlify.app/vendora-dashboard';
const SITE_URL       = 'https://vendora-vv.netlify.app';

console.log('[boot] Config — GUILD_ID:', GUILD_ID, '| PORT:', PORT);
if (!TOKEN)         console.warn('[warn] DISCORD_BOT_TOKEN not set');
if (!GUILD_ID)      console.warn('[warn] DISCORD_GUILD_ID not set');
if (!SUPABASE_KEY)  console.warn('[warn] SUPABASE_SERVICE_KEY not set');
if (!ANTHROPIC_KEY) console.warn('[warn] ANTHROPIC_API_KEY not set — AI commands will fail');

// ── Anthropic ─────────────────────────────────────────────────────────────────
const ai = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
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
  crosslist: { basic: 5,  pro: 30,  elite: Infinity },
  flip:      { basic: 0,  pro: 0,   elite: 20       },
  default:   { basic: 10, pro: 50,  elite: Infinity },
};
const CMD_RATE_GROUP = {
  scan: 'scan', research: 'research', margins: 'research',
  sold: 'research', competitor: 'research', trends: 'research',
  reply: 'reply', lowball: 'reply', price: 'reply',
  crosslist: 'crosslist', pricedrop: 'crosslist',
  flip: 'flip',
};
const CMD_TIER_REQUIRED = {
  scan: 'pro', research: 'pro', margins: 'pro', crosslist: 'pro',
  pricedrop: 'pro', trends: 'pro', tracker: 'pro', sold: 'pro', competitor: 'pro',
  flip: 'elite', analytics: 'elite', earlydeals: 'elite',
  negotiate: 'elite', authenticate: 'elite', grade: 'elite',
};

// ── Bot feature toggles (defaults — overwritten by Supabase on boot) ──────────
const BOT_TOGGLES = {
  bot_online:         true,
  session_auto_delete: true,
  join_dm:            true,
  share_detection:    true,
};

// In-memory rate limit store: Map<discordId, Map<group, { count, resetAt }>>
const usageStore = new Map();

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
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
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
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
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

function formatWebResults(results) {
  if (!results?.length) return '';
  return results.slice(0, 5).map(r =>
    `• ${r.title}: ${r.description.slice(0, 120)}`
  ).join('\n');
}

async function searchDepopSeller(username) {
  try {
    const BASE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' };
    const userRes = await fetch(`https://api.depop.com/api/v1/users/${encodeURIComponent(username)}/`, {
      headers: BASE_HEADERS, signal: AbortSignal.timeout(8000),
    });
    if (!userRes.ok) return null;
    const user = await userRes.json();
    const uid  = user.id;
    if (!uid) return null;
    const prodRes = await fetch(`https://api.depop.com/api/v1/users/${uid}/products/?offset=0&limit=12`, {
      headers: BASE_HEADERS, signal: AbortSignal.timeout(8000),
    });
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
    const userRes = await fetch(`https://www.vinted.co.uk/api/v2/users?login=${encodeURIComponent(username)}&per_page=1`, {
      headers: BASE_HEADERS, signal: AbortSignal.timeout(8000),
    });
    if (!userRes.ok) return null;
    const userData = await userRes.json();
    const user = userData.users?.[0];
    if (!user) return null;
    const itemsRes = await fetch(`https://www.vinted.co.uk/api/v2/users/${user.id}/items?per_page=12`, {
      headers: BASE_HEADERS, signal: AbortSignal.timeout(8000),
    });
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
  new SlashCommandBuilder().setName('crosslist').setDescription('Generate optimised copy-ready listings for Depop, Vinted & eBay [Pro+]')
    .addStringOption(o => o.setName('item').setDescription('Item name (e.g. Nike Air Max 90 White UK9)').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Extra details — size, colour, defects etc.').setRequired(false))
    .addNumberOption(o => o.setName('price').setDescription('Your asking price in £').setRequired(false))
    .addStringOption(o => o.setName('condition').setDescription('Item condition').setRequired(false)
      .addChoices(
        { name: 'New with tags', value: 'New with tags' },
        { name: 'Like New', value: 'Like New' },
        { name: 'Very Good', value: 'Very Good' },
        { name: 'Good', value: 'Good' },
        { name: 'Acceptable', value: 'Acceptable' }
      )),
  new SlashCommandBuilder().setName('pricedrop').setDescription('Set a price drop watchlist alert [Pro+]')
    .addStringOption(o => o.setName('item').setDescription('Item to watch').setRequired(true)),
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
  new SlashCommandBuilder().setName('authenticate').setDescription('Authenticity red flag check [Elite]')
    .addStringOption(o => o.setName('item').setDescription('Item description to check').setRequired(true)),
  new SlashCommandBuilder().setName('grade').setDescription('Grade item condition from a photo [Elite]')
    .addAttachmentOption(o => o.setName('photo').setDescription('Photo of the item').setRequired(true)),
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
    const proCmds   = '`/scan` `/research` `/margins` `/crosslist` `/pricedrop` `/trends` `/tracker` `/sold` `/competitor`';
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

    // Check bot has ManageChannels permission
    const botMember = guild.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply({ embeds: [
        baseEmbed('#f87171').setTitle('Missing Permission')
          .setDescription('The bot needs the **Manage Channels** permission in this server to create session channels. Please contact the server owner.')
      ]});
    }

    try {
      // Re-fetch channels to ensure cache is current
      await guild.channels.fetch();
      const category = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes('VENDORA')
      );

      const channelName = `session-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}-${Date.now().toString(36).slice(-4)}`;
      const ownerMember = await guild.members.fetch(OWNER_ID).catch(() => null);
      const permOverwrites = [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
      ];
      if (ownerMember) {
        permOverwrites.push({ id: OWNER_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category?.id || null,
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
    const item = opts.getString('item');
    await dbAddWatchlist(interaction.user.id, item);
    const wl = await dbGetWatchlist(interaction.user.id);
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle('Price Drop Alert Set')
        .setDescription(`You'll be alerted when **${item}** drops in price.\n\nWatchlist total: **${wl.length}** item${wl.length !== 1 ? 's' : ''}\n\n*Live price monitoring coming soon. Your item is saved and will alert you once platform scanning is live.*`)
    ]});
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

    // Fetch live prices from Depop + Vinted in parallel
    const [depopResults, vintedResults] = await Promise.all([
      searchDepop(item),
      searchVinted(item),
    ]);

    // Extract real prices
    const extractPrices = (results) =>
      (results || [])
        .map(r => parseFloat((r.price || '').replace('£', '')))
        .filter(p => !isNaN(p) && p > 0);

    const depopPrices  = extractPrices(depopResults);
    const vintedPrices = extractPrices(vintedResults);
    const allPrices    = [...depopPrices, ...vintedPrices].sort((a, b) => a - b);

    let liveContext = '';
    if (allPrices.length >= 3) {
      const low  = allPrices[0].toFixed(2);
      const high = allPrices[allPrices.length - 1].toFixed(2);
      const avg  = (allPrices.reduce((a, b) => a + b, 0) / allPrices.length).toFixed(2);
      const depopAvg  = depopPrices.length  ? `£${(depopPrices.reduce((a,b)=>a+b,0)/depopPrices.length).toFixed(2)}`   : 'n/a';
      const vintedAvg = vintedPrices.length ? `£${(vintedPrices.reduce((a,b)=>a+b,0)/vintedPrices.length).toFixed(2)}` : 'n/a';
      liveContext = `LIVE PLATFORM DATA (${allPrices.length} listings scraped right now):\n` +
        `- Depop: ${depopPrices.length} listings, avg ${depopAvg}\n` +
        `- Vinted: ${vintedPrices.length} listings, avg ${vintedAvg}\n` +
        `- Overall range: £${low}–£${high}, avg £${avg}\n\n` +
        `Use this real data as your primary source. Be very specific with your estimates based on it.`;
    } else {
      liveContext = `Live platform data unavailable or too few results (${allPrices.length} found). Use your UK resale market knowledge to estimate.`;
    }

    const text = await callAI(
      `You are Vendora, a UK resale market analyst. Your job is to give an accurate, actionable price check.\n\n${liveContext}\n\nProvide: 1) Current resale price range on Depop and Vinted, 2) A good buy price to flip profitably, 3) Rough margin after platform fees (~10% Depop, ~5% Vinted), 4) One sentence on current demand. Keep it to 5 lines max. Use £ figures throughout.`,
      `Item: ${item}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const footerText = allPrices.length >= 3
      ? `Based on ${allPrices.length} live listings from Depop + Vinted`
      : 'Vendora AI estimate — live data temporarily unavailable';
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Price Check — ${item}`).setDescription(text.slice(0, 4000))
        .setFooter({ text: footerText })
    ]});
  }

  if (commandName === 'scan') {
    const platform     = opts.getString('platform');
    const item         = opts.getString('item');
    const platformNames = { ebay: 'eBay', depop: 'Depop', vinted: 'Vinted' };

    let results = null;
    if (platform === 'depop')  results = await searchDepop(item);
    if (platform === 'vinted') results = await searchVinted(item);
    if (platform === 'ebay')   results = await searchEbay(item);

    const formatted = results ? formatPlatformResults(results, platformNames[platform]) : null;

    if (formatted) {
      // Real data — find the cheapest few to surface deals
      const prices = (results || [])
        .map(r => parseFloat(r.price.replace('£', '')))
        .filter(p => !isNaN(p))
        .sort((a, b) => a - b);
      const cheapest = prices[0] ? `£${prices[0].toFixed(2)}` : '—';
      const avg      = prices.length ? `£${(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)}` : '—';

      return interaction.editReply({ embeds: [
        baseEmbed().setTitle(`Scan — ${item} on ${platformNames[platform]}`)
          .setDescription(formatted)
          .addFields(
            { name: 'Lowest Listed', value: cheapest, inline: true },
            { name: 'Average Price', value: avg, inline: true },
            { name: 'Results',       value: `${results.length} listings found`, inline: true }
          )
      ]});
    }

    // Fallback: AI analysis if platform API unavailable
    const text = await callAI(
      `You are Vendora's product research engine. Analyse ${platformNames[platform]} for the given item. Include: typical listing price range, what "underpriced" looks like (specific £ threshold), best search terms to find deals, current demand level, and 3-5 types of listings to target.${platform === 'ebay' && !process.env.EBAY_APP_ID ? ' Note: live eBay data coming soon.' : ''}`,
      `Platform: ${platformNames[platform]}\nItem: ${item}`,
      'claude-haiku-4-5-20251001', 900
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Scan — ${item} on ${platformNames[platform]}`)
        .setDescription(text.slice(0, 4000))
        .setFooter({ text: platform === 'ebay' && !process.env.EBAY_APP_ID ? 'Vendora AI estimate — eBay live data activating soon' : 'Vendora AI estimate — live data temporarily unavailable' })
    ]});
  }

  if (commandName === 'research') {
    const item = opts.getString('item');
    const [depopR, vintedR, ebayR, webR] = await Promise.all([
      searchDepop(item), searchVinted(item), searchEbay(item),
      webSearch(`${item} resale price UK site:depop.com OR site:vinted.co.uk OR site:ebay.co.uk`, 5),
    ]);

    const extractP = (r) => (r || []).map(x => parseFloat((x.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);
    const depopPrices = extractP(depopR), vintedPrices = extractP(vintedR), ebayPrices = extractP(ebayR);
    const allPrices   = [...depopPrices, ...vintedPrices, ...ebayPrices].sort((a, b) => a - b);

    let liveCtx = 'No live data retrieved — using market knowledge.';
    if (allPrices.length >= 3) {
      const avg = (allPrices.reduce((a, b) => a + b, 0) / allPrices.length).toFixed(2);
      const low = allPrices[0].toFixed(2), high = allPrices[allPrices.length - 1].toFixed(2);
      const dAvg = depopPrices.length  ? `£${(depopPrices.reduce((a,b)=>a+b,0)/depopPrices.length).toFixed(2)}`  : 'n/a';
      const vAvg = vintedPrices.length ? `£${(vintedPrices.reduce((a,b)=>a+b,0)/vintedPrices.length).toFixed(2)}` : 'n/a';
      const eAvg = ebayPrices.length   ? `£${(ebayPrices.reduce((a,b)=>a+b,0)/ebayPrices.length).toFixed(2)}`    : 'n/a';
      liveCtx = `LIVE DATA (${allPrices.length} listings scraped now):\n` +
        `- Depop: ${depopPrices.length} listings, avg ${dAvg}\n` +
        `- Vinted: ${vintedPrices.length} listings, avg ${vAvg}\n` +
        `- eBay: ${ebayPrices.length} listings, avg ${eAvg}\n` +
        `- Overall range: £${low}–£${high}, avg £${avg}\n\n` +
        `Use this as your primary data source. Reference specific £ figures in your report.`;
    }

    const webCtx = webR?.length ? `\nWEB SEARCH RESULTS (latest context from the web):\n${formatWebResults(webR)}\n` : '';

    const text = await callAI(
      `You are Vendora's research engine. Provide a comprehensive UK resale research report grounded in the live data provided.\n\n${liveCtx}${webCtx}\n\nStructure:\n**Market Overview** — buy/sell price range with specific £ figures\n**Best Platforms** — where this sells best and why\n**Key Search Terms** — what to search for deals\n**Demand Level** — High/Medium/Low with reasoning\n**Margin Estimate** — specific buy price target, sell price, net profit after fees\n**Sourcing Tips** — 3 actionable tips`,
      `Item: ${item}`,
      'claude-sonnet-4-6', 1200
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const sources = [allPrices.length >= 3 ? `${allPrices.length} live listings` : null, webR?.length ? 'web search' : null].filter(Boolean);
    const footer = sources.length ? `Sources: ${sources.join(' + ')}` : 'AI market knowledge — live data unavailable';
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Research Report — ${item}`).setDescription(text.slice(0, 4000)).setFooter({ text: footer })
    ]});
  }

  if (commandName === 'margins') {
    const item = opts.getString('item');
    const [depopR, vintedR] = await Promise.all([searchDepop(item), searchVinted(item)]);

    const extractP = (r) => (r || []).map(x => parseFloat((x.price || '').replace('£', ''))).filter(p => !isNaN(p) && p > 0);
    const depopP = extractP(depopR), vintedP = extractP(vintedR);
    const all    = [...depopP, ...vintedP].sort((a, b) => a - b);

    let liveCtx = '';
    let preCalc = '';
    if (all.length >= 3) {
      const avg  = all.reduce((a, b) => a + b, 0) / all.length;
      const low  = all[0], high = all[all.length - 1];
      const targetBuy    = (avg * 0.55).toFixed(2);
      const depopSell    = (depopP.length ? depopP.reduce((a,b)=>a+b,0)/depopP.length : avg).toFixed(2);
      const vintedSell   = (vintedP.length ? vintedP.reduce((a,b)=>a+b,0)/vintedP.length : avg).toFixed(2);
      const depopFee     = (parseFloat(depopSell) * 0.10).toFixed(2);
      const vintedFee    = (parseFloat(vintedSell) * 0.05).toFixed(2);
      const shipping     = 3.50;
      const depopProfit  = (parseFloat(depopSell) - parseFloat(targetBuy) - parseFloat(depopFee) - shipping).toFixed(2);
      const vintedProfit = (parseFloat(vintedSell) - parseFloat(targetBuy) - parseFloat(vintedFee) - shipping).toFixed(2);
      const depopROI     = ((parseFloat(depopProfit) / parseFloat(targetBuy)) * 100).toFixed(0);
      const vintedROI    = ((parseFloat(vintedProfit) / parseFloat(targetBuy)) * 100).toFixed(0);

      liveCtx = `LIVE DATA (${all.length} listings):\n- Price range: £${low.toFixed(2)}–£${high.toFixed(2)}, avg £${avg.toFixed(2)}\n- Depop avg: £${depopSell}, Vinted avg: £${vintedSell}\n\n`;
      preCalc = `PRE-CALCULATED FIGURES (use these exactly):\n` +
        `- Suggested buy price: £${targetBuy} (55% of avg sell)\n` +
        `- Depop sell: £${depopSell} → fee £${depopFee} → profit £${depopProfit} (${depopROI}% ROI)\n` +
        `- Vinted sell: £${vintedSell} → fee £${vintedFee} → profit £${vintedProfit} (${vintedROI}% ROI)\n` +
        `- Shipping estimate: £${shipping}`;
    }

    const text = await callAI(
      `You are Vendora's margin calculator. ${liveCtx}${preCalc}\n\nUsing the data above, provide a clear profit breakdown covering: buy price target, sell price per platform, all fees (Depop 10%, Vinted 5%), shipping, net profit, ROI. Use the pre-calculated figures if provided. End with a one-line verdict on whether this flip is worth it.`,
      `Item: ${item}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const footer = all.length >= 3 ? `Based on ${all.length} live listings` : 'AI estimate — live data unavailable';
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Margin Breakdown — ${item}`).setDescription(text.slice(0, 4000)).setFooter({ text: footer })
    ]});
  }

  if (commandName === 'crosslist') {
    if (!ai) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const item      = opts.getString('item');
    const desc      = opts.getString('description') || '';
    const price     = opts.getNumber('price') || null;
    const condition = opts.getString('condition') || '';

    const prompt = `Generate optimised cross-platform resale listings for all three platforms. Return ONLY valid JSON, no markdown, no explanation.

Item: ${item}${desc ? `\nDescription: ${desc}` : ''}${condition ? `\nCondition: ${condition}` : ''}${price ? `\nAsking price: £${price}` : ''}

Rules:
- depop: casual UK tone, title max 70 chars, 8-10 hashtags (words only, no #), suggest realistic GBP price if none given
- vinted: clean descriptive title, requires brand and size fields (estimate if unknown), suggest realistic price
- ebay: keyword-rich formal title max 80 chars, condition must be one of: New, Like New, Very Good, Good, Acceptable

Return this exact JSON structure:
{
  "depop":  { "title": "...", "description": "...", "price": 0, "hashtags": ["..."] },
  "vinted": { "title": "...", "description": "...", "price": 0, "brand": "...", "size": "..." },
  "ebay":   { "title": "...", "description": "...", "price": 0, "condition": "..." }
}`;

    let listings;
    try {
      const msg  = await ai.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1400, messages: [{ role: 'user', content: prompt }] });
      const text = msg.content[0].text;
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no json');
      listings = JSON.parse(match[0]);
    } catch {
      return interaction.editReply({ embeds: [
        baseEmbed('#f87171').setTitle('Cross-List Failed').setDescription('Could not generate listings. Please try again.')
      ]});
    }

    const d = listings.depop  || {};
    const v = listings.vinted || {};
    const e = listings.ebay   || {};

    return interaction.editReply({ embeds: [
      baseEmbed('#ff2300').setTitle(`Cross-List — ${item}`)
        .setDescription('Copy-ready listings for all three platforms 👇')
        .addFields(
          { name: '🔴 DEPOP', value: `**${d.title || '—'}**\n${d.description?.slice(0, 200) || ''}`, inline: false },
          { name: 'Depop Price', value: d.price ? `£${d.price}` : '—', inline: true },
          { name: 'Hashtags', value: d.hashtags ? d.hashtags.slice(0, 6).join(', ') : '—', inline: true },
          { name: '\u200B', value: '\u200B', inline: false },
          { name: '🟦 VINTED', value: `**${v.title || '—'}**\n${v.description?.slice(0, 200) || ''}`, inline: false },
          { name: 'Vinted Price', value: v.price ? `£${v.price}` : '—', inline: true },
          { name: 'Brand / Size', value: `${v.brand || '—'} / ${v.size || '—'}`, inline: true },
          { name: '\u200B', value: '\u200B', inline: false },
          { name: '🟡 EBAY', value: `**${e.title || '—'}**\n${e.description?.slice(0, 200) || ''}`, inline: false },
          { name: 'eBay Price', value: e.price ? `£${e.price}` : '—', inline: true },
          { name: 'Condition', value: e.condition || '—', inline: true }
        )
        .setFooter({ text: 'Vendora — Copy each section to the respective platform' })
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
    const [depopData, vintedData, webR] = await Promise.all([
      searchDepopSeller(seller), searchVintedSeller(seller),
      webSearch(`${seller} depop vinted reseller UK seller review`, 4),
    ]);

    let liveCtx = `No listings found for seller "${seller}" on Depop or Vinted. Providing strategic advice only.`;
    let foundOn = [];

    if (depopData?.products?.length) {
      foundOn.push('Depop');
      const prices = depopData.products.map(p => parseFloat(p.price.replace('£', ''))).filter(p => !isNaN(p));
      const avg = prices.length ? (prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : '?';
      const top5 = depopData.products.slice(0, 5).map(p => `${p.title.slice(0, 50)} — ${p.price}`).join('\n');
      liveCtx = `DEPOP — @${depopData.username}:\n- Followers: ${depopData.followers}, Total sold: ${depopData.totalListings}\n- Active listings shown: ${depopData.products.length}, avg price £${avg}\n- Current listings:\n${top5}\n`;
    }
    if (vintedData?.products?.length) {
      foundOn.push('Vinted');
      const prices = vintedData.products.map(p => parseFloat(p.price.replace('£', ''))).filter(p => !isNaN(p));
      const avg = prices.length ? (prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2) : '?';
      const top5 = vintedData.products.slice(0, 5).map(p => `${p.title.slice(0, 50)} — ${p.price}`).join('\n');
      liveCtx += `\nVINTED — @${vintedData.username}:\n- Followers: ${vintedData.followers}, Active items: ${vintedData.totalListings}\n- Listings shown: ${vintedData.products.length}, avg price £${avg}\n- Current listings:\n${top5}`;
    }

    const webCtx = webR?.length ? `\nWEB SEARCH (external mentions):\n${formatWebResults(webR)}\n` : '';
    const text = await callAI(
      `You are Vendora's competitor intelligence system. You have real seller and web data.\n\n${liveCtx}${webCtx}\n\nBased on all available data, provide:\n**Seller Profile** — what type of reseller this is (niche, budget, premium etc.)\n**Pricing Strategy** — how they price vs market average\n**What They Specialise In** — based on their actual listings\n**Counter Strategy** — how to position yourself against them\n**Watch For** — specific signals to monitor\n**Opportunity** — gaps in their inventory you could exploit`,
      `Seller to analyse: ${seller}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const footer = foundOn.length ? `Live data from ${foundOn.join(' + ')}` : 'Seller not found — strategic advice only';
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Competitor Profile — ${seller}`).setDescription(text.slice(0, 4000)).setFooter({ text: footer })
    ]});
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
    const item = opts.getString('item');
    const text = await callAI(
      'You are Vendora\'s authenticity expert for resale items. Analyse the provided item details for red flags indicating a potential fake. Include:\n**Risk Level** — Low/Medium/High/Critical\n**Red Flags Identified** — specific concerns from the description\n**Verify Before Buying** — what to physically check\n**Authentication Points** — key things to inspect\n**Price Assessment** — is the price suspicious?\n**Recommendation** — Buy / Proceed with Caution / Avoid',
      `Item details: ${item}`,
      'claude-haiku-4-5-20251001', 800
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121').setTitle('Authenticity Check').setDescription(text.slice(0, 4000))
        .addFields({ name: 'Item', value: item.slice(0, 200) })
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
  // Button interactions (spam marking etc.)
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('spam_')) {
      await handleSpamButton(interaction).catch(e => console.error('[button] spam handler error:', e.message));
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
app.use(express.json());

// CORS — allow dashboard to call bot API endpoints
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://vendora-vv.netlify.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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

// Supabase DB webhook — profile INSERT/UPDATE
app.post('/webhook', async (req, res) => {
  console.log('[webhook] Received from', req.ip);
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    console.warn('[webhook] Rejected — bad secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, record } = req.body || {};
  console.log('[webhook] type:', type, '| discord_id:', record?.discord_id, '| tier:', record?.tier, '| status:', record?.subscription_status);

  if (!record || !['INSERT', 'UPDATE'].includes(type)) return res.json({ ok: true, note: 'ignored' });

  const { discord_id, tier, subscription_status, username } = record;
  if (!discord_id) return res.json({ ok: true, note: 'no discord_id' });

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
            (TIER_RANK[tier] >= 2 ? '→ `/scan` `/research` `/margins` `/crosslist` and more\n' : '') +
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
  if (!SUPABASE_KEY) return { error: 'no key' };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/platform_connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({ user_id: userId, platform, ...data }),
    });
    return { ok: res.ok };
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
  const { title, description = '', price, condition, image_ids = [] } = listingData;
  const condMap = { 'New with tags': 1, 'Like New': 2, 'Very Good': 3, 'Good': 4, 'Acceptable': 5 };
  try {
    const body = {
      description: `${title}\n\n${description}`.trim(),
      price: Math.round(parseFloat(price) * 100),
      currency_name: 'GBP',
      category_id: 1,
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
const VINTED_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const VINTED_HEADERS = (token) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`,
  'User-Agent': VINTED_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Origin': 'https://www.vinted.co.uk',
  'Referer': 'https://www.vinted.co.uk/',
});

async function vintedLogin(usernameOrEmail, password) {
  try {
    const BASE_HEADERS = {
      'User-Agent': VINTED_UA,
      'Accept-Language': 'en-GB,en;q=0.9',
      'Origin': 'https://www.vinted.co.uk',
      'Referer': 'https://www.vinted.co.uk/',
    };

    // Step 1: Bootstrap a Vinted session to get cookies + real CSRF token.
    // Without this, Vinted returns an HTML challenge page instead of JSON.
    let cookieStr = '';
    let csrfToken = '';
    try {
      const initRes = await fetch('https://www.vinted.co.uk/', {
        headers: { ...BASE_HEADERS, 'Accept': 'text/html,application/xhtml+xml,*/*' },
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      const setCookies = initRes.headers.getSetCookie?.() || [];
      cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');
      const csrfCookie = setCookies.find(c => /csrf[-_]?token/i.test(c));
      if (csrfCookie) csrfToken = csrfCookie.split('=').slice(1).join('=').split(';')[0];
      console.log(`[vinted-login] bootstrap cookies: ${setCookies.length} found, csrf: ${!!csrfToken}`);
    } catch (e) {
      console.warn('[vinted-login] bootstrap failed (continuing anyway):', e.message);
    }

    // Step 2: POST credentials with session cookies + CSRF
    const loginHeaders = {
      ...BASE_HEADERS,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      ...(cookieStr && { 'Cookie': cookieStr }),
      ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
    };

    const res = await fetch('https://www.vinted.co.uk/api/v2/sessions', {
      method: 'POST',
      headers: loginHeaders,
      body: JSON.stringify({ login: usernameOrEmail, password, remember: true }),
      signal: AbortSignal.timeout(15000),
    });

    const rawText = await res.text();
    console.log(`[vinted-login] status: ${res.status} preview: ${rawText.slice(0, 200)}`);

    let data;
    try { data = JSON.parse(rawText); } catch {
      // Still HTML — Vinted bot protection active on this IP
      return { error: 'Vinted is blocking the connection from our server. This is a Cloudflare/bot-protection issue — not your credentials. Try again in a few minutes.' };
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
    const res = await fetch('https://www.vinted.co.uk/api/v2/photos', {
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
  const { title, description = '', price, condition, photo_ids = [] } = listingData;
  const condMap = { 'New with tags': 6, 'Like New': 2, 'Very Good': 3, 'Good': 4, 'Acceptable': 5 };
  try {
    const body = {
      title,
      description,
      price: String(parseFloat(price).toFixed(2)),
      currency: 'GBP',
      catalog_id: 1,
      status_id: condMap[condition] || 3,
      package_size_id: 1,
    };
    if (photo_ids.length) body.photos = photo_ids.map(id => ({ id }));

    const res = await fetch('https://www.vinted.co.uk/api/v2/items', {
      method: 'POST',
      headers: VINTED_HEADERS(accessToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = await res.text();
      return { error: `Vinted: ${err.slice(0, 120)}` };
    }
    const data = await res.json();
    const item = data.item || data;
    return { ok: true, listing_id: String(item.id || ''), url: item.url || `https://www.vinted.co.uk/items/${item.id}` };
  } catch (e) { return { error: e.message }; }
}

async function vintedDeleteListing(accessToken, listingId) {
  try {
    const res = await fetch(`https://www.vinted.co.uk/api/v2/items/${listingId}`, {
      method: 'DELETE',
      headers: VINTED_HEADERS(accessToken),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: res.ok || res.status === 204 };
  } catch (e) { return { error: e.message }; }
}

// ── Shared: upload images to one platform — returns platform-specific IDs ─────
async function uploadImagesToPlatform(token, platform, images = []) {
  // images: [{ base64, mimeType }]
  const ids = [];
  for (const img of images) {
    let r;
    if (platform === 'depop')  r = await depopUploadImage(token, img.base64, img.mimeType);
    if (platform === 'vinted') r = await vintedUploadImage(token, img.base64, img.mimeType);
    if (!r || r.error) { console.warn(`[image] ${platform} upload failed:`, r?.error); continue; }
    ids.push(platform === 'depop' ? r.image_id : r.photo_id);
  }
  return ids;
}

// ── Shared: post listing to one platform ─────────────────────────────────────
async function postToPlatform(userId, platform, listingData) {
  const conn = await getPlatformConn(userId, platform);
  if (!conn?.access_token) return { error: 'Not connected' };
  const token = decryptToken(conn.access_token);

  // Upload any images first
  const imageIds = await uploadImagesToPlatform(token, platform, listingData.images || []);
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
app.post('/api/platform/connect', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const { platform, credentials } = req.body;
  if (!platform || !credentials) return res.status(400).json({ error: 'platform and credentials required' });

  let result;
  if (platform === 'depop') {
    result = await depopLogin(credentials.email, credentials.password);
  } else if (platform === 'vinted') {
    result = await vintedLogin(credentials.username || credentials.email, credentials.password);
  } else {
    return res.status(400).json({ error: 'Unsupported platform' });
  }

  if (result.error) return res.status(400).json({ error: result.error });

  await upsertPlatformConn(user.id, platform, {
    access_token:      encryptToken(result.access_token),
    refresh_token:     result.refresh_token ? encryptToken(result.refresh_token) : null,
    platform_user_id:  result.platform_user_id,
    platform_username: result.platform_username,
    connected_at:      new Date().toISOString(),
  });

  console.log(`[platform] ${platform} connected for user ${user.id} (@${result.platform_username})`);
  res.json({ ok: true, platform, username: result.platform_username });
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

  const { title, description, price, condition, platforms = [], autoRelist = false, relistIntervalDays = 7, images = [] } = req.body;
  if (!title || !price) return res.status(400).json({ error: 'title and price required' });
  if (!platforms.length) return res.status(400).json({ error: 'Select at least one platform' });

  // images = [{ base64: '...', mimeType: 'image/jpeg' }, ...]
  const listingData = { title, description, price, condition, images };
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

    const spamBtn = new ButtonBuilder()
      .setCustomId(`spam_${discordId}_${ticketId}`)
      .setLabel(`⚑ Mark as Spam (${strikes}/3 strikes)`)
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(spamBtn);

    await owner.send({
      content:
        `📩 **Support Ticket** | ID: \`${ticketId}\`\n` +
        `**From:** ${username} (\`${discordId}\`)\n` +
        `**Subject:** ${subject || 'General enquiry'}\n` +
        `**Current strikes:** ${strikes}/3\n\n` +
        `**Message:**\n${message.slice(0, 1800)}`,
      components: [row],
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[support] Failed to DM owner:', e.message);
    res.status(500).json({ error: 'Could not send ticket. Please DM pluniez directly on Discord.' });
  }
});

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
  const { message, channel_name } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  const targetName = (channel_name || 'use-vendora').replace(/^#/, '');

  try {
    const guild   = await client.guilds.fetch(GUILD_ID);
    const channel = guild.channels.cache.find(c => c.name === targetName && c.type === ChannelType.GuildText);
    if (!channel) return res.status(404).json({ error: `Channel #${targetName} not found` });
    await channel.send(message);
    res.json({ ok: true, channel: targetName });
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
        const [depopR, vintedR] = await Promise.all([searchDepop(wl.item), searchVinted(wl.item)]);
        const allPrices = [...(depopR || []), ...(vintedR || [])]
          .map(x => parseFloat((x.price || '').replace('£', '')))
          .filter(p => !isNaN(p) && p > 0);

        if (!allPrices.length) continue;
        checkedCount++;

        const currentLow = Math.min(...allPrices);
        const currentAvg = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
        const stored     = baselines[wl.id];

        // Find the cheapest matching listing for the link
        const allListings = [...(depopR || []), ...(vintedR || [])];
        const cheapestListing = allListings
          .filter(x => {
            const p = parseFloat((x.price || '').replace('£', ''));
            return !isNaN(p) && Math.abs(p - currentLow) < 0.01;
          })[0];

        if (!stored) {
          // First time seeing this item — store baseline and move on
          baselines[wl.id] = { baseline: currentAvg, low: currentLow, item: wl.item, checkedAt: new Date().toISOString() };
          console.log(`[cron:watchlist] Baselined "${wl.item}" at avg £${currentAvg.toFixed(2)}`);
          continue;
        }

        const dropPct = ((stored.baseline - currentLow) / stored.baseline) * 100;

        if (dropPct >= 10) {
          // Significant price drop detected
          try {
            const discordUser = await client.users.fetch(wl.discord_id).catch(() => null);
            if (discordUser) {
              await discordUser.send({
                embeds: [
                  new EmbedBuilder().setColor('#e8a121')
                    .setTitle(`📉 Price Drop Alert — ${wl.item}`)
                    .setDescription(
                      `An item on your watchlist has dropped **${dropPct.toFixed(0)}%** since you added it.\n\n` +
                      `**Item:** ${wl.item}\n` +
                      `**Current low:** £${currentLow.toFixed(2)}\n` +
                      `**Previous avg:** £${stored.baseline.toFixed(2)}\n` +
                      (cheapestListing?.url ? `\n[View cheapest listing](${cheapestListing.url})` : '') +
                      `\n\nAct fast — deals disappear quickly.`
                    )
                    .setFooter({ text: 'Vendora Watchlist — /pricedrop' })
                ]
              });
              alertCount++;
              console.log(`[cron:watchlist] Alerted ${wl.discord_id} — "${wl.item}" dropped ${dropPct.toFixed(0)}%`);
            }
          } catch (e) {
            console.warn(`[cron:watchlist] DM failed for ${wl.discord_id}:`, e.message);
          }
        }

        // Also honour manual price_drop_signal flags
        if (wl.price_drop_signal === true) {
          try {
            const discordUser = await client.users.fetch(wl.discord_id).catch(() => null);
            if (discordUser) {
              await discordUser.send(`📉 **Price Drop Alert — ${wl.item}**\nA price drop has been detected for an item on your watchlist. Check the platform now.`);
              await fetch(`${SUPABASE_URL}/rest/v1/watchlist?id=eq.${wl.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
                body: JSON.stringify({ price_drop_signal: false }),
              });
            }
          } catch {}
        }

        // Update stored baseline with current data
        baselines[wl.id] = { baseline: currentAvg, low: currentLow, item: wl.item, checkedAt: new Date().toISOString() };
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
