// Onboarding quiz + day-one affiliate follow-up.
//
// Kept out of index.js because both are pure payload builders: they take plain
// values and return Discord message objects, so they can be previewed and unit
// tested without a client, a token, or a database.
//
// THE QUIZ IS STATELESS BY DESIGN. Every answer lives in the button's customId
// ("onb:2130"), never in memory or Supabase. A redeploy mid-quiz therefore costs
// nothing — the next click still carries the full history. Discord allows 100
// characters of customId and we use at most 8.

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

const PINK = '#e8217a';
const GOLD = '#e8a121';

// Four questions, four options each. `score` is what the option contributes to
// the plan recommendation — 0 = lightest use, 3 = heaviest. Order matters: the
// index within `options` is what gets written into the customId.
const QUESTIONS = [
  {
    key: 'experience',
    title: 'How long have you been reselling?',
    options: [
      { label: 'Just getting started', score: 0 },
      { label: 'Under a year',         score: 1 },
      { label: '1–3 years',            score: 2 },
      { label: '3+ years',             score: 3 },
    ],
  },
  {
    key: 'volume',
    title: 'How many items do you list in a typical week?',
    options: [
      { label: '0–5',   score: 0 },
      { label: '6–20',  score: 1 },
      { label: '21–50', score: 2 },
      { label: '50+',   score: 3 },
    ],
  },
  {
    key: 'goal',
    title: "What's your goal with reselling right now?",
    options: [
      { label: 'A bit of extra cash',        score: 0 },
      { label: 'Steady side income',         score: 1 },
      { label: 'Replace my day job',         score: 2 },
      { label: 'Scale a business I run',     score: 3 },
    ],
  },
  {
    key: 'friction',
    title: 'What slows you down most?',
    options: [
      { label: 'Writing listings',           score: 0 },
      { label: 'Pricing decisions',          score: 1 },
      { label: 'Finding stock worth buying', score: 2 },
      { label: 'Juggling several platforms', score: 3 },
    ],
  },
];

// "onb:" + one digit per answer given so far.
const CUSTOM_ID_PREFIX = 'onb:';

// Parse the answer string out of a customId. Returns null when it isn't ours or
// contains anything other than valid option indexes — a malformed id must never
// index into QUESTIONS.
function parseAnswers(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const raw = customId.slice(CUSTOM_ID_PREFIX.length);
  if (raw.length > QUESTIONS.length) return null;
  const answers = [];
  for (let i = 0; i < raw.length; i++) {
    const n = Number(raw[i]);
    // Each digit must be a real option index for the question it answers.
    if (!Number.isInteger(n) || n < 0 || n >= QUESTIONS[i].options.length) return null;
    answers.push(n);
  }
  return answers;
}

// Build the message for question `index`, carrying the answers already given.
function buildQuestion(index, answers = []) {
  const q = QUESTIONS[index];
  const prefix = answers.join('');

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle(`Question ${index + 1} of ${QUESTIONS.length}`)
    .setDescription(`**${q.title}**`)
    .setFooter({ text: 'Vendora — takes about 20 seconds' });

  // Two rows of two keeps every label readable; four buttons on one row
  // truncates the longer ones on mobile.
  const buttons = q.options.map((opt, i) =>
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}${prefix}${i}`)
      .setLabel(opt.label)
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(buttons.slice(0, 2)),
      new ActionRowBuilder().addComponents(buttons.slice(2, 4)),
    ],
  };
}

// The opening message — intro plus question one.
function buildQuizStart() {
  const intro = new EmbedBuilder()
    .setColor(PINK)
    .setTitle("Let's Get You Started with Vendora ✅")
    .setDescription(
      'Four quick questions and I\'ll tell you which plan actually fits how you sell — ' +
      'rather than making you guess from a pricing page.\n\n' +
      'No wrong answers, and nothing is charged.'
    );

  const q1 = buildQuestion(0, []);
  return { embeds: [intro, ...q1.embeds], components: q1.components };
}

// Total 0–12 maps to a tier. The bands are deliberately generous at the bottom:
// recommending Elite to someone listing five items a week would be a bad first
// impression and a refund waiting to happen.
function recommendTier(answers) {
  const total = answers.reduce((sum, choice, i) => sum + QUESTIONS[i].options[choice].score, 0);
  if (total <= 3) return { tier: 'basic', total };
  if (total <= 8) return { tier: 'pro',   total };
  return { tier: 'elite', total };
}

// Why this plan, in their own terms — referencing the answers they actually gave
// so the recommendation reads as a response rather than a sales pitch.
function buildReasons(answers) {
  const [experience, volume, goal, friction] = answers;
  const reasons = [];

  if (volume >= 2) reasons.push('You list at volume, so the per-day caps on the lower plans would slow you down.');
  else if (volume === 1) reasons.push('Your listing volume fits comfortably inside the mid-tier limits.');
  else reasons.push('You are not listing at volume yet, so there is no point paying for headroom you would not use.');

  if (friction === 2) reasons.push('Sourcing is your bottleneck — that is what the arbitrage and deal tools are for.');
  if (friction === 3) reasons.push('Cross-listing and the platform sync are aimed squarely at multi-platform juggling.');
  if (friction === 1) reasons.push('The pricing and flip-score tools take the guesswork out of what to charge.');
  if (friction === 0) reasons.push('The listing optimiser and auto-draft write the descriptions for you.');

  if (goal >= 2) reasons.push('You are treating this as a business, so the analytics matter more than the individual tools.');
  if (experience === 0) reasons.push('Starting out, the fastest win is having the research done for you rather than learning it the slow way.');

  return reasons.slice(0, 3);
}

// Final message. tierNames/tierPrices/dashboardUrl are passed in so this module
// never has to import config from index.js.
function buildRecommendation(answers, { tierNames, tierPrices, dashboardUrl }) {
  const { tier } = recommendTier(answers);
  const reasons = buildReasons(answers);

  const embed = new EmbedBuilder()
    .setColor(tier === 'elite' ? GOLD : PINK)
    .setTitle(`Your best fit: Vendora ${tierNames[tier]}`)
    .setDescription(
      `Based on your answers, **${tierNames[tier]}** is the plan that matches how you sell.\n\n` +
      reasons.map(r => `→ ${r}`).join('\n') +
      `\n\nYou can start on any plan and change it later — nothing here locks you in.`
    )
    .addFields(
      { name: 'Plan',  value: `${tierNames[tier]} — ${tierPrices[tier]}/month`, inline: true },
      { name: 'Start', value: `[Open the dashboard](${dashboardUrl})`,          inline: true }
    )
    .setFooter({ text: "Vendora — The Reseller's Edge" });

  return { embeds: [embed], components: [] };
}

// ── Day-one affiliate follow-up ──────────────────────────────────────────────
// Sent 24h after joining. Separate from the welcome DM on purpose: someone who
// has just arrived has not decided whether they like Vendora yet, and asking
// them to promote it in the same breath as introducing it reads as desperate.
//
// Both routes are given because they genuinely differ — members get their link
// from "Refer buyers", everyone else has to go through the marketplace.
function buildAffiliateReminder({ username, rate = 30, siteUrl }) {
  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle('Earn from Vendora without selling anything yourself')
    .setDescription(
      `Hey **${username}** — one thing worth knowing about.\n\n` +
      `Vendora pays **${rate}% commission, recurring** — not once, but every month that ` +
      `someone you referred stays subscribed. Refer a handful of resellers and it covers ` +
      `your own plan several times over.\n\n` +
      `**How to get your link**\n` +
      `→ Already subscribed? whop.com → **Affiliates** → **Refer buyers** → copy your Vendora link\n` +
      `→ Not subscribed? whop.com → **Affiliates** → **Affiliate marketplace** → search **Vendora** → **Become affiliate**\n\n` +
      `Share it anywhere resellers gather — Discord servers, TikTok, your own buyers. ` +
      `All three plans can be bought through your link, so you earn on whichever they pick.`
    )
    .addFields(
      { name: 'Commission', value: `${rate}% recurring`, inline: true },
      { name: 'Payout',     value: 'After a 30-day hold', inline: true }
    )
    .setFooter({ text: 'Commission tracks on Whop checkouts only — PayPal purchases do not attribute.' });

  if (siteUrl) embed.setURL(siteUrl);
  return { embeds: [embed] };
}

module.exports = {
  QUESTIONS,
  CUSTOM_ID_PREFIX,
  parseAnswers,
  buildQuizStart,
  buildQuestion,
  recommendTier,
  buildRecommendation,
  buildAffiliateReminder,
};
