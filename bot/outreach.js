// Outreach to members who are already in the server but have no active plan.
//
// Two stages, both DM'd:
//   1. "Get set up"  — sign in, and an inline button that starts the plan quiz
//   2. "Affiliate"   — sent 24h after THAT PERSON's stage 1, not on a global
//                      clock, so it inherits the drip and never lands as a burst
//
// Payload builders only: no client, no database, no config imports. That keeps
// them previewable and unit-testable, and means the exact object the owner
// approves is the object members receive.

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

const PINK = '#e8217a';

// The quiz router treats a bare prefix as "no answers yet" and renders question
// one, so this button starts the quiz with no extra handler code.
// Must stay identical to onboarding.CUSTOM_ID_PREFIX.
const QUIZ_START_ID = 'onb:';

function buildSetupPayload({ username, loginUrl }) {
  const greeting = username
    ? `Hey **${username}** — quick one.`
    : 'Quick one.';

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle('Get your Vendora account set up')
    .setDescription(
      `${greeting} You don't need a plan to get set up, and doing it now means ` +
      `everything's ready the moment you do want it.\n\n` +
      `**1.** Sign in at ${loginUrl} with Discord — no password, no card, about ten seconds.\n` +
      `**2.** That creates your account, so your role and tools activate instantly the moment you pick a plan.\n` +
      `**3.** Not sure which plan fits? Hit the button and I'll ask you four quick questions.`
    )
    .setFooter({ text: "Vendora — The Reseller's Edge" });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Sign in with Discord').setStyle(ButtonStyle.Link).setURL(loginUrl),
        new ButtonBuilder().setCustomId(QUIZ_START_ID).setLabel('Find my plan').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// Framed for someone who has NOT subscribed — the point being made is that a
// plan of their own is not a prerequisite. Distinct from the day-one DM in
// bot/onboarding.js, which goes to people who just joined.
function buildOutreachAffiliatePayload({ username, rate = 30 }) {
  const greeting = username
    ? `Hey **${username}** — worth knowing this one even if you never subscribe.`
    : 'Worth knowing this one even if you never subscribe.';

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle('You can earn from Vendora without paying for it')
    .setDescription(
      `${greeting}\n\n` +
      `Vendora pays **${rate}% commission, recurring** — every month a person you referred ` +
      `stays subscribed, not just once. You don't need a plan of your own to be an affiliate.\n\n` +
      `**How to get your link**\n` +
      `→ whop.com → **Affiliates** → **Affiliate marketplace** → search **Vendora** → **Become affiliate**\n` +
      `→ Already subscribed? **Affiliates** → **Refer buyers** instead\n\n` +
      `Share it wherever resellers already are — Discord servers, TikTok, your own buyers. ` +
      `All three plans can be bought through your link.`
    )
    .addFields(
      { name: 'Commission', value: `${rate}% recurring`,  inline: true },
      { name: 'Payout',     value: 'After a 30-day hold', inline: true }
    )
    .setFooter({ text: 'Commission tracks on Whop checkouts only — PayPal purchases do not attribute.' });

  return { embeds: [embed] };
}

// ── Weekly report ────────────────────────────────────────────────────────────
// Deliberately reports what is MEASURABLE and says so. Discord does not emit an
// interaction for link buttons, so "Sign in with Discord" clicks cannot be
// counted — only the quiz button can. Presenting a sign-in number would be a
// fabrication, so the report shows the quiz funnel and names the blind spot.
function buildWeeklyReport(m, { periodLabel, campaign }) {
  const n = (v) => Number(v || 0);
  const pct = (a, b) => (n(b) ? `${((n(a) / n(b)) * 100).toFixed(0)}%` : '—');

  const totalDMs = n(m.welcome_sent) + n(m.setup_sent) + n(m.affiliate_sent);
  const quizDMs  = n(m.welcome_sent) + n(m.setup_sent); // both routes offer the quiz

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle('Weekly DM report')
    .setDescription(`Period: **${periodLabel}**`)
    .addFields(
      {
        name: 'DMs sent',
        value:
          `Welcome (new joiners): **${n(m.welcome_sent)}**\n` +
          `Setup (existing members): **${n(m.setup_sent)}**\n` +
          `Affiliate: **${n(m.affiliate_sent)}**\n` +
          `Total: **${totalDMs}**`,
      },
      {
        name: 'Quiz funnel',
        value:
          `Reached with a quiz: **${quizDMs}**\n` +
          `Started: **${n(m.quiz_started)}** (${pct(m.quiz_started, quizDMs)} of reached)\n` +
          `Completed: **${n(m.quiz_completed)}** (${pct(m.quiz_completed, m.quiz_started)} of started)`,
      },
      {
        name: 'Delivery',
        value:
          `DMs closed (expected): **${n(m.dm_closed)}**\n` +
          `Other failures: **${n(m.dm_failed_other)}**` +
          (n(m.dm_failed_other) ? '  ← worth a look' : ''),
      },
    );

  if (campaign) {
    embed.addFields({
      name: 'Outreach campaign',
      value: campaign.rolled_out_at
        ? `${campaign.done} of ${campaign.total} members contacted` +
          (campaign.remaining ? ` · ~${campaign.daysLeft} day(s) left` : ' · complete') +
          (campaign.paused ? '\n**Paused**' : '')
        : 'Not started — run `/outreach start`',
    });
  }

  embed.addFields({
    name: 'Not measurable',
    value: 'Discord sends no interaction for link buttons, so "Sign in with Discord" clicks cannot be counted. Quiz starts are the only click signal available.',
  });

  embed.setFooter({ text: 'Vendora — counters reset now for the next period' });
  return { embeds: [embed] };
}

module.exports = {
  QUIZ_START_ID,
  buildSetupPayload,
  buildOutreachAffiliatePayload,
  buildWeeklyReport,
};
