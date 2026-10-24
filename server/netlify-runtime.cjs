'use strict';
const { randomUUID } = require('node:crypto');
const { createRouter } = require('./http-router.cjs');
const { createAtomicSettings } = require('./atomic-settings.cjs');
const { createQuotas } = require('./web-quotas.cjs');
const { createDiscord } = require('./discord-http.cjs');
const { createFeatureSettings } = require('../bot/feature-settings');
const { createGroqClient } = require('../bot/groq-shim');
const intelligence = require('../bot/intelligence');
const member = require('../bot/member-intelligence');
const { registerPriceGuides } = require('../bot/price-guides');

function createAI(env, request) {
  if (env.GROQ_API_KEY) return createGroqClient(env.GROQ_API_KEY, { fetchImpl: request, timeoutMs: 25000 });
  if (!env.ANTHROPIC_API_KEY) return null;
  return { messages: { async create(params) {
    const response = await request('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error('AI provider is unavailable');
    return response.json();
  } } };
}

function createWebRuntime({ env = process.env, request = fetch, settings, atomic, ai, discord, clock = Date.now } = {}) {
  const url = env.SUPABASE_URL || 'https://fqfanqtybvnurhzkoxwr.supabase.co';
  const key = env.SUPABASE_SERVICE_KEY;
  const store = settings || createFeatureSettings({ url, key, request });
  const state = atomic || createAtomicSettings({ url, key, request });
  const quotas = createQuotas(state, { secret: key || 'unconfigured', now: clock });
  const model = ai === undefined ? createAI(env, request) : ai;
  const messenger = discord || createDiscord({ token: env.DISCORD_BOT_TOKEN, request });
  const router = createRouter();
  const dbHeaders = () => ({ apikey: key, Authorization: `Bearer ${key}` });
  async function requireAuth(req, res) {
    const match = /^Bearer ([^\s]{20,8192})$/.exec(req.headers.authorization || '');
    if (!match) { res.status(401).json({ error: 'Please sign in to use member support.' }); return null; }
    if (!key) throw new Error('Database authentication is not configured');
    const response = await request(url + '/auth/v1/user', { headers: { apikey: key, Authorization: 'Bearer ' + match[1] }, signal: AbortSignal.timeout(10000) });
    if ([401, 403].includes(response.status)) { res.status(401).json({ error: 'Your session expired. Please sign in again.' }); return null; }
    if (!response.ok) throw new Error('Could not verify the session');
    const user = await response.json();
    if (!user?.id || typeof user.id !== 'string') { res.status(401).json({ error: 'Invalid session.' }); return null; }
    return user;
  }
  async function getProfileByUserId(id) {
    const response = await request(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=tier,subscription_status,is_banned,discord_id`, { headers: dbHeaders(), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Could not check membership');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid membership response');
    return rows[0] || null;
  }
  async function enforceApiLimit(res, id, group, tier) {
    const limit = await quotas.take('member', id, tier);
    if (!limit.allowed) { res.set('Retry-After', limit.retryAfter); res.status(429).json({ error: 'Your support usage limit has been reached. Please try again later or contact support.' }); return false; }
    res.set('X-RateLimit-Limit', limit.limit); res.set('X-RateLimit-Remaining', limit.remaining);
    return true;
  }
  member.registerMemberIntelligence(router.app, { requireAuth, getProfileByUserId, ...store, enforceApiLimit, getAI: () => model });
  const priceGuides = registerPriceGuides(router.app, store);

  router.app.post('/api/intelligence', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const messages = intelligence.sanitizeMessages(req.body?.messages);
    if (!messages.length) return res.status(400).json({ error: 'Ask Vendora Intel a question to get started.' });
    if (!model) return res.status(503).json({ error: 'Vendora Intel is temporarily unavailable.' });
    const result = await quotas.take('public', quotas.visitor(req.ip));
    if (!result.allowed) return res.set('Retry-After', result.retryAfter).status(429).json({ error: 'Vendora Intel is busy. Please try again later.' });
    try {
      const answer = await model.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, system: intelligence.buildSystemPrompt(), messages });
      const text = intelligence.toPlainText(answer.content?.filter(c => c.text).map(c => c.text).join('\n'));
      if (!text) throw new Error('Empty AI response');
      return res.json({ ok: true, response: text });
    } catch { return res.status(503).json({ error: 'Vendora Intel is busy. Please try again shortly.' }); }
  });

  // Customer-controlled handoff: this only sends after the existing support
  // form is explicitly submitted. Merely opening chat never sends a message.
  router.app.post('/api/support/ticket', async (req, res) => {
    const user = await requireAuth(req, res); if (!user) return;
    const profile = await getProfileByUserId(user.id);
    if (profile?.is_banned) return res.status(403).json({ error: 'This account cannot submit support tickets.' });
    const text = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const subject = typeof req.body.subject === 'string' ? req.body.subject.trim().slice(0, 100) : 'General enquiry';
    if (!text || text.length > 1800) return res.status(400).json({ error: 'Write a support message of 1–1,800 characters.' });
    if (!env.DISCORD_BOT_TOKEN || !env.OWNER_DISCORD_ID) return res.status(503).json({ error: 'Please contact Vendora support directly in Discord.' });
    const limit = await quotas.take('support', user.id);
    if (!limit.allowed) return res.set('Retry-After', limit.retryAfter).status(429).json({ error: 'Please wait before sending another support message.' });
    const id = randomUUID().slice(0, 8);
    const discordId = profile?.discord_id || user.user_metadata?.provider_id || 'unavailable';
    const safe = s => String(s).replace(/[@`*_~<>]/g, '').slice(0, 1800);
    await messenger.sendDM(env.OWNER_DISCORD_ID, `Vendora support · ${id}\nFrom Discord ID: ${safe(discordId)}\nSubject: ${safe(subject)}\n\n${safe(text)}`);
    return res.json({ ok: true, ticketId: id });
  });
  return { handle: router.handle, store, atomic: state, priceGuides, getProfileByUserId, messenger, request, url, key, env };
}
module.exports = { createWebRuntime, createAI };
