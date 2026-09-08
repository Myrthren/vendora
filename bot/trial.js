// ── Free trial payloads ───────────────────────────────────────────────────────
// Pure payload builders: no client, no database, no config imports — same shape
// as winback-embed.js and outreach.js, so the exact object the owner approves in
// a preview is the object members receive.
//
// The trial is DISCORD-ONLY and PRO-EQUIVALENT for 7 days. Both facts are stated
// on the embed rather than implied: a trial that quietly excludes the dashboard
// generates a support ticket on day one, and one that never says what tier it
// matches gives the member nothing to compare against when it ends.

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

const PINK = '#e8217a';
const GOLD = '#e8a121';

const TRIAL_DAYS = 7;

// Bare prefix starts a trial. Kept here so the channel embed and the handler
// cannot drift apart.
const TRIAL_START_ID = 'trial:start';

// ── The channel embed ─────────────────────────────────────────────────────────
// Permanent and pinned, read by people who have never paid and by members who
// already have a plan — so it has to be honest about who it is NOT for.
function buildTrialPayload({ days = TRIAL_DAYS } = {}) {
  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle(`Try Vendora free for ${days} days`)
    .setDescription(
      `No card, no signup, no trial that quietly bills you on day eight. ` +
      `Press the button and you get **Pro-level access to every Vendora tool in Discord**, ` +
      `for ${days} days.\n\n` +
      `**What you can run**\n` +
      '`/scan` — check whether a listing is worth buying\n' +
      '`/research` — what an item actually sells for\n' +
      '`/margins` — profit after fees and postage\n' +
      '`/price` `/reply` `/lowball` — pricing and buyer messages\n' +
      '`/trends` `/sold` `/competitor` `/pricedrop` `/vinted-alert`\n\n' +
      `**Plus the feeds** — #deals, #price-drops and #trend-reports open up ` +
      `while your trial is running.\n\n` +
      `When the ${days} days are up the role comes off automatically. Nothing to cancel, ` +
      `nothing to remember.`
    )
    .addFields(
      { name: 'Length', value: `${days} days`,       inline: true },
      { name: 'Cost',   value: 'Free',               inline: true },
      { name: 'Access', value: 'Pro tier, Discord',  inline: true },
    )
    .setFooter({ text: 'One trial per account. The dashboard and web tools need a paid plan.' });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(TRIAL_START_ID)
          .setLabel(`Start my ${days}-day trial`)
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

// ── Ephemeral confirmation on click ───────────────────────────────────────────
// Says the end date explicitly. "7 days" is ambiguous the moment someone reads
// it two days later; a date is not.
function buildTrialStartedPayload({ username, endsAt }) {
  const when = endsAt
    ? `<t:${Math.floor(endsAt / 1000)}:F>`
    : `in ${TRIAL_DAYS} days`;

  const embed = new EmbedBuilder()
    .setColor('#4ade80')
    .setTitle('Trial active')
    .setDescription(
      `${username ? `You're in, **${username}**` : "You're in"} — Pro access is live right now.\n\n` +
      `**Start here:** run \`/scan\` on something you are thinking of buying. It is the ` +
      `command people keep the subscription for.\n\n` +
      `Your trial ends ${when}, and the role comes off on its own.`
    )
    .setFooter({ text: 'Vendora — The Reseller\'s Edge' });

  return { embeds: [embed], ephemeral: true };
}

// Refused politely — already trialled, or already paying.
function buildTrialRefusedPayload({ reason }) {
  const copy = {
    used: {
      title: 'Trial already used',
      desc: 'You have already had your free trial on this account. Plans start at **£9.99/month** and unlock the dashboard as well as the Discord tools.',
    },
    subscribed: {
      title: 'You already have a plan',
      desc: 'Your subscription gives you more than the trial does — no need to start one.',
    },
    active: {
      title: 'Trial already running',
      desc: 'Your trial is still active. Make the most of it while it lasts.',
    },
  }[reason] || { title: 'Not available', desc: 'That trial is not available on this account.' };

  return {
    embeds: [new EmbedBuilder().setColor(GOLD).setTitle(copy.title).setDescription(copy.desc)],
    ephemeral: true,
  };
}

// ── Expiry DMs ────────────────────────────────────────────────────────────────
// Day 6 rather than the morning of expiry: someone deciding whether to pay needs
// a day to use the thing again before the access disappears.
function buildTrialEndingPayload({ username, siteUrl = 'https://vendora.site' }) {
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle('Your trial ends tomorrow')
    .setDescription(
      `${username ? `Hey **${username}** — ` : ''}one day left on your Vendora trial.\n\n` +
      `If it found you even one flip you would have scrolled past, it has already paid for ` +
      `itself. Plans start at **£9.99/month**, and Pro at **£24.99** is the tier your trial ` +
      `has been running on.\n\n` +
      `${siteUrl}/#pricing`
    )
    .setFooter({ text: 'No action needed if you would rather not — the role comes off by itself.' });

  return { embeds: [embed] };
}

function buildTrialEndedPayload({ username, siteUrl = 'https://vendora.site' }) {
  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle('Trial finished')
    .setDescription(
      `${username ? `Thanks for trying Vendora, **${username}**.` : 'Thanks for trying Vendora.'} ` +
      `Your Pro access has ended and the role has come off.\n\n` +
      `Everything you used is still there on a plan — **Pro £24.99/month** is what you were on. ` +
      `**Basic £9.99** keeps the pricing and buyer-reply tools if that is all you need.\n\n` +
      `${siteUrl}/#pricing`
    )
    .setFooter({ text: 'Vendora — The Reseller\'s Edge' });

  return { embeds: [embed] };
}

module.exports = {
  TRIAL_DAYS,
  TRIAL_START_ID,
  buildTrialPayload,
  buildTrialStartedPayload,
  buildTrialRefusedPayload,
  buildTrialEndingPayload,
  buildTrialEndedPayload,
};
