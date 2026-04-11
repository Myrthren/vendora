VENDORA — Claude Code Context

What is this project
Vendora is a SaaS platform and Discord bot for resellers.
It lives at [domain TBD] and inside the Vendor Village Discord server.
Tagline: "The Reseller's Edge"

Brand
Primary colour: #e8217a (pink/magenta)
Background: #090909 (near black), surfaces #0f0f0f / #141414
Fonts: Syne (headings, uppercase) + DM Sans (body)
Logo: VV interlocked mark
Elite accent: #e8a121 (gold)
Success: #4ade80 (green)

Tech Stack
Frontend: Next.js + Tailwind CSS (current files are plain HTML — migration pending)
Backend: Node.js API routes
Discord Bot: Discord.js v14 (lives in /bot/)
Database: PostgreSQL (Supabase)
Auth: Discord OAuth2 (NextAuth.js)
Payments: PayPal Subscriptions API
Hosting (site): Vercel (netlify.toml present from earlier testing)
Hosting (bot): Railway

Key Rules
- Auth is Discord OAuth only — no passwords
- All bot responses are ephemeral
- Rate limits enforced per Discord ID
- PayPal webhook fires role assign/revoke
- Owner Discord ID hardcoded for admin access
- Sessions auto-delete after 24hr inactivity
- One Discord ID = one subscription (no sharing)

Tiers
Basic: £9.99/mo | Pro: £24.99/mo | Elite: £49.99/mo
Annual billing available (~2 months free)

Rate Limits
/scan: Basic 5/day | Pro 50/day | Elite unlimited
/reply+/lowball: Basic 20/day | Pro 100/day | Elite unlimited
/research: Basic 3/day | Pro 20/day | Elite unlimited
/crosslist: Basic 5/day | Pro 30/day | Elite unlimited
/flip: Elite only 20/day

Build Status
- index.html — Landing page: BUILT
- vendora-login.html — Login page: EXISTS (review needed)
- vendora-dashboard.html — User dashboard: EXISTS (review needed)
- bot/index.js — Discord bot: EXISTS (review needed)
- Admin panel: TO BUILD
- Backend API: TO BUILD
- Supabase schema: TO BUILD

Reference Files
- /docs/vendora-product-document.pdf — Full product spec (27 pages)
- /index.html — Landing page
- /vendora-login.html — Login/auth page
- /vendora-dashboard.html — User dashboard
- /bot/index.js — Discord bot entry point
