Warning: truncated output (original token count: 148101)
Total output lines: 11794

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
const { createGroqClient } = require('./groq-shim');
const cron     = require('node-cron');
const crypto   = require('crypto');

// undici fetch — used for the primary PROXY_URL agent (non-Apify path).
// Apify proxy now uses a raw http.CONNECT implementation (see apifyVFetch).
let ProxyAgent, undFetch;
try { ({ ProxyAgent, fetch: undFetch } = require('undici')); }
catch (e) { console.warn('[proxy] undici unavailable — primary proxy disabled:', e.message); }

const nodeHttp  = require('http');
const nodeHttps = require('https');

// Win-back DM payload — shared with scripts/preview-winback-dm.js so the embed
// the owner approves is the identical object members receive.
const { buildWinbackPayload } = require('./winback-embed');

// Channel feeds for The Market category — channel ids, the underpriced filter
// and the embed builders. Logic only; the posting happens here in index.js.
const feeds = require('./feeds');
// Reading Vinted's session endpoint (/api/v2/users/current_user) for token validation. Pure, see bot/vinted-session.js.
const vintedSession = require('./vinted-session');
// Deal feed health — owner DM on failing searches, channel notice after an hour. Pure, see bot/feed-health.js.
const feedHealth = require('./feed-health');
// Deal-feed track record — did the finds we posted actually go? Pure logic, see bot/track-record.js.
const trackRecord = require('./track-record');
// Offer Finder maths — fees, max offer, junk filter. Pure, see bot/offers.js.
const offerFinder = require('./offers');
// Monthly niche report — daily niche data, report maths, Claude notes, embeds. Pure, see bot/niche.js.
const niche = require('./niche');
// Auto-buy spend rules — availability flags, price ceiling, baseline, daily cap. Pure, see bot/autobuy.js.
const autobuy = require('./autobuy');

// Vinted browser flow (Playwright + stealth) — bypasses DataDome by running
// inside a real Chromium through the residential proxy. Optional dep:
// if playwright isn't installed, functions return { error } and we fall back
// to the legacy vFetch path (which will fail on bot-protected endpoints).
let vintedBrowser = null;
try { vintedBrowser = require('./vinted-browser'); console.log('[vinted] browser flow loaded'); }
catch (e) { console.warn('[vinted] browser flow disabled:', e.message); }

// Onboarding quiz + day-one affiliate follow-up. Pure payload builders — see
// bot/onboarding.js. Required (not optional) because the welcome flow needs it.
const onboarding = require('./onboarding');
// Outreach campaign payloads (existing members with no plan) + weekly report.
const outreach = require('./outreach');

// Free trial payloads — channel embed, click confirmation, expiry DMs.
const trial = require('./trial');
// Vendora Intelligence — public limiter, message cleaning and the facts prompt.
const intelligence = require('./intelligence');
const memberIntelligence = require('./member-intelligence');
const repriceCoach = require('./reprice-coach');
const { registerPriceGuides } = require('./price-guides');
const { createFeatureSettings } = require('./feature-settings');
const updateLog = require('./update-log');

console.log('[boot] Modules loaded');

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID       = process.env.DISCORD_GUILD_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://fqfanqtybvnurhzkoxwr.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const GROQ_KEY         = process.env.GROQ_API_KEY;
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
// Whop OAuth — lets a marketplace buyer prove which Whop account is theirs, so we can
// match their purchase to their Discord account without a claim code. App id + secret
// come from the Whop developer dashboard (the app's redirect URI must match exactly).
const WHOP_OAUTH_CLIENT_ID     = process.env.WHOP_OAUTH_CLIENT_ID;     // "app_..."
const WHOP_OAUTH_CLIENT_SECRET = process.env.WHOP_OAUTH_CLIENT_SECRET;
const WHOP_OAUTH_REDIRECT_URI  = process.env.WHOP_OAUTH_REDIRECT_URI
  || 'https://vendora-production-8a47.up.railway.app/api/whop/oauth/callback';
const PROXY_URL        = process.env.PROXY_URL; // optional residential proxy e.g. http://user:pass@host:port
const APIFY_TOKEN      = process.env.APIFY_API_TOKEN; // Apify API key for Vinted Scraper & Monitor
// GitHub → Discord release digest. This is separate from the dashboard's
// copy-pastable Update Log and has its own durable relational storage.
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const GITHUB_DEFAULT_BRANCH = process.env.GITHUB_DEFAULT_BRANCH || 'main';
const UPDATE_LOG_CHANNEL_ID = process.env.DISCORD_UPDATE_LOG_CHANNEL_ID || '1493347363492855969';
const UPDATE_LOG_ROLE_ID = process.env.DISCORD_UPDATE_LOG_ROLE_ID || '1505563141088743464';
const UPDATE_LOG_WINDOW_HOURS = Math.max(1, Math.min(24, Number(process.env.UPDATE_LOG_WINDOW_HOURS || 4)));
const UPDATE_LOG_INITIAL_VERSION = process.env.UPDATE_LOG_INITIAL_VERSION;
const GITHUB_API_TOKEN = process.env.GITHUB_API_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'Myrthren/vendora';

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
const RULES_MESSAGE_KEY = 'rules_message';
const AFFILIATE_MESSAGE_KEY = 'affiliate_message';
// Default target for /postaffiliate when no channel is passed.
const AFFILIATE_CHANNEL_ID = '1546264798876930151';

// ── Free trial ────────────────────────────────────────────────────────────────
const TRIAL_MESSAGE_KEY  = 'trial_message';
const TRIAL_CHANNEL_ID   = '1546270485803704440';
const TRIAL_ROLE_ID      = '1546263632617144411';
// Trials grant Pro-equivalent access to the Discord tools only.
const TRIAL_TIER         = 'pro';
const TRIALS_KEY         = 'trials';
const DASHBOARD_URL  = 'https://vendora.site/vendora-dashboard';
const LOGIN_URL      = 'https://vendora.site/vendora-login';
const SITE_URL       = 'https://vendora.site';

console.log('[boot] Config — GUILD_ID:', GUILD_ID, '| PORT:', PORT);
if (!TOKEN)         console.warn('[warn] DISCORD_BOT_TOKEN not set');
if (!GUILD_ID)      console.warn('[warn] DISCORD_GUILD_ID not set');
if (!SUPABASE_KEY)  console.warn('[warn] SUPABASE_SERVICE_KEY not set');
if (!ANTHROPIC_KEY && !GROQ_KEY) console.warn('[warn] Neither GROQ_API_KEY nor ANTHROPIC_API_KEY set — AI commands will fail');
if (!OPENAI_KEY)       console.warn('[warn] OPENAI_API_KEY not set — AI photo enhancement will fail');
if (!PHOTOROOM_KEY)    console.warn('[warn] PHOTOROOM_API_KEY not set — PhotoRoom enhancement will fail');
if (!PAYPAL_CLIENT_ID) console.warn('[warn] PAYPAL_CLIENT_ID not set — credit purchases will fail');
if (!PAYPAL_SECRET)    console.warn('[warn] PAYPAL_CLIENT_SECRET not set — credit purchases will fail');
if (!APIFY_TOKEN)      console.warn('[warn] APIFY_API_TOKEN not set — Vinted Apify scraping disabled');
if (!WHOP_WEBHOOK_SECRET) console.warn('[warn] WHOP_WEBHOOK_SECRET not set — Whop webhooks will be REJECTED');
if (!WHOP_API_KEY)        console.warn('[warn] WHOP_API_KEY not set — Whop checkout falls back to unmatched plan links');
if (!WHOP_OAUTH_CLIENT_ID) console.warn('[warn] WHOP_OAUTH_CLIENT_ID not set — "Connect Whop" disabled, marketplace buyers need claim codes');
if (!GITHUB_WEBHOOK_SECRET || !UPDATE_LOG_INITIAL_VERSION) {
  console.warn('[update-log] Disabled — set GITHUB_WEBHOOK_SECRET and UPDATE_LOG_INITIAL_VERSION after applying sql/release-log.sql');
}

// ── AI client ─────────────────────────────────────────────────────────────────
// GROQ_API_KEY wins when set: it is the stand-in while the Anthropic key is
// down, and a dead ANTHROPIC_API_KEY left on Railway must not shadow it.
// groq-shim mimics ai.messages.create, so no call site changes. Remove
// GROQ_API_KEY to go back to Claude.
const ai = GROQ_KEY ? createGroqClient(GROQ_KEY)
         : ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
console.log(`[boot] AI provider: ${GROQ_KEY ? 'groq' : ANTHROPIC_KEY ? 'anthropic' : 'none'}`);

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
// Category that /session channels are created under. Resolved by ID, not by
// #use-vendora's parent — that category was deleted, which silently dropped
// every new session channel at the server root.
const SESSION_CATEGORY_ID = '1474033954972504126';
// The channel members are pointed at to run commands. Held as an ID so it is
// rendered as a real Discord mention and survives a rename — the old plain
// "#use-vendora" text went stale the moment the channel changed.
const USE_VENDORA_CHANNEL_ID = '1487885732528918679';
const TIER_NAMES  = { none: 'Free', basic: 'Basic', pro: 'Pro', elite: 'Elite' };
const TIER_PRICES = { basic: '£9.99', pro: '£24.99', elite: '£49.99' };
// Affiliate commission quoted in the day-one DM. MUST match the rate configured
// on Whop (Dashboard -> Marketing -> Affiliates). Quoting a rate Whop doesn't
// pay is the one mistake in an affiliate program you cannot walk back.
const AFFILIATE_RATE_PCT = 30;
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
// /scan platforms listed but not live (value -> label). See the gate below.
const COMING_SOON_PLATFORMS = { ebay: 'eBay', depop: 'Depop' };
const CMD_RATE_GROUP = {
  scan: 'scan', research: 'research', margins: 'research',
  sold: 'research', competitor: 'research', trends: 'research',
  reply: 'reply', lowball: 'reply', price: 'reply',
  pricedrop: 'default',
  'vinted-alert': 'default',
  flip: 'flip',
};
// scan and research are NOT gated (2026-10-19): RATE_LIMITS gives Basic 5 scans
// and 3 research a day, and for months this gate ran first and made those
// allowances dead code. Basic now gets a taste of what Vendora is for; the rest
// of the research family (margins, sold, trends, competitor) stays Pro+.
// Non-subscribers are still stopped earlier, by the subscription check.
const CMD_TIER_REQUIRED = {
  margins: 'pro',
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

// ── API rate limits — the dashboard's scraper surface ─────────────────────────
// Separate from RATE_LIMITS above. Those govern Discord slash commands; these
// govern the Express routes that spend real money — Apify actor runs, Playwright
// browser time, and marketplace requests through the residential proxy.
//
// Until now the HTTP API had no throttle at all, so a single logged-in user
// could run the Apify/Anthropic bill up or simply exhaust the box. That matters
// more here than in a normal backend: this process IS the Discord bot as well as
// the API, so resource exhaustion takes the bot down with it.
//
// EVERY tier has a finite ceiling, Elite included. "Unlimited" is defensible for
// slash commands because a human can only type so fast. An HTTP client has no
// such limit, and an uncapped Elite account is an uncapped Apify invoice.
//
// Two windows, both enforced, because they defend against different things:
//   burst — per 60s. Protects the box. A daily quota alone still permits
//           spending the entire allowance in one second.
//   day   — per 24h. Caps the cost.
const API_RATE_LIMITS = {
  intelligence: memberIntelligence.RATE_LIMITS,
  //              burst / 60s                            quota / 24h
  search:    { burst: { basic: 3, pro: 6, elite: 12 }, day: { basic: 15, pro: 100, elite: 500 } },
  arbitrage: { burst: { basic: 1, pro: 2, elite: 4  }, day: { basic: 3,  pro: 15,  elite: 60  } },
  sync:      { burst: { basic: 1, pro: 2, elite: 3  }, day: { basic: 4,  pro: 12,  elite: 40  } },
  listing:   { burst: { basic: 2, pro: 5, elite: 10 }, day: { basic: 10, pro: 50,  elite: 200 } },
  monitor:   { burst: { basic: 2, pro: 4, elite: 8  }, day: { basic: 5,  pro: 25,  elite: 100 } },
  // Offer Finder: one 96-item browser search per call. £0 to run, but it holds a
  // page on the one shared Chromium the deal feed and alerts also depend on.
  offers:    { burst: { basic: 1, pro: 3, elite: 6  }, day: { basic: 5,  pro: 40,  elite: 150 } },
  // Model calls — Anthropic, OpenAI (text and image), remove.bg, PhotoRoom.
  // A different cost centre from the scrapers but the same failure mode: metered
  // third-party spend behind an endpoint a logged-in client can call in a loop.
  // Deliberately the most generous group, because optimising or drafting a
  // listing is a per-item action a working reseller does dozens of times a day.
  ai:        { burst: { basic: 3, pro: 6, elite: 12 }, day: { basic: 20, pro: 120, elite: 600 } },
};

const API_GROUP_LABEL = {
  intelligence: 'member support questions',
  search:    'market searches',
  arbitrage: 'arbitrage scans',
  sync:      'inventory syncs',
  listing:   'listing actions',
  monitor:   'alert changes',
  offers:    'offer searches',
  ai:        'AI actions',
};

// Map<userId, Map<group, { burstCount, burstResetAt, dayCount, dayResetAt }>>
const apiUsageStore = new Map();

// Drop entries whose daily window has long expired, so the map cannot grow
// without bound across a long uptime.
setInterval(() => {
  const now = Date.now();
  for (const [userId, groups] of apiUsageStore) {
    for (const [group, e] of groups) if (now >= e.dayResetAt) groups.delete(group);
    if (!groups.size) apiUsageStore.delete(userId);
  }
}, 60 * 60 * 1000);

// In-memory, like the slash-command limiter above: counters reset on redeploy.
// Acceptable for abuse/cost control (a redeploy is not attacker-triggerable),
// but it does mean limits are per-instance and would need moving to Supabase if
// this ever runs more than one replica.
function checkApiRateLimit(userId, group, tier) {
  const conf = API_RATE_LIMITS[group];
  if (!conf) return { allowed: true };

  // Anything unrecognised (including 'none' — /api/research has no subscription
  // gate) is held to the strictest tier rather than being waved through.
  const t = conf.day[tier] !== undefined ? tier : 'basic';
  const burstLimit = conf.burst[t];
  const dayLimit   = conf.day[t];

  const now = Date.now();
  if (!apiUsageStore.has(userId)) apiUsageStore.set(userId, new Map());
  const groups = apiUsageStore.get(userId);
  let e = groups.get(group);
  if (!e) { e = { burstCount: 0, burstResetAt: 0, dayCount: 0, dayResetAt: 0 }; groups.set(group, e); }

  if (now >= e.burstResetAt) { e.burstCount = 0; e.burstResetAt = now + 60_000; }
  if (now >= e.dayResetAt)   { e.dayCount   = 0; e.dayResetAt   = now + 86_400_000; }

  // Check both windows BEFORE incrementing either, so a rejected request never
  // consumes quota — otherwise a client stuck in a retry loop would burn the
  // whole daily allowance on requests that were all refused.
  if (e.burstCount >= burstLimit) {
    return { allowed: false, scope: 'burst', tier: t, limit: burstLimit,
             retryAfter: Math.max(1, Math.ceil((e.burstResetAt - now) / 1000)) };
  }
  if (e.dayCount >= dayLimit) {
    return { allowed: false, scope: 'day', tier: t, limit: dayLimit,
             retryAfter: Math.max(1, Math.ceil((e.dayResetAt - now) / 1000)) };
  }

  e.burstCount++;
  e.dayCount++;
  return { allowed: true, tier: t, dayUsed: e.dayCount, dayLimit };
}

// Enforce a group limit on an Express route. Returns true if the request may
// proceed; if it returns FALSE the 429 has already been sent and the caller must
// return immediately without doing any work.
function enforceApiLimit(res, userId, group, tier, discordId) {
  // The owner is exempt so a limit misconfiguration can't lock them out of their
  // own admin tooling while they fix it.
  if (discordId && discordId === OWNER_ID) return true;

  const rl = checkApiRateLimit(userId, group, tier);
  if (rl.allowed) {
    res.set('X-RateLimit-Limit', String(rl.dayLimit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, rl.dayLimit - rl.dayUsed)));
    return true;
  }

  const label = API_GROUP_LABEL[group] || group;
  const mins  = Math.ceil(rl.retryAfter / 60);
  const canUpgrade = rl.tier !== 'elite';

  res.set('Retry-After', String(rl.retryAfter));
  res.status(429).json({
    error: rl.scope === 'burst'
      ? `Too fast — you can run ${rl.limit} ${label} per minute on ${TIER_NAMES[rl.tier] || rl.tier}. Try again in ${rl.retryAfter}s.`
      : `Daily limit reached — ${rl.limit} ${label} per day on ${TIER_NAMES[rl.tier] || rl.tier}.${canUpgrade ? ' Upgrade for a higher limit.' : ''} Resets in ${mins > 60 ? Math.ceil(mins / 60) + 'h' : mins + 'm'}.`,
    rate_limited: true,
    scope:      rl.scope,
    tier:       rl.tier,
    limit:      rl.limit,
    retry_after: rl.retryAfter,
    upgrade:    canUpgrade,
  });
  return false;
}

// ── Public Vendora Intelligence guard ───────────────────────────────────────
// The landing-page assistant is available before sign-in, so it cannot use the
// authenticated limiter. bot/intelligence.js holds the per-visitor, all-visitor
// and AI-cooldown layers and explains why each exists.
const intelligenceLimiter = intelligence.createLimiter();
setInterval(() => intelligenceLimiter.prune(), intelligence.WINDOW_MS);

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
  const waitMs = (ai?.rateLimitedUntil || 0) - Date.now();
  if (waitMs > 0) return aiBusyEmbed(waitMs);
  return baseEmbed('#f87171').setTitle('AI Unavailable').setDescription('The AI service is currently unavailable. Please try again later.');
}

// Shown when the AI provider has rate-limited the bot's key. Blue like the
// daily-limit embed rather than error red: nothing is broken, it is queueing.
function aiBusyEmbed(waitMs) {
  const secs = Math.ceil(waitMs / 1000);
  const wait = secs < 60   ? `about **${Math.max(secs, 10)} seconds**`
             : secs < 3600 ? `about **${Math.ceil(secs / 60)} minute${secs >= 120 ? 's' : ''}**`
             : 'a little while';
  return baseEmbed('#60a5fa')
    .setTitle('⏳ Vendora AI is at capacity')
    .setDescription(`Lots of members are running AI commands right now, so yours didn't go through.

Give it ${wait} and run the command again.`);
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
// Override either via Railway env vars. Format: "username~actor-name".
const APIFY_VINTED_ACTOR      = process.env.APIFY_VINTED_ACTOR      || 'kazkn~vinted-smart-scraper';

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
const currencySymbol = (cur) =>
  cur === 'GBP' ? SYM_GBP : cur === 'EUR' ? SYM_EUR : (cur ? cur + ' ' : SYM_GBP);

// Map a kazkn/vinted-smart-scraper output item to our internal shape.
function mapApifyVintedItem(i) {
  const photo = Array.isArray(i.photos) ? (i.photos[0] || '')
    : (i.photo || i.photoUrl || i.thumbnailUrl || '');
  const cur = (i.currency || '').toUpperCase();
  const sym = currencySymbol(cur);
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

// Map a RAW Vinted /api/v2/catalog/items object to the same internal shape.
// Used by every non-Apify path (the direct-API fallback in searchVinted, and the
// browser search the alert crons run), so callers never have to know which
// source produced the item. Keep this in sync with mapApifyVintedItem above.
function mapVintedRawItem(i) {
  const cur = String(i.total_item_price?.currency_code || i.currency || 'GBP').toUpperCase();
  const num = parseFloat(i.total_item_price?.amount ?? i.price?.amount ?? i.price ?? 0) || 0;
  // priceNum is what the buyer pays before postage (item + Vinted's buyer fee).
  // itemPriceNum is the item price alone — what a seller lists at and receives —
  // which the deal feed, Vendex and the niche report all compare on.
  const itemNum = parseFloat(i.price?.amount ?? i.price ?? 0) || 0;
  return {
    id:        String(i.id || ''),
    title:     i.title || '',
    price:     num ? `${currencySymbol(cur)}${num.toFixed(2)}` : '—',
    priceNum:  num,
    itemPriceNum: itemNum,
    currency:  cur,
    url:       i.url || '',
    brand:     i.brand_title || i.brand?.title || '',
    // size_title is how kids' sizes are recognised ("13 years / 158 cm") — see offers.isKidSize.
    size:      i.size_title || '',
    condition: i.status || '',
    photo:     i.photo?.url || i.photos?.[0]?.url || '',
    sellerName: i.user?.login || '',
    sellerId:   String(i.user?.id || ''),
  };
}

// Keyword search for the alert crons, preferring the self-hosted browser.
//
// WHY THIS EXISTS: the Apify actor bills $0.02 per run PLUS $0.002 per result.
// At 20 items that is $0.06 a search, and the Elite alert cron fires every 5
// minutes — 288 runs/day/keyword, roughly $518/month for ONE keyword against a
// £49.99 plan. Elite users may hold 30 alerts. The cost is not survivable.
//
// vintedBrowserSearchItems costs nothing per call and auto-buy already runs it
// on a 2-minute cadence, which is more demanding than this 5-minute sweep, so
// the capability is proven rather than assumed.
//
// Apify remains the fallback: if the browser is unavailable or errors, alerts
// keep working. Note the distinction below — a browser search that SUCCEEDS and
// finds nothing is a real answer and must not trigger the paid fallback, or a
// quiet keyword would bill Apify every five minutes to confirm the same empty
// result.
async function alertKeywordSearch(keyword, maxItems = 20) {
  if (vintedBrowser?.vintedBrowserSearchItems) {
    try {
      const { items, error } = await vintedBrowser.vintedBrowserSearchItems(keyword, null, maxItems);
      if (!error && Array.isArray(items)) return items.slice(0, maxItems).map(mapVintedRawItem);
      console.warn(`[alert-search] browser failed for "${keyword}": ${error || 'bad response'} — falling back to Apify`);
    } catch (e) {
      console.warn(`[alert-search] browser threw for "${keyword}": ${e.message} — falling back to Apify`);
    }
  }
  return APIFY_TOKEN ? await apifyVintedSearch(keyword, maxItems) : null;
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

// Item detail, browser first. Same output shape as apifyVintedItemDetail so it
// is a drop-in for it.
//
// WHY: the watchlist cron calls this once PER WATCHED ITEM, hourly for Elite,
// with no cap on watchlist size. On Apify that is $0.022 a call — roughly $317
// a month for a single Elite user watching 20 items, against a $5 account cap
// and a £49.99 plan. Same shape the alert cron had before f4cf874.
async function vintedItemDetail(url) {
  if (!url) return null;

  if (vintedBrowser?.vintedBrowserFetchItem) {
    try {
      const r  = await vintedBrowser.vintedBrowserFetchItem(url);
      const it = r?.ok ? r.data?.item : null;
      if (it) {
        const m = mapVintedRawItem(it);
        if (m.priceNum) {
          return {
            title:    m.title,
            price:    m.priceNum,
            size:     it.size_title || it.size || '',
            currency: m.currency || 'GBP',
          };
        }
      }
      console.warn(`[vinted] browser item detail thin for ${url}${r?.error ? ` (${r.error})` : ''} — falling back`);
    } catch (e) {
      console.warn(`[vinted] browser item detail threw for ${url}: ${e.message} — falling back`);
    }
  }

  return APIFY_TOKEN ? await apifyVintedItemDetail(url) : null;
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

// Concurrency guard for the self-hosted browser.
//
// The alert crons proved the browser handles this CADENCE, but crons are serial
// and user commands are not: ten Pro users running /scan at once all queue
// behind one Chromium context. So past this many in-flight searches we spill to
// Apify rather than making everyone wait. Apify stops being the thing we pay for
// every search and becomes burst capacity — paid only when requests actually
// overlap, which is rare and is exactly when latency would otherwise hurt.
const BROWSER_SEARCH_MAX_INFLIGHT = 3;
let browserSearchInflight = 0;

async function searchVinted(query) {
  // Browser first: $0 per call. Apify bills $0.02 per run + $0.002 per result,
  // which is $0.044 for the 12 items below — about 83 searches on the $5 cap,
  // for all users, for the whole month. See alertKeywordSearch for the same
  // migration on the alert path.
  const browserFree = vintedBrowser?.vintedBrowserSearchItems
    && browserSearchInflight < BROWSER_SEARCH_MAX_INFLIGHT;

  if (browserFree) {
    browserSearchInflight++;
    try {
      const { items, error } = await vintedBrowser.vintedBrowserSearchItems(query, null, 12);
      // A search that SUCCEEDS and finds nothing is a real answer. Treating it
      // as a failure would bill Apify to re-confirm every empty result.
      if (!error && Array.isArray(items)) return items.slice(0, 12).map(mapVintedRawItem);
      console.warn(`[vinted] browser search failed for "${query}": ${error || 'bad response'} — falling back`);
    } catch (e) {
      console.warn(`[vinted] browser search threw for "${query}": ${e.message} — falling back`);
    } finally {
      browserSearchInflight--;
    }
  } else if (vintedBrowser?.vintedBrowserSearchItems) {
    console.log(`[vinted] browser at capacity (${browserSearchInflight}) — spilling "${query}" to Apify`);
  }

  // Paid fallback: browser unavailable, errored, or saturated.
  if (APIFY_TOKEN) {
    const apifyResults = await apifyVintedSearch(query, 12);
    if (apifyResults?.length) return apifyResults;
  }
  // Last resort: direct Vinted API (usually blocked by DataDome)
  try {
    const url = `https://www.vinted.co.uk/api/v2/catalog/items?search_text=${encodeURIComponent(query)}&per_page=12&order=newest_first`;
    const res = await fetch(url, vintedProxyOpts({
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }));
    if (!res.ok) return null;
    const data = await res.json();
    return (data.items || []).map(mapVintedRawItem);
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
    .addSubcommand(s => s.setName('close').setDescription('Close y…118101 tokens truncated…n) {
      if (owner) await owner.send(feedHealth.buildOwnerDownPayload({ failures, searched, now })).catch(e => console.warn('[feed:health] Owner DM failed:', e.message));
      console.warn(`[feed:health] Outage opened — ${failures.length}/${searched} keyword search(es) failed. Owner DM'd.`);
    }

    if (actions.postAlert) {
      const configured = await getSetting('feed_alert_channels');
      const channelIds = Array.isArray(configured) && configured.length
        ? configured
        : feeds.monitorChannelIds(feeds.resolveCategories(await getSetting('feed_categories')));
      const posted = {};
      for (const channelId of channelIds) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) { console.warn(`[feed:health] Alert channel ${channelId} not found — skipping`); continue; }
        const msg = await channel.send(feedHealth.buildChannelAlertPayload({ failingSince: state.failingSince, now })).catch(e => {
          console.warn(`[feed:health] Alert post to ${channelId} failed:`, e.message);
          return null;
        });
        if (msg) posted[channelId] = msg.id;
      }
      // Recorded even when every post failed, so a missing channel does not
      // retry (and warn) on every run for the rest of the outage.
      state.alertMessages = posted;
      console.warn(`[feed:health] Still failing after 1h — notice posted to ${Object.keys(posted).length}/${channelIds.length} channel(s).`);
    }

    if (actions.resolve) {
      if (owner) await owner.send(feedHealth.buildOwnerResolvedPayload({ closed, now })).catch(e => console.warn('[feed:health] Owner DM failed:', e.message));
      for (const [channelId, messageId] of Object.entries(closed.alertMessages || {})) {
        try {
          const channel = await client.channels.fetch(channelId);
          const msg = await channel.messages.fetch(messageId);
          await msg.edit(feedHealth.buildChannelResolvedPayload({ closed, now }));
        } catch (e) {
          console.warn(`[feed:health] Could not update the notice in ${channelId}:`, e.message);
        }
      }
      console.log(`[feed:health] Outage closed after ${feedHealth.formatDuration(now - closed.failingSince)}.`);
    }

    await saveSetting(FEED_HEALTH_KEY, state);
  } catch (e) {
    console.error('[feed:health] Update failed:', e.message);
  }
}

async function runDealFeed() {
  if (!SUPABASE_KEY) return;

  try {
    // Monitors: each keyword belongs to a category with its own Elite and Pro
    // channel. `feed_categories` overrides the defaults; the older flat
    // `feed_keywords` setting is no longer read.
    const categories = feeds.resolveCategories(await getSetting('feed_categories'));
    const targets = categories.flatMap(category => category.keywords.map(keyword => ({ keyword, category })));
    if (!targets.length) { console.warn('[feed:deals] No valid monitor categories — nothing to search.'); return; }

    const seen  = new Set((await getSetting(FEED_SEEN_KEY)) || []);
    const queue = (await getSetting(DEAL_QUEUE_KEY)) || [];
    let stats = await getSetting(FEED_STATS_KEY);
    if (!stats) {
      stats = feeds.seedStatsFromLegacy(await getSetting(LEGACY_FEED_STATS_KEY));
      console.log(`[feed:deals] Starting the filtered stats series (${FEED_STATS_KEY}) — weekly counters carried over for ${Object.keys(stats).length} keyword(s), medians start fresh.`);
    }
    // Tunable without a deploy — see feeds.pickUnderpriced for what each does.
    const tuning = (await getSetting('feed_tuning')) || {};
    let posted = 0, sampled = 0;
    // Finds that actually posted, for the track record. Written after the loop.
    const postedFinds = [];
    // Per-keyword outcome, so a quiet run says WHY it was quiet. Without this,
    // "no results", "nothing cheap enough" and "cron never ran" are the same
    // silence, which is not a diagnosis.
    const trace = [];
    const failures = [];
    const postedByCategory = {};
    let searched = 0;

    for (const [index, { keyword, category }] of targets.entries()) {
      // Three failures before any success means Vinted is unreachable, not
      // that three keywords are odd. Each failure can hold the browser for a
      // 25s timeout, so stop rather than run past the next 10-minute tick.
      if (failures.length >= 3 && failures.length === searched) {
        for (const rest of targets.slice(index)) failures.push({ keyword: rest.keyword, error: 'skipped — the first three searches all failed' });
        searched = targets.length;
        trace.push('stopped — Vinted unreachable');
        break;
      }
      try {
        // 48, not 20: still one request, but with garment groups each needing 6
        // comparables, 20 listings almost never gave bottoms a group of their own,
        // and the tech fleece median swung £20-£30 between runs.
        searched++;
        const { items, error } = await feedKeywordSearch(keyword, 48);
        if (error) {
          failures.push({ keyword, error });
          trace.push(`${keyword}: search failed (${error})`);
          continue;
        }
        if (!items.length) { trace.push(`${keyword}: 0 results`); continue; }

        // Global feed_tuning plus any per-keyword values — see feeds.tuningFor.
        const { median: med, picks, junk, sample } = feeds.pickUnderpriced(items, feeds.tuningFor(tuning, keyword), keyword);
        trace.push(`${keyword}: ${items.length} results, ${junk} junk removed, ${sample} usable, median £${med ? med.toFixed(0) : '-'}, ${picks.length} under threshold`);

        // Record the median every run whether or not anything was underpriced —
        // #whats-selling reports price movement, which needs the quiet weeks too.
        if (med) {
          const s = stats[keyword] || { medians: [], finds: 0 };
          // At most one sample an hour. The feed runs every 10 minutes, and
          // storing all of those would put ~2,000 points per keyword into a
          // single settings row for no extra signal — hourly is finer than any
          // report that reads it.
          const last = s.medians[s.medians.length - 1];
          if (!last || Date.now() - last.t >= 55 * 60 * 1000) {
            s.medians.push({ t: Date.now(), median: med });
            s.medians = s.medians.filter(m => m.t > Date.now() - 14 * 24 * 60 * 60 * 1000);
            sampled++;
          }
          stats[keyword] = s;
        }
        // Only ever post a listing once, however many runs it survives.
        const fresh = picks.filter(p => p.id && !seen.has(p.id));
        if (!fresh.length) continue;

        const payloadElite = feeds.buildDealPayload({ keyword, picks: fresh, median: med, tier: 'elite' });
        if (await postToFeedChannel(category.channels.elite, payloadElite, `elite-${category.id}`)) {
          posted++;
          postedByCategory[category.id] = (postedByCategory[category.id] || 0) + 1;
          // Only what members were actually shown counts toward the track record.
          postedFinds.push({ keyword, picks: fresh, median: med });
          queue.push({
            dueAt: Date.now() + feeds.PRO_DELAY_MS,
            keyword,
            median: med,
            picks: fresh,
            // Resolved now, not at release: a category edit in the next ten
            // minutes must not send an already-queued find somewhere else.
            channelId: category.channels.pro,
            category: category.id,
          });
        }

        stats[keyword].finds = (stats[keyword].finds || 0) + fresh.length;
        // Best discount of the week, for the Pro trend report.
        const best = Math.max(...fresh.map(p => p.discountPct || 0));
        if (best > (stats[keyword].bestDiscountPct || 0)) stats[keyword].bestDiscountPct = best;
        fresh.forEach(p => seen.add(p.id));
      } catch (e) {
        console.warn(`[feed:deals] "${keyword}" failed:`, e.message);
      }
    }

    // Save when a median was sampled OR a find was posted. It used to save only
    // on sampled runs (one in six), so finds and best-discount counted on the
    // other runs were dropped and the weekly reports undercounted.
    if (sampled || posted) await saveSetting(FEED_STATS_KEY, stats);
    if (posted) {
      await saveSetting(DEAL_QUEUE_KEY, queue);
      // 5,000, not 1,000: with ~13 keywords a smaller window could forget a
      // listing that is still live and post it a second time.
      await saveSetting(FEED_SEEN_KEY, [...seen].slice(-5000));
      // Re-read immediately before writing: the hourly track-record sweep writes
      // the same row, and a copy read at the start of this run (which can take
      // minutes) would overwrite its check results.
      let trackLog = (await getSetting(TRACK_LOG_KEY)) || [];
      let tracked = 0;
      for (const f of postedFinds) {
        const r = trackRecord.logFinds(trackLog, f);
        trackLog = r.log; tracked += r.added;
      }
      if (tracked) await saveSetting(TRACK_LOG_KEY, trackLog);
      // Candidates for the hourly #deals post. Re-read before writing: the
      // hourly job removes the find it posts from this same row.
      let hourlyPool = (await getSetting(HOURLY_POOL_KEY)) || [];
      for (const f of postedFinds) hourlyPool = feeds.addToHourlyPool(hourlyPool, f);
      await saveSetting(HOURLY_POOL_KEY, hourlyPool);
      const byCat = Object.entries(postedByCategory).map(([id, n]) => `${id} ${n}`).join(', ');
      console.log(`[feed:deals] Posted ${posted} find(s) to Elite monitors (${byCat}), ${queue.length} queued for Pro, ${tracked} logged for the track record.`);
    } else {
      // Always say something. A run that posts nothing is the common case and
      // has to be distinguishable from a run that never happened.
      console.log(`[feed:deals] Nothing posted this run — ${trace.join(' | ')}`);
    }

    await updateFeedHealth({ failures, searched });
  } catch (e) {
    console.error('[feed:deals] Fatal:', e.message);
  }
}

// Releases queued finds into their Pro monitor channel once the delay has elapsed.
async function flushDealQueue() {
  if (!SUPABASE_KEY) return;
  try {
    const queue = (await getSetting(DEAL_QUEUE_KEY)) || [];
    if (!queue.length) return;

    const now = Date.now();
    const due = queue.filter(q => q.dueAt <= now);
    if (!due.length) return;

    for (const item of due) {
      const payload = feeds.buildDealPayload({
        keyword: item.keyword,
        picks:   item.picks,
        median:  item.median,
        tier:    'pro',
      });
      // Finds queued before the Monitors switch carry no channelId; they belong in #deals.
      await postToFeedChannel(item.channelId || feeds.CHANNELS.deals, payload, `pro-${item.category || 'deals'}`);
    }

    await saveSetting(DEAL_QUEUE_KEY, queue.filter(q => q.dueAt > now));
    console.log(`[feed:deals] Released ${due.length} find(s) to Pro monitors.`);
  } catch (e) {
    console.error('[feed:deals] Flush failed:', e.message);
  }
}

// #deals — one find an hour, the biggest discount among Monitors finds that are
// at least 30 minutes old. Searches nothing; see feeds.pickHourlyFind.
async function postHourlyDeal() {
  if (!SUPABASE_KEY) return;
  try {
    const { choice, pool } = feeds.pickHourlyFind((await getSetting(HOURLY_POOL_KEY)) || []);
    if (!choice) {
      await saveSetting(HOURLY_POOL_KEY, pool);
      console.log(`[feed:hourly] No find old enough to post this hour (${pool.length} waiting).`);
      return;
    }
    const payload = feeds.buildDealPayload({ keyword: choice.keyword, picks: [choice.pick], median: choice.median, tier: 'hourly' });
    const ok = await postToFeedChannel(feeds.CHANNELS.deals, payload, 'hourly');
    // Removed from the pool only once it posted, so a failed post is retried next hour.
    if (ok) await saveSetting(HOURLY_POOL_KEY, pool);
    console.log(`[feed:hourly] ${ok ? 'Posted' : 'Could not post'} "${choice.keyword}" (${choice.pick.discountPct}% under) to #deals.`);
  } catch (e) {
    console.error('[feed:hourly] Failed:', e.message);
  }
}

// Every 10 minutes: fresh enough that the Elite edge is real, infrequent enough
// that a long keyword list does not keep a browser open continuously.
cron.schedule('*/10 * * * *', () => runDealFeed().catch(e => console.error('[feed:deals] Unhandled:', e.message)));
cron.schedule('* * * * *',    () => flushDealQueue().catch(e => console.error('[feed:deals] Unhandled flush:', e.message)));
// :45 — clear of the feed's :40 run and the track-record sweep at :05.
cron.schedule('45 * * * *',   () => postHourlyDeal().catch(e => console.error('[feed:hourly] Unhandled:', e.message)));

// ── The Market: weekly #whats-selling ────────────────────────────────────────
// The only channel in the category a non-subscriber can read, so it reports
// movement rather than listings — useful to someone who buys nothing this week,
// and it gives nothing away that Pro and Elite are paying for.
async function runWhatsSelling() {
  if (!SUPABASE_KEY) return;
  try {
    const stats = (await getSetting(FEED_STATS_KEY)) || {};
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const rows = Object.entries(stats).map(([keyword, s]) => {
      const recent = (s.medians || []).filter(m => m.t > weekAgo);
      if (recent.length < 2) return null;
      const first = recent[0].median;
      const last  = recent[recent.length - 1].median;
      return {
        keyword,
        median: last,
        medianChangePct: first ? Math.round(((last - first) / first) * 100) : 0,
        finds: s.finds || 0,
      };
    }).filter(Boolean);

    // A report built on one or two categories reads as broken rather than quiet.
    if (rows.length < 3) {
      console.log(`[feed:whats-selling] Only ${rows.length} categories with a week of data — skipping.`);
      return;
    }

    await postToFeedChannel(feeds.CHANNELS.whatsSelling, feeds.buildWhatsSellingPayload({ rows }), 'whats-selling');

    // Reset the weekly counters; the medians stay for trend continuity.
    // bestDiscountPct must reset too or the trend report would report an
    // all-time best as though it happened this week.
    for (const k of Object.keys(stats)) { stats[k].finds = 0; stats[k].bestDiscountPct = 0; }
    await saveSetting(FEED_STATS_KEY, stats);
    console.log(`[feed:whats-selling] Posted weekly summary across ${rows.length} categories.`);
  } catch (e) {
    console.error('[feed:whats-selling] Failed:', e.message);
  }
}

cron.schedule('0 18 * * 0', () => runWhatsSelling().catch(e => console.error('[feed:whats-selling] Unhandled:', e.message)), { timezone: 'Europe/London' });

// ── The Market: #price-drops (Pro+) ──────────────────────────────────────────
// Category going-rate drops, from the same hourly medians the deal feed already
// records. Costs nothing extra: no new searches, no Apify, no watchlist reads.
const PRICE_DROP_POSTED_KEY = 'price_drop_last_posted';

async function runPriceDrops() {
  if (!SUPABASE_KEY) return;
  try {
    const stats = (await getSetting(FEED_STATS_KEY)) || {};
    const drops = feeds.detectPriceDrops(stats);
    if (!drops.length) return;

    // A category that is drifting down stays "dropped" for days. Without this
    // the channel would repost the same three categories every six hours until
    // members mute it.
    const posted = (await getSetting(PRICE_DROP_POSTED_KEY)) || {};
    const now = Date.now();
    const fresh = drops.filter(d => !posted[d.keyword] || now - posted[d.keyword] > 3 * 24 * 60 * 60 * 1000);
    if (!fresh.length) return;

    await postToFeedChannel(feeds.CHANNELS.priceDrops, feeds.buildPriceDropPayload({ drops: fresh }), 'price-drops');
    fresh.forEach(d => { posted[d.keyword] = now; });
    await saveSetting(PRICE_DROP_POSTED_KEY, posted);
    console.log(`[feed:price-drops] Posted ${fresh.length} category drop(s).`);
  } catch (e) {
    console.error('[feed:price-drops] Failed:', e.message);
  }
}

cron.schedule('40 */6 * * *', () => runPriceDrops().catch(e => console.error('[feed:price-drops] Unhandled:', e.message)));

// ── The Market: #trend-reports (Pro+) ────────────────────────────────────────
// The paid depth behind #whats-selling — every category rather than the top six,
// with the week's best find. Posts before the free summary so Pro sees it first.
async function runTrendReport() {
  if (!SUPABASE_KEY) return;
  try {
    const stats = (await getSetting(FEED_STATS_KEY)) || {};
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const rows = Object.entries(stats).map(([keyword, s]) => {
      const recent = (s.medians || []).filter(m => m.t > weekAgo);
      if (recent.length < 2) return null;
      const first = recent[0].median;
      const last  = recent[recent.length - 1].median;
      return {
        keyword,
        median: last,
        medianChangePct: first ? Math.round(((last - first) / first) * 100) : 0,
        finds: s.finds || 0,
        bestDiscountPct: s.bestDiscountPct || 0,
      };
    }).filter(Boolean);

    if (!rows.length) {
      console.log('[feed:trend-report] No category has a week of data yet — skipping.');
      return;
    }

    await postToFeedChannel(feeds.CHANNELS.trendReports, feeds.buildTrendReportPayload({ rows }), 'trend-reports');
    console.log(`[feed:trend-report] Posted weekly report across ${rows.length} categories.`);
  } catch (e) {
    console.error('[feed:trend-report] Failed:', e.message);
  }
}

// Sunday 17:00 — an hour before the free #whats-selling summary, so the paid
// channel is genuinely first rather than a fuller version of old news.
// runWhatsSelling resets the find counters, so this must stay ahead of it.
cron.schedule('0 17 * * 0', () => runTrendReport().catch(e => console.error('[feed:trend-report] Unhandled:', e.message)), { timezone: 'Europe/London' });

// ── The Market: deal-feed track record ───────────────────────────────────────
// Rechecks posted finds at 2h / 24h / 72h against the seller's public wardrobe.
// One wardrobe read covers every due find from that seller. Capped per run so
// a busy feed day cannot keep the one shared Chromium occupied for an hour —
// anything over the cap is simply picked up by the next sweep.
const TRACK_SWEEP_MAX_SELLERS = 25;

async function runTrackRecordChecks() {
  if (!SUPABASE_KEY) return;
  if (!vintedBrowser?.vintedBrowserWardrobeStatus) {
    console.log('[feed:track-record] Browser flow unavailable — no checks run.');
    return;
  }
  try {
    const log = (await getSetting(TRACK_LOG_KEY)) || [];
    const due = trackRecord.dueChecks(log, Date.now());
    if (!due.length) {
      console.log(`[feed:track-record] No checks due (${log.length} find(s) logged).`);
      return;
    }

    const bySeller = new Map();
    for (const e of due) {
      if (!bySeller.has(e.sellerId)) bySeller.set(e.sellerId, []);
      bySeller.get(e.sellerId).push(e);
    }

    const updates = {};
    const tally = { present: 0, reserved: 0, gone: 0, unknown: 0 };
    let checked = 0, errors = 0;
    for (const sellerId of [...bySeller.keys()].slice(0, TRACK_SWEEP_MAX_SELLERS)) {
      const wardrobe = await vintedBrowser.vintedBrowserWardrobeStatus(sellerId);
      checked++;
      if (wardrobe?.error) {
        errors++;
        console.warn(`[feed:track-record] Seller ${sellerId}: ${wardrobe.error}`);
      }
      for (const e of bySeller.get(sellerId)) {
        const outcome = trackRecord.outcomeFromWardrobe(e.id, wardrobe);
        tally[outcome]++;
        updates[e.id] = trackRecord.applyCheck(e, outcome, Date.now());
      }
      // Every read failing means Vinted is unreachable, not that these sellers
      // are odd. Stop rather than spend the sweep confirming it.
      if (errors >= 3 && errors === checked) {
        console.warn('[feed:track-record] Three wardrobe reads failed in a row — stopping this sweep.');
        break;
      }
    }

    // Merge onto a fresh read: the deal feed may have appended finds meanwhile.
    const latest = (await getSetting(TRACK_LOG_KEY)) || [];
    await saveSetting(TRACK_LOG_KEY, latest.map(e => updates[e.id] || e));
    console.log(
      `[feed:track-record] Checked ${Object.keys(updates).length} find(s) across ${checked} seller(s): ` +
      `${tally.present} still up, ${tally.reserved} reserved, ${tally.gone} gone, ${tally.unknown} unknown · ` +
      `${errors} wardrobe error(s) · ${Math.max(0, bySeller.size - checked)} seller(s) deferred.`
    );
  } catch (e) {
    console.error('[feed:track-record] Sweep failed:', e.message);
  }
}

// Monthly, in the one free channel — this is proof for people who have not paid.
// Numbers only, no listing links: those are what Pro and Elite pay for.
async function runTrackRecordPost() {
  if (!SUPABASE_KEY) return;
  if (!TRACK_RECORD_PUBLIC) {
    console.log('[feed:track-record] Monthly post skipped — TRACK_RECORD_PUBLIC is off.');
    return;
  }
  try {
    const log = (await getSetting(TRACK_LOG_KEY)) || [];
    const summary = trackRecord.summarise(log, { days: 30 });
    if (!summary.enoughData) {
      console.log(`[feed:track-record] Only ${summary.resolved} resolved find(s) in 30 days (need ${trackRecord.MIN_RESOLVED}) — not posting.`);
      return;
    }
    await postToFeedChannel(feeds.CHANNELS.whatsSelling, trackRecord.buildTrackRecordPayload(summary), 'track-record');
    console.log(`[feed:track-record] Posted monthly record: ${summary.resolved} finds, ${summary.gone24hPct}% gone within 24h.`);
  } catch (e) {
    console.error('[feed:track-record] Monthly post failed:', e.message);
  }
}

// :05 past, clear of the deal feed's :00 run starting on the same browser.
cron.schedule('5 * * * *', () => runTrackRecordChecks().catch(e => console.error('[feed:track-record] Unhandled:', e.message)));
cron.schedule('0 19 1 * *', () => runTrackRecordPost().catch(e => console.error('[feed:track-record] Unhandled post:', e.message)), { timezone: 'Europe/London' });

// ── The Market: monthly niche report ─────────────────────────────────────────
// Data: a 3-hourly sweep of the report keywords into one entry per niche per
// day (niche_daily, kept 90 days). Report: built on demand from that data, AI
// notes added, stored as a draft. On the 1st the draft is DM'd to the owner;
// nothing reaches a channel until the owner runs /nichereport post, which
// publishes the stored draft — the exact object that was previewed.
// v2 (2026-09-13): samples now also drop kids' sizes (size_title) and wrong
// brands. The v1 row held a few hours of samples on the older filter; mixing
// them in would show a fake day-on-day jump on Vendex, so the series restarts.
const NICHE_DAILY_KEY  = 'niche_daily_v2';
const NICHE_DRAFT_KEY  = 'niche_report_draft';
const NICHE_POSTED_KEY = 'niche_report_posted';
const NICHE_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function runNicheSweep() {
  if (!SUPABASE_KEY) return;
  if (!vintedBrowser?.vintedBrowserSearchItems) {
    console.log('[niche] Browser flow unavailable — no sweep run.');
    return;
  }
  try {
    const keywords = (await getSetting('report_keywords')) || niche.DEFAULT_REPORT_KEYWORDS;
    if (!Array.isArray(keywords) || !keywords.length) {
      console.log('[niche] report_keywords is empty — no sweep run.');
      return;
    }

    const samples = [];
    const trace = [];
    let failures = 0;
    // Serial on purpose: this shares the one Chromium with the deal feed and
    // alerts, and nothing about a 3-hourly sample needs to be fast.
    for (const keyword of keywords) {
      try {
        const { items, error } = await vintedBrowser.vintedBrowserSearchItems(keyword, null, 48);
        if (error) {
          failures++;
          trace.push(`${keyword}: error`);
          console.warn(`[niche] "${keyword}" search failed: ${error}`);
          if (failures >= 3 && !samples.length) { trace.push('stopped — Vinted unreachable'); break; }
          continue;
        }
        const sample = niche.sampleFromItems(items, Date.now(), keyword);
        if (!sample) { trace.push(`${keyword}: too few usable (${items.length} results)`); continue; }
        samples.push({ keyword, sample });
        trace.push(`${keyword}: £${sample.median} n=${sample.n}`);
      } catch (e) {
        failures++;
        console.warn(`[niche] "${keyword}" threw: ${e.message}`);
      }
    }

    if (samples.length) {
      // Read right before writing — nothing else writes this row, but a slow
      // sweep should never hold a stale copy for its whole run.
      let daily = (await getSetting(NICHE_DAILY_KEY)) || {};
      for (const { keyword, sample } of samples) daily = niche.recordSample(daily, keyword, sample);
      await saveSetting(NICHE_DAILY_KEY, daily);
    }
    console.log(`[niche] Sweep recorded ${samples.length}/${keywords.length} niche(s) — ${trace.join(' | ')}`);
  } catch (e) {
    console.error('[niche] Sweep failed:', e.message);
  }
}

async function nicheNotesFromClaude(report) {
  if (!ai) return { error: 'ANTHROPIC_API_KEY not set' };
  try {
    const { params, options } = niche.buildNotesParams(report);
    const msg = await ai.messages.create(params, options);
    return niche.extractNotesJson(msg);
  } catch (e) {
    return { error: e.message };
  }
}

// Returns { report } when there is enough data (and saves it as the draft), or
// { report, status } when there is not.
async function generateNicheReport() {
  const daily = (await getSetting(NICHE_DAILY_KEY)) || {};
  const trackLog = (await getSetting(TRACK_LOG_KEY)) || [];
  // With the record paused the report gets no deal-speed evidence, so its
  // notes cannot lean on figures that are not being shown anywhere else.
  const feedKeywords = TRACK_RECORD_PUBLIC ? trackRecord.summarise(trackLog, { days: 30 }).keywords : [];

  let report = niche.buildReport(daily, feedKeywords);
  if (!report.enoughData) return { report, status: niche.dataStatus(daily) };

  // The report works without Claude: code-written notes are already in place,
  // and a failed or refused call only means they stay.
  const result = await nicheNotesFromClaude(report);
  if (result.parsed) report = niche.applyNotes(report, result.parsed);
  report.aiError    = result.error || null;
  report.aiModel    = result.model || null;
  report.aiFellBack = !!result.fellBack;

  await saveSetting(NICHE_DRAFT_KEY, report);
  console.log(
    `[niche] Draft built: ${report.rows.length} niches · ` +
    (report.aiUsed
      ? `notes from ${report.aiModel}${report.aiFellBack ? ' (fallback)' : ''}, ${report.aiDropped} rejected`
      : `AI notes not used (${report.aiError || 'nothing usable returned'})`)
  );
  return { report };
}

function nichePreviewPayload(report) {
  const notesLine = report.aiUsed
    ? `Notes written by ${report.aiModel}${report.aiFellBack ? ' (after a fallback)' : ''}${report.aiDropped ? `, ${report.aiDropped} rejected for containing figures and replaced` : ''}.`
    : `Notes are code-written — AI was not used (${report.aiError || 'nothing usable returned'}).`;
  const skipped = report.skipped.length ? ` ${report.skipped.length} niche(s) left out for too little data.` : '';
  const pro   = niche.buildNicheReportPayload(report, { tier: 'pro' });
  const elite = niche.buildNicheReportPayload(report, { tier: 'elite' });
  return {
    content: `**Draft — not posted.** ${notesLine}${skipped}\nPro version first, Elite second. Run \`/nichereport post\` to publish this exact draft.`,
    embeds: [...pro.embeds, ...elite.embeds],
  };
}

async function postNicheReport(report) {
  const prev = (await getSetting(NICHE_POSTED_KEY)) || {};
  // Edit in place only within the same month; a new month is a new post.
  const posted = prev.label === report.label ? { ...prev } : {};
  const results = [];

  for (const [tier, channelId] of [['pro', feeds.CHANNELS.trendReports], ['elite', feeds.CHANNELS.eliteLounge]]) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) { results.push(`${tier}: channel ${channelId} not found — skipped`); continue; }
    const payload = niche.buildNicheReportPayload(report, { tier });

    if (posted[tier]) {
      try {
        const existing = await channel.messages.fetch(posted[tier]);
        await existing.edit(payload);
        results.push(`${tier}: edited the existing post in <#${channelId}>`);
        continue;
      } catch (e) {
        console.warn(`[niche] Stored ${tier} message gone, posting a new one:`, e.message);
      }
    }
    const sent = await channel.send(payload);
    posted[tier] = sent.id;
    results.push(`${tier}: posted to <#${channelId}>`);
  }

  await saveSetting(NICHE_POSTED_KEY, { ...posted, label: report.label, postedAt: Date.now() });
  console.log(`[niche] Published "${report.label}": ${results.join(' · ')}`);
  return results;
}

async function runMonthlyNicheDraft() {
  if (!SUPABASE_KEY) return;
  try {
    const { report, status } = await generateNicheReport();
    const owner = await client.users.fetch(OWNER_ID);
    if (status) {
      await owner.send(niche.buildStatusPayload(status));
      console.log(`[niche] Monthly draft skipped — ${status.ready}/${status.minKeywords} niches ready. Status DM sent.`);
      return;
    }
    await owner.send(nichePreviewPayload(report));
    console.log('[niche] Monthly draft DM\'d to owner for approval.');
  } catch (e) {
    console.error('[niche] Monthly draft failed:', e.message);
  }
}

// :20 past every third hour — clear of the deal feed's :00 start and the
// track-record sweep at :05.
cron.schedule('20 */3 * * *', () => runNicheSweep().catch(e => console.error('[niche] Unhandled sweep:', e.message)));
cron.schedule('0 9 1 * *', () => runMonthlyNicheDraft().catch(e => console.error('[niche] Unhandled monthly draft:', e.message)), { timezone: 'Europe/London' });

// A fixed public-only snapshot for last week's downloadable price cards.
cron.schedule('15 9 * * 1', () => priceGuides.updateWeeklyCards().catch(e => console.error('[price-guides] Weekly cards:', e.message)), { timezone: 'Europe/London' });

// Opt-in, active-Elite reminders. Stored cooldowns survive deployments.
let repriceSweepRunning = false;
async function runRepriceCoachReminders() {
  // Netlify owns reminders after the web migration. Opt into the legacy
  // Railway runner explicitly only when intentionally moving ownership back.
  if (process.env.REPRICE_RUNNER !== 'railway') return;
  if (repriceSweepRunning || !SUPABASE_KEY || !client.isReady()) return;
  repriceSweepRunning = true;
  try {
    const daily = (await featureSettings.getSetting(NICHE_DAILY_KEY)) || {};
    for (let offset = 0; ; offset += 100) {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?tier=eq.elite&subscription_status=eq.active&select=id,discord_id,is_banned&limit=100&offset=${offset}&order=id`, { headers: SB_HDR() });
      if (!response.ok) throw new Error('Could not read Elite membership');
      const profiles = await response.json();
      if (!Array.isArray(profiles)) throw new Error('Invalid membership response');
      for (const profile of profiles) {
        if (!profile.discord_id || profile.is_banned) continue;
        try {
          const preferences = await featureSettings.getSetting(`reprice_preferences_${profile.id}`);
          if (!preferences?.enabled) continue;
          const snapshot = await featureSettings.getSetting(`vinted_inventory_${profile.id}`);
          const suggestions = repriceCoach.recommendations(snapshot, daily);
          const sent = (await featureSettings.getSetting(`reprice_sent_${profile.id}`)) || {};
          const now = Date.now();
          const due = repriceCoach.dueItems(suggestions.items, sent, now);
          if (!due.length) continue;
          const current = await getProfileByUserId(profile.id);
          if (!memberIntelligence.capabilities(current).repriceCoach || current.is_banned || !(await featureSettings.getSetting(`reprice_preferences_${profile.id}`))?.enabled) continue;
          const recipient = await client.users.fetch(profile.discord_id);
          const marked = { ...sent };
          for (const item of due) marked[item.id] = now;
          await featureSettings.saveSetting(`reprice_sent_${profile.id}`, marked);
          try { await recipient.send(repriceCoach.dmPayload(due)); }
          catch (e) { await featureSettings.saveSetting(`reprice_sent_${profile.id}`, sent); throw e; }
        } catch (e) { console.warn('[reprice-coach] Reminder skipped:', e.message); }
      }
      if (profiles.length < 100) break;
    }
  } catch (e) { console.error('[reprice-coach] Sweep failed:', e.message); }
  finally { repriceSweepRunning = false; }
}
cron.schedule('10 12 * * *', () => runRepriceCoachReminders(), { timezone: 'Europe/London' });

// ── Free trial ────────────────────────────────────────────────────────────────
// Grants TRIAL_ROLE_ID for trial.TRIAL_DAYS, once per account, ever.
async function handleTrialButton(interaction) {
  const discordId = interaction.user.id;

  // Ephemeral throughout: a channel full of "X started a trial" is noise, and
  // it tells everyone else exactly who has not paid.
  await interaction.deferReply({ ephemeral: true });

  const existing = trialState.users[discordId];
  if (existing?.done) {
    return interaction.editReply(trial.buildTrialRefusedPayload({ reason: 'used' }));
  }
  if (existing && existing.e > Date.now()) {
    return interaction.editReply(trial.buildTrialRefusedPayload({ reason: 'active' }));
  }

  // Never hand a trial to someone already paying — it would grant Pro to a
  // Basic subscriber and downgrade them when it expired.
  const profile = await getProfileByDiscordId(discordId);
  if (profile?.subscription_status === 'active') {
    return interaction.editReply(trial.buildTrialRefusedPayload({ reason: 'subscribed' }));
  }

  const member = interaction.member
    || await interaction.guild?.members.fetch(discordId).catch(() => null);
  if (!member) {
    return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Server Only')
      .setDescription('Start your trial from inside the Vendora Discord server.')] });
  }

  try {
    await member.roles.add(TRIAL_ROLE_ID);
  } catch (e) {
    console.error(`[trial] Could not add role to ${member.user.tag}:`, e.message);
    return interaction.editReply({ embeds: [baseEmbed('#f87171').setTitle('Could not start trial')
      .setDescription('Something went wrong assigning your trial role. Let the owner know and it will be sorted.')] });
  }

  const now = Date.now();
  const endsAt = now + trial.TRIAL_DAYS * 24 * 60 * 60 * 1000;
  // Written AFTER the role lands: a record with no role is a member who thinks
  // they used their trial and got nothing.
  trialState.users[discordId] = { s: now, e: endsAt, done: false, warned: false };
  await saveTrials();

  // DM as well as the ephemeral. The ephemeral vanishes on refresh; this is what
  // they can find again on day four. It also opens the DM channel, which is what
  // makes the day-6 and closing DMs deliverable at all.
  await sendDM(member, trial.buildTrialStartedDM({ username: member.user.username, endsAt }))
    .catch(e => console.warn(`[trial] Start DM failed for ${member.user.tag}:`, e.message));

  console.log(`[trial] Started for ${member.user.tag} (${discordId}), ends ${new Date(endsAt).toISOString()}`);
  return interaction.editReply(trial.buildTrialStartedPayload({ username: interaction.user.username, endsAt }));
}

// Sweep rather than a timer per trial: setTimeout does not survive a Railway
// redeploy, and this bot redeploys constantly. Every expiry is recomputed from
// the stored end time, so a restart costs nothing.
async function runTrialSweep() {
  if (!SUPABASE_KEY) return;
  const users = trialState.users || {};
  const ids = Object.keys(users);
  if (!ids.length) return;

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) { console.warn('[trial] Guild unavailable — skipping sweep'); return; }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let expired = 0, warned = 0, dirty = false;

  for (const discordId of ids) {
    const t = users[discordId];
    if (t.done) continue;

    // Converted mid-trial. assignRole only manages the tier roles in ROLE_IDS,
    // so the trial role would otherwise linger and keep a Basic subscriber in
    // the Pro feed channels until their trial happened to expire.
    const prof = await getProfileByDiscordId(discordId).catch(() => null);
    if (prof?.subscription_status === 'active') {
      const m = await guild.members.fetch(discordId).catch(() => null);
      if (m) {
        try { await m.roles.remove(TRIAL_ROLE_ID); }
        catch (e) { console.warn(`[trial] Could not remove role from ${m.user.tag}:`, e.message); }
      }
      t.done = true; dirty = true;
      console.log(`[trial] ${discordId} subscribed mid-trial — trial closed, role removed`);
      continue;
    }

    // Day 6 nudge — one day of access left to act on it.
    if (!t.warned && t.e - now <= dayMs && t.e > now) {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (member) {
        await sendDM(member, trial.buildTrialEndingPayload({ username: member.user.username, siteUrl: SITE_URL }))
          .catch(() => {});
      }
      t.warned = true; warned++; dirty = true;
      continue;
    }

    if (t.e > now) continue;

    // Expired. Strip the role, mark done, tell them.
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (member) {
      try { await member.roles.remove(TRIAL_ROLE_ID); }
      catch (e) { console.warn(`[trial] Could not remove role from ${member.user.tag}:`, e.message); }
      await sendDM(member, trial.buildTrialEndedPayload({ username: member.user.username, siteUrl: SITE_URL }))
        .catch(() => {});
    }
    // done stays forever — it is the record that this account has had its trial.
    t.done = true;
    expired++; dirty = true;
  }

  if (dirty) await saveTrials();
  if (expired || warned) console.log(`[trial] Sweep — ${expired} expired, ${warned} warned.`);
}

cron.schedule('*/15 * * * *', () => runTrialSweep().catch(e => console.error('[trial] Sweep failed:', e.message)));

// ── Onboarding quiz handler ──────────────────────────────────────────────────
// Advances the quiz in place: each click edits the same DM rather than posting
// a new one, so the user ends with one message showing their recommendation
// instead of five messages of history.
async function handleOnboardingButton(interaction) {
  const answers = onboarding.parseAnswers(interaction.customId);
  // A malformed id means a tampered or stale button — acknowledge it so the
  // client doesn't show "interaction failed", but do nothing else.
  if (!answers) {
    return interaction.reply({ content: `That option is no longer valid. You can pick a plan any time at ${DASHBOARD_URL}`, ephemeral: true });
  }

  // A bare prefix means the "Find my plan" button in the outreach DM — the only
  // place a quiz can be *started* by a click. The welcome DM ships question one
  // already rendered, so its first click always carries an answer.
  if (answers.length === 0) await bumpMetric('quiz_started');

  if (answers.length < onboarding.QUESTIONS.length) {
    return interaction.update(onboarding.buildQuestion(answers.length, answers));
  }

  const payload = onboarding.buildRecommendation(answers, {
    tierNames:    TIER_NAMES,
    tierPrices:   TIER_PRICES,
    dashboardUrl: DASHBOARD_URL,
  });
  await interaction.update(payload);
  await bumpMetric('quiz_completed');
  const { tier, total } = onboarding.recommendTier(answers);
  console.log(`[onboarding] ${interaction.user.tag} finished quiz — answers ${answers.join('')}, score ${total} -> ${tier}`);
}

// ── Day-one affiliate follow-up ──────────────────────────────────────────────
// A single settings row holds the whole queue ({ discordId: dueAtMs }) rather
// than one row per user: the sweep needs to read every pending entry, and
// getSetting is key-based with no prefix scan.
const AFFILIATE_DM_QUEUE_KEY = 'affiliate_dm_queue';
const AFFILIATE_DM_DELAY_MS  = 24 * 60 * 60 * 1000;
const AFFILIATE_DM_PER_SWEEP = 40;   // stay well clear of Discord's DM rate limits
const AFFILIATE_DM_GAP_MS    = 1500;

async function queueAffiliateDM(discordId) {
  if (!SUPABASE_KEY || !discordId || discordId === OWNER_ID) return;
  try {
    const queue = (await getSetting(AFFILIATE_DM_QUEUE_KEY)) || {};
    // Don't reset the clock if they leave and rejoin — the first join wins.
    if (queue[discordId]) return;
    queue[discordId] = Date.now() + AFFILIATE_DM_DELAY_MS;
    await saveSetting(AFFILIATE_DM_QUEUE_KEY, queue);
  } catch (e) {
    console.warn('[affiliate-dm] Could not queue', discordId, '-', e.message);
  }
}

async function runAffiliateDMSweep() {
  if (!SUPABASE_KEY) return;
  const queue = (await getSetting(AFFILIATE_DM_QUEUE_KEY)) || {};
  const now = Date.now();
  const due = Object.entries(queue).filter(([, at]) => now >= at).slice(0, AFFILIATE_DM_PER_SWEEP);
  if (!due.length) return;

  let sent = 0;
  for (const [discordId] of due) {
    try {
      const user = await client.users.fetch(discordId);
      await user.send(onboarding.buildAffiliateReminder({
        username: user.username,
        rate:     AFFILIATE_RATE_PCT,
        siteUrl:  SITE_URL,
      }));
      sent++;
    } catch (e) {
      // Closed DMs, left the server, deleted account — all permanent for our
      // purposes. Drop them either way so the queue cannot grow forever.
      console.log(`[affiliate-dm] Skipping ${discordId}: ${e.message}`);
    }
    delete queue[discordId];
    await new Promise(r => setTimeout(r, AFFILIATE_DM_GAP_MS));
  }

  await saveSetting(AFFILIATE_DM_QUEUE_KEY, queue);
  console.log(`[affiliate-dm] Swept ${due.length} due, sent ${sent}.`);
}

cron.schedule('11 * * * *', () => runAffiliateDMSweep().catch(e => console.error('[affiliate-dm] Sweep failed:', e.message)));

// ── Outreach campaign — existing members with no active plan ──────────────────
// Two DMs per person: a setup prompt, then the affiliate pitch 24h after THAT
// PERSON'S setup DM. Because stage 1 is already drip-fed, stage 2 inherits the
// same spread instead of landing as one burst a day later.
//
// Rate: OUTREACH_MAX_PER_SWEEP per hourly sweep, so ~72 DMs/day across both
// stages. A 283-member server completes in about four days. Deliberately slow —
// the cap is the whole point, not a performance limit.
const OUTREACH_STATE_KEY    = 'outreach_state';
const OUTREACH_METRICS_KEY  = 'outreach_metrics';
const OUTREACH_MAX_PER_SWEEP = 3;
const OUTREACH_DM_GAP_MS     = 2000;
const OUTREACH_AFFILIATE_MS  = 24 * 60 * 60 * 1000;

async function loadOutreachState() {
  const raw = await getSetting(OUTREACH_STATE_KEY);
  return { rolled_out_at: null, paused: false, users: {}, ...(raw || {}) };
}
const saveOutreachState = (state) => saveSetting(OUTREACH_STATE_KEY, state);

// Read-modify-write. Concurrent bumps could in principle lose an increment, but
// these fire at most a few times an hour and the numbers are directional, not
// billing — a lock would cost more than it protects.
async function bumpMetric(field, by = 1) {
  try {
    const m = (await getSetting(OUTREACH_METRICS_KEY)) || {};
    m[field] = Number(m[field] || 0) + by;
    if (!m.period_start) m.period_start = Date.now();
    await saveSetting(OUTREACH_METRICS_KEY, m);
  } catch (e) {
    console.warn('[metrics] Could not bump', field, '-', e.message);
  }
}

// Every Discord id with an active plan, paginated. Self-contained so this
// campaign does not depend on any other subsystem's helper.
async function fetchActivePlanDiscordIds() {
  const ids = new Set();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=discord_id&subscription_status=eq.active&limit=${PAGE}&offset=${offset}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) throw new Error(`profiles query failed (${r.status})`);
    const rows = await r.json();
    for (const row of rows) if (row.discord_id) ids.add(String(row.discord_id));
    if (!Array.isArray(rows) || rows.length < PAGE) break;
  }
  return ids;
}

// Seed every current non-subscriber. Existing entries are left alone so a second
// run tops up with new members rather than restarting anyone's sequence.
async function runOutreachRollout(guild) {
  const state  = await loadOutreachState();
  const active = await fetchActivePlanDiscordIds();
  const members = await guild.members.fetch();

  let seeded = 0;
  for (const [id, member] of members) {
    if (member.user.bot || id === OWNER_ID) continue;
    if (active.has(id)) continue;
    if (state.users[id]) continue;
    state.users[id] = { s: 1, n: Date.now() };
    seeded++;
  }
  state.rolled_out_at = state.rolled_out_at || Date.now();
  state.paused = false;
  await saveOutreachState(state);
  return { seeded, tracked: Object.keys(state.users).length };
}

async function runOutreachSweep() {
  const state = await loadOutreachState();
  if (!state.rolled_out_at || state.paused) return;

  let active;
  try {
    active = await fetchActivePlanDiscordIds();
  } catch (e) {
    // Without this list we cannot tell subscribers from non-subscribers, and
    // pitching "get set up" at a paying customer is worse than sending nothing.
    console.error('[outreach] Aborting sweep — could not load subscribers:', e.message);
    return;
  }

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) { console.error('[outreach] Guild unavailable — skipping sweep'); return; }

  const now = Date.now();
  const due = Object.entries(state.users)
    .filter(([, u]) => u.n && u.n <= now)
    .sort((a, b) => a[1].n - b[1].n)
    .slice(0, OUTREACH_MAX_PER_SWEEP);
  if (!due.length) return;

  let sent = 0, closed = 0, other = 0, dropped = 0;

  for (const [discordId, u] of due) {
    // Subscribed or left since being seeded — drop them entirely.
    if (active.has(discordId)) { delete state.users[discordId]; dropped++; continue; }
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) { delete state.users[discordId]; dropped++; continue; }

    const isSetup  = u.s === 1;
    const payload  = isSetup
      ? outreach.buildSetupPayload({ username: member.user.username, loginUrl: LOGIN_URL })
      : outreach.buildOutreachAffiliatePayload({ username: member.user.username, rate: AFFILIATE_RATE_PCT });

    try {
      await member.send(payload);
      sent++;
      await bumpMetric(isSetup ? 'setup_sent' : 'affiliate_sent');
    } catch (e) {
      // 50007 = "Cannot send messages to this user": DMs closed or the bot is
      // blocked. Entirely normal, expect a large minority. Anything else is a
      // real signal and is counted separately so it stays visible in the report.
      if (e.code === 50007) { closed++; await bumpMetric('dm_closed'); }
      else {
        other++;
        await bumpMetric('dm_failed_other');
        console.warn(`[outreach] DM failed for ${member.user.tag} (code ${e.code}): ${e.message}`);
      }
    }

    // Advance regardless of delivery: a closed DM must not be retried forever.
    if (isSetup) state.users[discordId] = { s: 2, n: Date.now() + OUTREACH_AFFILIATE_MS };
    else         delete state.users[discordId];

    await new Promise(r => setTimeout(r, OUTREACH_DM_GAP_MS));
  }

  await saveOutreachState(state);
  console.log(`[outreach] Sweep — sent ${sent}, dms-closed ${closed}, other-fail ${other}, dropped ${dropped}, remaining ${Object.keys(state.users).length}`);
}

cron.schedule('27 * * * *', () => runOutreachSweep().catch(e => console.error('[outreach] Sweep failed:', e.message)));

// Weekly report — Wednesday 12:00 UK time. node-cron uses the container's clock
// (Railway runs UTC), so the timezone is pinned explicitly or this drifts by an
// hour every time BST starts or ends.
async function sendWeeklyDMReport() {
  const m     = (await getSetting(OUTREACH_METRICS_KEY)) || {};
  const state = await loadOutreachState();

  const start = m.period_start ? new Date(m.period_start) : null;
  const fmt   = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const periodLabel = start ? `${fmt(start)} – ${fmt(new Date())}` : 'since launch';

  const remaining = Object.keys(state.users).length;
  const total     = Number(m.setup_sent || 0) + remaining;
  const campaign  = {
    rolled_out_at: state.rolled_out_at,
    paused:        state.paused,
    total,
    done:          total - remaining,
    remaining,
    daysLeft:      Math.ceil(remaining / (OUTREACH_MAX_PER_SWEEP * 24)),
  };

  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send(outreach.buildWeeklyReport(m, { periodLabel, campaign }));
    console.log('[report] Weekly DM report sent to owner.');
  } catch (e) {
    console.error('[report] Could not send weekly report:', e.message);
    return; // keep the counters so nothing is lost when it could not be delivered
  }

  await saveSetting(OUTREACH_METRICS_KEY, { period_start: Date.now() });
}

cron.schedule('0 12 * * 3', () => sendWeeklyDMReport().catch(e => console.error('[report] Weekly report failed:', e.message)), { timezone: 'Europe/London' });

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
  if (max_price !== undefined) {
    if (max_price === null || max_price === '') {
      update.max_price = null;
    } else {
      // Number(max_price) used to be written unchecked — "abc" became NaN.
      const n = Number(max_price);
      if (!Number.isFinite(n) || n <= 0 || n > 10000) {
        return res.status(400).json({ error: 'max_price must be a positive amount in pounds.' });
      }
      update.max_price = Math.round(n * 100) / 100;
    }
  }
  if (!Object.keys(update).length)    return res.status(400).json({ error: 'Nothing to update — send auto_buy or max_price' });

  // Auto-buy spends the member's own money on Vinted, so it only runs under a
  // price ceiling. Checked against the alert as it WILL be after this update.
  const nextAutoBuy = 'auto_buy' in update ? update.auto_buy : alert.auto_buy;
  const nextMax     = 'max_price' in update ? update.max_price : alert.max_price;
  if (nextAutoBuy && !(Number(nextMax) > 0)) {
    return res.status(400).json({ error: 'Set a max price on this alert before turning on auto-buy.' });
  }

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
  // Elite-only, but still capped: this fans out to 30 AI calls per invocation.
  if (!enforceApiLimit(res, user.id, 'search', profile.tier, discordIdFromUser(user))) return;
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

