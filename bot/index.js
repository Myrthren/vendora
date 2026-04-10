process.on('uncaughtException',  err => console.error('[crash] uncaughtException:', err));
process.on('unhandledRejection', err => console.error('[crash] unhandledRejection:', err));

console.log('[boot] Loading modules...');

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ChannelType,
  PermissionFlagsBits, PermissionsBitField,
} = require('discord.js');
const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

console.log('[boot] Modules loaded');

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID       = process.env.DISCORD_GUILD_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://fqfanqtybvnurhzkoxwr.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PORT           = process.env.PORT || 3000;
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
  new SlashCommandBuilder().setName('crosslist').setDescription('Generate an AI-optimised cross-platform listing [Pro+]')
    .addStringOption(o => o.setName('item').setDescription('Item to list').setRequired(true)),
  new SlashCommandBuilder().setName('pricedrop').setDescription('Set a price drop watchlist alert [Pro+]')
    .addStringOption(o => o.setName('item').setDescription('Item to watch').setRequired(true)),
  new SlashCommandBuilder().setName('trends').setDescription('Current brand/category trend report [Pro+]')
    .addStringOption(o => o.setName('category').setDescription('Category or brand name').setRequired(true)),
  new SlashCommandBuilder().setName('tracker').setDescription('Manage your inventory tracker [Pro+]')
    .addSubcommand(s => s.setName('add').setDescription('Add an item to your tracker')
      .addStringOption(o => o.setName('item').setDescription('Item to add').setRequired(true)))
    .addSubcommand(s => s.setName('view').setDescription('View your inventory tracker')),
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

// ── Inventory tracker (in-memory, resets on restart) ──────────────────────────
// Map<discordId, string[]>
const inventoryStore = new Map();

// ── Price drop watchlist (in-memory) ─────────────────────────────────────────
// Map<discordId, string[]>
const watchlistStore = new Map();

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
      return interaction.editReply({ embeds: [
        baseEmbed().setTitle('Session Already Open')
          .setDescription(`You already have an active session: <#${existing.channelId}>\n\nUse \`/session close\` to close it.`)
      ]});
    }
    const guild = interaction.guild;
    // Find or create VENDORA category
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes('VENDORA'));
    const sessionNum = (activeSessions.size + 1).toString().padStart(0, '');
    const channelName = `session-${Date.now().toString(36).slice(-4)}`;
    const ownerMember = await guild.members.fetch(OWNER_ID).catch(() => null);
    const permOverwrites = [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ];
    if (ownerMember) permOverwrites.push({ id: OWNER_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: permOverwrites,
      topic: `Private Vendora session for ${interaction.user.tag}`,
    });

    scheduleSessionDelete(interaction.user.id, channel.id);

    await channel.send({ embeds: [
      baseEmbed().setTitle(`Session Open — ${interaction.user.username}`)
        .setDescription(`Welcome to your private Vendora workspace, <@${interaction.user.id}>.\n\nYou can run any of your tier commands here. This channel auto-deletes after **24 hours of inactivity**.\n\nUse \`/session close\` to close it manually.`)
    ]});

    try {
      await interaction.user.send({ embeds: [
        baseEmbed().setTitle('Session Channel Created')
          .setDescription(`Your private session is ready: https://discord.com/channels/${guild.id}/${channel.id}`)
      ]});
    } catch { /* DMs closed */ }

    return interaction.editReply({ embeds: [
      baseEmbed().setTitle('Session Opened')
        .setDescription(`Your private channel is ready: <#${channel.id}>\n\nI've also sent you a DM with the link. It auto-deletes after 24 hours of inactivity.`)
    ]});
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
    if (!inventoryStore.has(interaction.user.id)) inventoryStore.set(interaction.user.id, []);
    const inv = inventoryStore.get(interaction.user.id);

    if (sub === 'add') {
      const item = opts.getString('item');
      inv.push({ item, addedAt: new Date().toLocaleDateString('en-GB') });
      return interaction.editReply({ embeds: [
        baseEmbed().setTitle('Item Added to Tracker')
          .setDescription(`**${item}** has been added to your inventory tracker.\n\nTotal items tracked: **${inv.length}**`)
      ]});
    }
    if (sub === 'view') {
      if (inv.length === 0) return interaction.editReply({ embeds: [baseEmbed().setDescription('Your inventory tracker is empty.\n\nUse `/tracker add [item]` to start tracking.')] });
      const list = inv.map((e, i) => `**${i + 1}.** ${e.item} — added ${e.addedAt}`).join('\n');
      return interaction.editReply({ embeds: [
        baseEmbed().setTitle('Your Inventory Tracker')
          .setDescription(list.slice(0, 4000))
          .addFields({ name: 'Total', value: `${inv.length} item${inv.length !== 1 ? 's' : ''}` })
      ]});
    }
  }

  // /pricedrop
  if (commandName === 'pricedrop') {
    const item = opts.getString('item');
    if (!watchlistStore.has(interaction.user.id)) watchlistStore.set(interaction.user.id, []);
    watchlistStore.get(interaction.user.id).push(item);
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle('Price Drop Alert Set')
        .setDescription(`You'll be alerted when **${item}** drops in price.\n\n*Live price monitoring via platform API integration — coming soon. Your watchlist item has been saved.*`)
    ]});
  }

  // /earlydeals
  if (commandName === 'earlydeals') {
    const guild = interaction.guild;
    const eliteLounge = guild.channels.cache.find(c => c.name === 'elite-lounge');
    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121').setTitle('Early Deal Alerts — Elite Access')
        .setDescription(
          eliteLounge
            ? `Your exclusive early deal alerts are posted in <#${eliteLounge.id}> before standard Pro members receive them.`
            : `Your exclusive early deal alerts are posted in the **#elite-lounge** channel. Check there for the latest drops.`
        )
    ]});
  }

  // /analytics
  if (commandName === 'analytics') {
    if (!ai) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const text = await callAI(
      'You are Vendora\'s analytics system. Generate a realistic-looking sales analytics summary for a UK reseller. Include: total estimated sales this month, top performing categories, avg margin, best platform, and 3 actionable insights. Note clearly this is an AI-generated summary; full platform integration is coming soon.',
      'Generate my sales analytics summary.',
      'claude-haiku-4-5-20251001', 600
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed('#e8a121').setTitle('Analytics Summary — Elite')
        .setDescription(text.slice(0, 4000))
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
    const text = await callAI(
      'You are Vendora, an AI assistant for UK resellers. Provide a quick price estimate for an item in the UK resale market (Depop, Vinted, eBay). Include: estimated resale price range, typical buy price to flip at, rough margin estimate. Be specific with £ figures. Keep it brief — 3-5 lines.',
      `Item: ${item}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Price Check — ${item}`).setDescription(text.slice(0, 4000))
        .setFooter({ text: 'Vendora AI estimate — verify with live platform data' })
    ]});
  }

  if (commandName === 'scan') {
    const platform = opts.getString('platform');
    const item     = opts.getString('item');
    const text = await callAI(
      `You are Vendora's product research engine. Based on your market knowledge, analyse ${platform} for the given item. Include: typical listing price range, what "underpriced" looks like for this item (specific £ threshold), best search terms to find deals, current demand level, and 3-5 specific types of listings to target. Add a note that live scanning integration is coming soon.`,
      `Platform: ${platform}\nItem: ${item}`,
      'claude-haiku-4-5-20251001', 900
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    const platformNames = { ebay: 'eBay', depop: 'Depop', vinted: 'Vinted' };
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Scan — ${item} on ${platformNames[platform]}`)
        .setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'research') {
    const item = opts.getString('item');
    const text = await callAI(
      'You are Vendora\'s research engine. Provide a comprehensive UK resale research report. Structure it clearly with these sections:\n**Market Overview** — buy/sell price range\n**Best Platforms** — where this sells best\n**Key Search Terms** — what to search for deals\n**Demand Level** — with reasoning\n**Margin Estimate** — rough profit potential\n**Sourcing Tips** — 3 specific tips',
      `Item: ${item}`,
      'claude-sonnet-4-6', 1200
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Research Report — ${item}`).setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'margins') {
    const item = opts.getString('item');
    const text = await callAI(
      'You are Vendora\'s margin calculator. Provide a detailed profit margin breakdown for reselling this item in the UK market. Include specific £ figures for: typical purchase price range, typical resale price range, platform fees (Depop ~10%, eBay ~12%, Vinted ~5%), estimated shipping, net profit estimate, and ROI percentage. Format clearly.',
      `Item: ${item}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Margin Breakdown — ${item}`).setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'crosslist') {
    const item = opts.getString('item');
    const text = await callAI(
      'You are Vendora\'s cross-listing generator. Create an optimised listing for UK resale platforms. Include:\n**Title** — SEO-optimised, under 80 chars\n**Description** — compelling 3-5 sentence listing description\n**Suggested Price** — with reasoning\n**Keywords/Hashtags** — 8-10 relevant tags\n**Platform Notes** — any platform-specific tips',
      `Item: ${item}`,
      'claude-haiku-4-5-20251001', 900
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Cross-Listing — ${item}`).setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'trends') {
    const category = opts.getString('category');
    const text = await callAI(
      'You are Vendora\'s trend analyst for the UK resale market. Provide a current trend report. Include:\n**Demand Level** — High/Medium/Low with reasoning\n**Price Trend** — rising/stable/falling\n**Top Items** — 5 best-selling items in this category right now\n**Best Platforms** — where it performs best\n**Buying Opportunity** — rating out of 10\n**Source Now** — 3 specific items to look for immediately',
      `Category/Brand: ${category}`,
      'claude-haiku-4-5-20251001', 900
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Trend Report — ${category}`).setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'sold') {
    const item = opts.getString('item');
    const text = await callAI(
      'You are Vendora\'s sold listing analyst for the UK resale market. Analyse what actually sells fast vs what sits unsold. Include:\n**Fast Sellers** — specific versions/conditions that move quickly\n**Slow Movers** — what typically doesn\'t sell\n**Key Factors** — what makes listings sell faster\n**Sweet Spot Pricing** — price points that move quickly\n**Condition Requirements** — what buyers expect',
      `Item/Category: ${item}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Sold Listing Analysis — ${item}`).setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'competitor') {
    const seller = opts.getString('seller');
    const text = await callAI(
      'You are Vendora\'s competitor intelligence system. Generate a strategic tracking profile for a competitor reseller. Include:\n**Tracking Strategy** — how to monitor them effectively\n**What to Monitor** — listing patterns, pricing, timing, stock\n**Market Signals** — what their activity might indicate\n**Counter Strategy** — how to position against this seller type\n**Response Scripts** — how to react to their moves',
      `Seller to track: ${seller}`
    );
    if (!text) return interaction.editReply({ embeds: [aiUnavailableEmbed()] });
    return interaction.editReply({ embeds: [
      baseEmbed().setTitle(`Competitor Profile — ${seller}`).setDescription(text.slice(0, 4000))
    ]});
  }

  if (commandName === 'flip') {
    const item = opts.getString('item');
    const text = await callAI(
      'You are Vendora\'s Elite Auto-Flip System. Provide a complete flip opportunity analysis. Structure:\n**Sourcing Strategy** — where and how to buy cheaply\n**Target Buy Price** — maximum to pay (with reasoning)\n**Suggested Sell Price** — with reasoning\n**Projected Profit** — after platform fees and shipping\n**Best Platform** — where to sell for highest return\n**Time to Sell** — realistic estimate\n**Risk Level** — Low/Medium/High with reason\n**Action Plan** — numbered step-by-step',
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
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  // Defer ephemerally — all responses are private
  try { await interaction.deferReply({ ephemeral: true }); }
  catch { return; }

  // Get subscriber profile
  const profile = await getProfileByDiscordId(user.id);

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

app.get('/', (_req, res) => res.json({ status: 'ok', bot: client.user?.tag || 'connecting...' }));

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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[http] Listening on port ${PORT}`));

if (TOKEN) {
  client.login(TOKEN).catch(err => console.error('[discord] Login failed:', err.message));
} else {
  console.error('[discord] Cannot login — DISCORD_BOT_TOKEN missing');
}
