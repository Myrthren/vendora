VENDORA — Claude Code Context

What is this project
Vendora is a SaaS platform and Discord bot for resellers.
It lives at https://vendora.site (confirmed in bot/index.js SITE_URL, ~line 107) and inside the Vendor Village Discord server.
Tagline: "The Reseller's Edge"

Brand
Primary colour: #e8217a (pink/magenta)
Background: #090909 (near black), surfaces #0f0f0f / #141414
Fonts: Syne (headings, uppercase) + DM Sans (body)
Logo: single glossy magenta "V" mark (rebrand from the old "VV interlocked" mark — new logo art chosen 2026-07-09, favicon/nav already use vendora-icon.png; a full glossy/glow "identity direction" restyle is prototyped but NOT yet shipped). Old note kept for history: was "VV interlocked mark".
Elite accent: #e8a121 (gold)
Success: #4ade80 (green)

Tech Stack
Frontend: Next.js + Tailwind CSS (current files are plain HTML — migration pending)
Backend: Node.js / Express — NOT separate from the bot, see Architecture below
Discord Bot: Discord.js v14 (lives in /bot/)

ARCHITECTURE — the bot IS the backend (verified 2026-07-21)
bot/index.js is ONE monolithic Node process wearing two hats:
  1. the Discord.js client (slash commands, ephemeral replies), and
  2. an Express HTTP server (app = express() ~line 2658, ~80 REST routes) that serves
     every API the dashboard calls — /api/crosslist, /api/research, /api/inventory,
     /api/vinted/*, /api/listing/*, /api/photo/*, /api/credits/*, /api/admin/*,
     plus /webhook and /paypal-webhook.
Consequence: there are no independently-failing services. One process down = the bot
AND the whole web backend are down together. That's why the Railway outage takes out
"everything" at once, and why restoring Railway brings it all back in one shot.
Database: PostgreSQL (Supabase)
Auth: Discord OAuth2 (NextAuth.js)
Payments: PayPal Subscriptions API + Whop (alternative checkout, runs alongside — see Whop section)
Hosting (site): Netlify — live at https://vendora-vv.netlify.app, auto-deploys from GitHub (Myrthren/vendora, main branch)
Hosting (bot+backend): Railway — RESTORED 2026-07-21 (was down after the subscription lapsed). Back up and serving. If it goes down again, remember one process = bot AND backend, so everything fails together.

POST-RESTORE CHECKLIST (Railway is back as of 2026-07-21 — item 3 is still OUTSTANDING and matters)
1. Domain check FIRST. If Railway was recreated rather than just unpaused it may issue a NEW domain — then update the BOT_API const (~line 3538 of vendora-dashboard.html) and redeploy the site. If billing was simply re-enabled on the same service, the domain persists and no code change is needed.
2. Env vars. If the service was recreated, re-enter all secrets (DISCORD_BOT_TOKEN, SUPABASE_SERVICE_KEY, PAYPAL_*, ANTHROPIC_API_KEY, APIFY_API_TOKEN, PROXY_URL, etc.). Check first-boot deploy logs.
3. Reconcile PayPal — the real gotcha. /paypal-webhook (~line 2947) does role assign/revoke. Any subscription events that fired during the outage (renewals, cancellations, failed payments) hit a dead endpoint; PayPal only retries for a limited window, so some are permanently lost. Sweep active PayPal subs vs Discord roles vs Supabase subscription_status and fix drift manually.
4. Vinted tokens may have gone stale during downtime — affected users just need to reconnect. Expected, not a bug.
5. The avatar/initials bug is unrelated and will NOT be fixed by the restore.

VERSIONING — how it actually works now
- Current LIVE version: v6.85 (as of 2026-07-09). Version is stamped automatically by scripts/build-version.js into version.json on every deploy.
- Real flow: commit + push to main (GitHub Myrthren/vendora) → Netlify auto-builds → version.json bumped automatically. There is no manual "stage then owner clicks Publish" gate on the live site deploy.
- The admin panel has an auto-tracked Update Log (in vendora-dashboard.html): feat:/major commits create a new announcement entry; fix/chore/style/etc. fold into the previous entry and bump its version label. It drafts Discord-ready copy for the owner to paste.
- NOTE: the old "increment by exactly 0.1, owner must Publish" policy below no longer matches reality (kept as owner's stated intent; confirm with Kene before treating as a hard rule). Bot-side stage/publish/revert endpoints exist but the bot is down.
- When you ship: push to main and let Netlify + build-version.js handle the version. Update "Current LIVE version" in this file when you remember to.

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

Build Status (updated 2026-07-21)
- index.html — Landing page: BUILT
- vendora-login.html — Login page: BUILT (Discord OAuth)
- vendora-dashboard.html — User dashboard: BUILT & extensively iterated (~7.6k lines). Ships: top-bar dropdown nav (Sourcing/Listing/Insights/Account) replacing the old sidebar, Ctrl+K command palette, an "Overview" default home page (30-day profit sparkline, trend, count-up stats, recent sales, quick actions), animated sheen on all accent-coloured text, and the full tool set (Arbitrage, Watchlist, Auto-Buy, Inventory, Profit Tracker, Photo Enhancer, Listing Optimiser, Auto-Draft, Seller Intel, Flip Score, Price Elasticity, Resell Calendar, Credits).
- Admin panel: BUILT (owner-only) — users, bot config, announcements, pricing, coupons, credit adjust/codes, system diagnostics, and an auto-tracked Update Log.
- bot/index.js — Discord bot AND backend API in one process (~8.6k lines, see Architecture): BUILT and LIVE again (Railway restored 2026-07-21).
- Supabase schema: BUILT (profiles table with discord_id/tier/subscription_status/avatar_url/paypal_subscription_id; see project docs).
- Hardening done: XSS-escaping on all scraped Vinted data, keyboard nav + ARIA, basic responsive, API-down health banner.
- Known: user avatar shows initials until re-login (stale Discord CDN hash 404s; fix = sign out/in, self-heals the stored URL). Frontend is still plain HTML (no Next.js migration yet).

SECURITY POSTURE (focused review 2026-07-21 — auth/secrets/CORS/admin/crypto/scoping)
Verdict: solid for a solo-built SaaS. No critical holes found. Nothing blocking the Railway restore.

What's correct — preserve these patterns:
- No hardcoded secrets. All via process.env. Only literals are the public Supabase URL and OWNER_ID.
- Auth done right: every checked endpoint calls requireAuth / verifySupabaseToken (~line 802), which
  validates the JWT against Supabase's auth server. Identity (user.id / discord_id) is ALWAYS derived
  from the verified token, NEVER from the request body. Grep for req.body.discord_id returns zero hits.
  KEEP IT THAT WAY — see RLS note below.
- Ownership scoping: data routes key off the authenticated user.id (e.g. getSetting(`vinted_inventory_${user.id}`)),
  so users can't read each other's data by swapping an ID.
- Admin routes double-gate: requireAuth THEN discordId !== OWNER_ID -> 403. Not merely "logged in".
- Token encryption at rest: AES-256-GCM (authenticated), random IV per token.
- CORS scoped to vendora.site + vercel previews (not *). Webhook secret checked on /webhook.
- DB access via Supabase PostgREST with encodeURIComponent on filters — no raw SQL, no SQLi surface.

Open items (not urgent, worth fixing):
- MEDIUM: ENCRYPT_KEY is derived from SUPABASE_KEY via sha256 (~line 3022). Two problems: anyone with the
  service key can decrypt every user's Vinted token (no blast-radius separation), and rotating
  SUPABASE_SERVICE_KEY would make all stored tokens permanently undecryptable. Fix: dedicated ENCRYPTION_KEY env var.
- MEDIUM: encryption fails OPEN. encryptToken ends `catch { return text; }` — on a throw it silently stores
  PLAINTEXT. decryptToken also passes through any dot-containing value as "legacy plaintext", so older Vinted
  JWTs may already sit unencrypted in the DB. Audit + migrate.
- MEDIUM: no visible rate-limiting on the Express API. Bot commands are rate-limited per Discord ID, but the
  HTTP routes aren't — a logged-in user could run up the Anthropic/Apify bill or DoS the box via the 25mb
  image-upload body. Add per-user throttling on the expensive routes before scaling users.
- LOW: /api/vinted/connect-login (~line 4418) takes the user's real Vinted password for a Playwright login.
  Used transiently, not stored — keep it that way and ensure it never lands in logs.
- CONTEXT: the backend uses the Supabase SERVICE key, which BYPASSES Row-Level Security. RLS is therefore NOT
  the safety net — the app code is. Every new endpoint must keep deriving identity from the token. One slip = data leak.

Note: this was a focused read of the highest-risk areas, not an exhaustive audit of all ~80 endpoints.
Not yet confirmed: that every single route calls requireAuth. Worth a systematic sweep (/security-review).

WHOP INTEGRATION (built 2026-07-21 — NOT yet configured/tested against live Whop)
Whop is an ALTERNATIVE checkout running ALONGSIDE PayPal, not a replacement.
Both write the same entitlement fields on profiles (tier + subscription_status); the
existing Supabase DB webhook -> /webhook then assigns the Discord role and DMs the user.
So granting a tier is one PATCH — no new role/DM code exists for Whop.

Key pieces:
- sql/whop-integration.sql — run once in Supabase. Adds profiles.subscription_source +
  profiles.whop_membership_id, and the whop_memberships ledger table.
- subscription_source ('paypal'|'whop'|null) records WHICH provider owns the current tier.
  This is what stops a Whop cancellation from revoking a PayPal subscriber. Existing PayPal
  rows are NULL and are deliberately treated as "not Whop". The dashboard now stamps
  'paypal' on new PayPal subs.
- POST /whop-webhook (bot/index.js) — Standard Webhooks spec: HMAC-SHA256 over
  "{id}.{timestamp}.{body}" with the base64-decoded secret, headers webhook-id /
  webhook-timestamp / webhook-signature. Needs the RAW body, so an express.raw() mount is
  registered for that path BEFORE the global express.json(). Do not reorder those.
  Events are membership.activated / membership.deactivated (NOT the older went_valid names).
- Identity is the hard part: the Whop payload contains NO Discord id. Two paths —
  (1) metadata.discord_id, set by POST /api/whop/checkout which mints a Whop checkout
  configuration (metadata CANNOT be a plain URL query param); (2) a claim code for
  purchases made on Whop's marketplace, redeemed via POST /api/whop/claim. Every
  membership is recorded either way, so a purchase is never lost.
- Whop's own Discord role automation MUST stay OFF. assignRole() strips all other tier
  roles, so two systems managing the same role ids will flap them.

Whop account (confirmed live 2026-07-21):
  company biz_tDgAtGysVSQw4f — "Vendora — The Reseller's Edge"
  product prod_LlNbODGPtxp73
  plan_y0lLH82DL3OlF = basic (£9.99/30d)  |  plan_Q2roL7OgEWroa = pro (£24.99/30d)
  plan_gMttHcqPd9tg2 = elite (£49.99/30d)
  All GBP renewal plans, 30-day period, monthly only (no annual on Whop — the
  dashboard disables the Whop button when the annual toggle is on).
  NOTE: Kene also has a SEPARATE Fortify Whop business (biz_qe2CAq2m6FpqX8, plans at
  £29/£79/£199). Never point Vendora's plan env vars at it — the webhook maps plan id
  -> tier with no product check, so Fortify signups would be granted Vendora tiers.
Supabase migration: APPLIED 2026-07-21 (columns, indexes and RLS verified live).
Verified working: POST /api/v1/checkout_configurations with the Vendora key returns a
purchase_url with metadata intact, so the auto-match path is good.

DEPLOYED 2026-07-21: code is on main, Railway redeployed, /whop-webhook is live and
returning 401 to unsigned requests (correct). WHOP_API_KEY + WHOP_PLAN_BASIC/PRO/ELITE
are set on Railway.

ONE STEP LEFT — WHOP_WEBHOOK_SECRET. The webhook MUST be created from the Whop dashboard
(Developer tab -> Create Webhook), because the signing secret is only issued there. The
legacy v2 REST API (POST /api/v2/webhooks) can create a hook but exposes no secret and no
event selection, so hooks made that way are unverifiable and get 401'd — one was created
and deleted again during setup. Don't retry that path.
Until the secret is set, every Whop event is rejected: the integration is inert, not broken.

Payload field names were coded defensively (several shapes accepted); unmapped plans are
logged with the full payload and DM'd to the owner. Confirm against the first real event.

Reference Files
- /docs/vendora-product-document.pdf — Full product spec (27 pages)
- /index.html — Landing page
- /vendora-login.html — Login/auth page
- /vendora-dashboard.html — User dashboard
- /bot/index.js — Discord bot entry point
