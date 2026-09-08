// ── Win-back DM payload ───────────────────────────────────────────────────────
// The subscribe prompt sent to server members who have never subscribed (and to
// anyone whose subscription has lapsed). Returned as RAW Discord API JSON rather
// than an EmbedBuilder so the exact same object can be posted three ways —
// by the bot over discord.js, by /winback preview into a channel, and by the
// standalone preview script over raw REST. One definition, so what the owner
// approves in a channel is byte-for-byte what lands in members' DMs.

const SITE_URL      = 'https://vendora.site';
const PRICING_URL   = 'https://vendora.site/#pricing';
const DASHBOARD_URL = 'https://vendora.site/vendora-dashboard';
const ICON_URL      = 'https://vendora.site/vendora-icon.png';

const BRAND_PINK = 0xe8217a;

// `username` is only used for the greeting. Left out (channel previews, users
// whose tag we could not resolve) it falls back to a neutral opener.
function buildWinbackPayload({ username } = {}) {
  const greeting = username
    ? `Hey **${username}** — you're in Vendor Village, but you haven't unlocked **Vendora** yet.`
    : `You're in Vendor Village, but you haven't unlocked **Vendora** yet.`;

  return {
    embeds: [{
      color: BRAND_PINK,
      author: { name: "Vendora — The Reseller's Edge", icon_url: ICON_URL },
      title: 'Turn your reselling into a system',
      url: SITE_URL,
      description:
        `${greeting}\n\n` +
        'Vendora is the AI toolkit that handles the boring half of reselling for you — ' +
        'sourcing research, pricing, listings, buyer replies and profit tracking, ' +
        'across **Vinted**, **Depop** and **eBay**.\n\n' +
        'Less time listing. More time flipping.',
      thumbnail: { url: ICON_URL },
      fields: [
        {
          name: '🔎  Source smarter',
          value: 'Scan platforms for underpriced stock, track competitor sellers, and get pinged the moment a watchlist item drops in price.',
        },
        {
          name: '🏷️  List faster',
          value: 'AI-written listings, one-click cross-listing, photo enhancement, and an optimiser that rewrites weak titles into ones that sell.',
        },
        {
          name: '💬  Sell harder',
          value: 'Instant buyer replies, lowball handlers and negotiation scripts — so offers convert instead of going cold in your inbox.',
        },
        {
          name: '📈  Know your numbers',
          value: 'Live profit tracking, margin breakdowns, flip scores and price elasticity on everything you touch.',
        },
        { name: '​', value: '**Pick your plan**' },
        { name: 'Basic — £9.99/mo',  value: 'AI replies, lowball handling,\nprice checks & private sessions', inline: true },
        { name: 'Pro — £24.99/mo',   value: 'Everything in Basic, plus scans,\nresearch, margins & cross-listing', inline: true },
        { name: 'Elite — £49.99/mo', value: 'Everything in Pro, plus auto-flips,\nlive analytics & unlimited usage',  inline: true },
        {
          name: '​',
          value: 'Annual billing is available too — roughly **two months free**.\nCancel any time; your role is removed automatically, no emails to chase.',
        },
      ],
      footer: { text: "Vendora — The Reseller's Edge  •  You're getting this because you're a member of Vendor Village" },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 5, label: 'See Plans & Pricing', url: PRICING_URL },
        { type: 2, style: 5, label: 'Open Dashboard',      url: DASHBOARD_URL },
      ],
    }],
  };
}

module.exports = { buildWinbackPayload, SITE_URL, PRICING_URL, DASHBOARD_URL, ICON_URL };
