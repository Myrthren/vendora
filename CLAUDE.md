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
- Current LIVE version: v6.98 (verified live 2026-07-31 at vendora.site/version.json, built from e3fb47c). Version is stamped automatically by scripts/build-version.js into version.json on every deploy — the local version.json is gitignored and stale (says v6.0), so read the live URL, not the file.
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

THE SUPABASE DB WEBHOOK (profiles -> /webhook) — how to inspect it
Supabase "Database Webhooks" are just Postgres triggers calling supabase_functions.http_request,
so they can be read in SQL rather than clicked through:
  select tgname, pg_get_triggerdef(oid) from pg_trigger
  where not tgisinternal and tgrelid = 'public.profiles'::regclass;
The signature is http_request(url, method, HEADERS, params, timeout) — the secret belongs in
arg 3 (headers) as "x-webhook-secret", because /webhook (~line 3201) checks
req.headers['x-webhook-secret'].
FIXED 2026-08-02: there were TWO triggers on profiles. The live one is `on_profile_change`
(correct header, real secret). A duplicate `vendora_webhook` had the secret in arg 4 (params)
with a placeholder value, so it sent NO secret header and 401'd on every single profile write
— that was the recurring "[webhook] Rejected — bad secret" noise in the Railway logs. It had
never once delivered successfully. Deleted. Expect exactly ONE trigger on profiles.

WHOP INTEGRATION (built 2026-07-21, PROVEN END-TO-END 2026-08-02)
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
- Whop must never assign a Discord role Vendora manages. assignRole() strips all other
  tier roles, so two systems owning the same role ids will flap them forever.
  APPLIED AND VERIFIED 2026-08-02. The Whop Discord APP ITSELF is KEPT deliberately — it gives
  buyers a join button, and the Vendor Village server is open to non-subscribers anyway
  (Vendora's Discord features are gated by role, not by server membership). Keeping the
  app is fine; the conflict is only ever about overlapping ROLE IDS. Intended shape:
    • no role mappings configured on Whop's Discord app,
    • Manage Roles AND Kick Members revoked from Whop's bot role in Discord,
      (Kick Members matters separately: Whop's cancellation action can be set to "kick",
       which would eject lapsed members from an intentionally open server),
    • cancellation action set to "let them stay",
    • Vendora's bot owns every tier role.
  Do both the config change and the permission revoke: the Whop-side config states the
  intent and survives a re-auth, the Discord permission enforces it even if the config is
  wrong. Watch for Administrator on Whop's bot role — it overrides a Manage Roles revoke
  and makes it a silent no-op.
  If Whop ever stops handing buyers into the server, check this first: a permission revoke
  is invisible from the Whop side, and re-installing/re-authorising the app silently
  restores the default Discord permission set.

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
  SECOND PRODUCT in the Vendora business: prod_b16GV70L47NwE "Vendora - AI Reseller Intel"
  (one free/one-time "App Access" plan plan_1iSx6wf0XZuXM). This is NOT a duplicate — it is
  the access-pass container Whop auto-created for the OAuth app (app_HgEVw8r6BGL7XO). Leave
  it; deleting it may break the OAuth client id. Its free plan is unmapped, so a claim on it
  grants nothing (logs "UNMAPPED PLAN"). Product headline was set via the v1 API to mention
  Discord + vendora.site (max 80 chars); its slug typo verndora->vendora was fixed too.
Supabase migration: APPLIED 2026-07-21 (columns, indexes and RLS verified live).
Verified working: POST /api/v1/checkout_configurations with the Vendora key returns a
purchase_url with metadata intact, so the auto-match path is good.

LIVE as of 2026-07-22: fully deployed, all 7 env vars set on Railway (WHOP_API_KEY,
WHOP_PLAN_BASIC/PRO/ELITE, WHOP_WEBHOOK_SECRET, WHOP_OAUTH_CLIENT_ID, WHOP_OAUTH_CLIENT_SECRET),
webhook created in the Whop dashboard pointing at /whop-webhook. End-to-end tested with a
signed membership.activated event: signature verified, membership recorded, claim code
minted, owner DM'd, test row cleaned up. The payment + webhook path is working. Owner has
configured the Whop-side post-purchase redirect + "User joined" email (see #2).

PROVEN END-TO-END 2026-08-02 — the whole Whop path is now verified, not just deployed:
  • OAuth account linking works. Owner's Connect click logged
    "[whop-oauth] Token exchange succeeded via client_secret_basic" and
    "[whop-oauth] Linked whop user_cVy6uHkJ1CPZI -> discord 731207920007643167".
    The app is CONFIDENTIAL (a PKCE-only request is refused with "client_secret is
    required"), so keep WHOP_OAUTH_CLIENT_SECRET set.
  • ALL THREE plan mappings confirmed by signed synthetic membership.activated events:
    plan_y0lLH82DL3OlF -> basic, plan_Q2roL7OgEWroa -> pro, plan_gMttHcqPd9tg2 -> elite.
    No UNMAPPED PLAN on any. Test rows deleted from whop_memberships.
    Reproduce with scripts/whop-test-event.js <basic|pro|elite> (needs WHOP_WEBHOOK_SECRET
    in the shell; the synthetic membership carries no metadata.discord_id so it cannot
    grant a real user anything).
  OUTSTANDING after that session: (a) rotate WHOP_OAUTH_CLIENT_SECRET and WEBHOOK_SECRET —
  both were pasted into screenshots while debugging; when rotating WEBHOOK_SECRET, update
  the Railway env var AND the on_profile_change trigger header together, or role assignment
  breaks in the gap. That is the ONLY item left from this session.
  NOTE: three DIFFERENT Whop secrets exist and are easy to confuse —
    WHOP_API_KEY            (checkout_configurations, ~line 3630)
    WHOP_OAUTH_CLIENT_SECRET (apik_ shape, token exchange)
    WHOP_WEBHOOK_SECRET      (ws_ shape, HMAC signing)
  and WEBHOOK_SECRET (vnd_ shape) is Supabase's, nothing to do with Whop at all.

SECRET ENCODING GOTCHA (confirmed by live test 2026-07-22): Whop issues webhook secrets
prefixed "ws_" (NOT the Standard Webhooks "whsec_"), and the remainder is HEX-encoded —
NOT base64 as Whop's own docs claim. verifyWhopSignature currently tries multiple
encodings (base64/hex/utf8) and logs which one matched ("[whop] Signature verified
(secret encoding: hex)"). Now that hex is confirmed, the other candidates can be dropped
to simplify — but only after a couple more real events confirm it stays hex. The webhook
MUST be created from the dashboard (Developer tab): the signing secret is only issued
there. The legacy v2 REST API (POST /api/v2/webhooks) creates a hook with no secret and
no event selection, so hooks made that way are unverifiable — don't use that path.

Payload field names were coded defensively (several shapes accepted); unmapped plans are
logged with the full payload and DM'd to the owner. Confirm mapping against the first
REAL customer purchase (the test used plan_y0lLH82DL3OlF -> basic, which worked).

BUYER ONBOARDING — three separate problems, don't conflate them:
1. IDENTITY (who is this buyer?). Dashboard purchases carry metadata.discord_id and match
   automatically. Marketplace purchases don't — solved by Whop OAuth, BUILT 2026-07-22.
   POST /api/whop/oauth/start (auth required) stashes the Discord id from the verified
   Supabase token against a single-use state + PKCE verifier; GET /api/whop/oauth/callback
   is an unauthenticated browser redirect, so it must NEVER read a discord_id from the URL
   — the state is the only honest source. State is consumed immediately, expires in 10 min.
   The whop_user_id -> discord_id link is saved permanently (settings key whop_user_<id>),
   so later purchases/renewals from that Whop account auto-match; the webhook consults it
   when metadata is absent. Claim code remains only as a fallback for anyone already sent
   one — it is still owner-DM'd only, which is why OAuth is the primary path.
   CONFIGURED 2026-07-22 on Railway: WHOP_OAUTH_CLIENT_ID = app_HgEVw8r6BGL7XO, plus
   WHOP_OAUTH_CLIENT_SECRET. GET / now reports whop_oauth:true and the dashboard shows the
   Connect button. App's redirect URI is registered and verified — a live authorize request
   returned Whop's consent page (no invalid_client / redirect_uri_mismatch).
   RESOLVED 2026-08-02 — WORKING. userinfo id is read as info.sub (Whop's OIDC discovery
   lists "sub" in claims_supported, so this is correct); failures log the full response.

   THE OAUTH GOTCHA, so nobody re-derives it: the exchange failed for days with
   invalid_client, and the apik_-shaped secret sent us chasing the wrong things (wrong
   credential? wrong auth method?). BOTH WRONG. The secret was correct, and Whop reads it
   fine in ALL THREE transmission forms (Basic, form-post, JSON body). It simply lacked the
   "oauth:token_exchange" PERMISSION. The real error text is "client_secret lacks
   oauth:token_exchange permission".
   FIX: Whop app dashboard -> Permissions tab -> Add permission -> oauth:token_exchange.
   That is the ONLY app permission the OAuth flow needs. /oauth/userinfo uses the buyer's
   own token, and WHOP_API_KEY (checkout_configurations, ~line 3630) is a SEPARATE
   credential with its own permissions — do not conflate them.

   Diagnosis was blocked by a logging bug, now FIXED (commit 898edf7): the
   retry-without-secret path overwrote tokRes, so only the SECOND attempt's error was ever
   logged, and it read "client_secret is required" — indistinguishable from sending no
   secret at all. The callback now tries client_secret_basic first, falls back through
   client_secret_post and public PKCE, and logs EVERY attempt with its own status + body.
   A rejected client authentication never reaches code validation, so the single-use auth
   code survives a failed attempt.

   USEFUL TOOLS: Whop publishes OIDC discovery at
   https://api.whop.com/.well-known/openid-configuration (confirms
   token_endpoint_auth_methods_supported and the claim names).
   scripts/whop-preflight-auth.js proves client auth WITHOUT a real authorization code:
   send a deliberately fake code — "invalid_grant" means auth SUCCEEDED and only the code
   was rejected, "invalid_client" means auth failed. Use it before deploying or burning a
   Connect click.
2. DISCOVERY (how does a marketplace buyer know Vendora exists?). No code can fix this —
   it's Whop-side config. Dashboard purchases already redirect: /api/whop/checkout sets
   redirect_url to DASHBOARD_URL (verified accepted by the API). For MARKETPLACE purchases,
   the redirect and the buyer email are NOT settable via API — confirmed 2026-07-22 by
   probing the v1 product PATCH (redirect_url / purchase_redirect_url / after_purchase_url /
   success_url / redirect_uri all returned 400). Only the product `headline` is writable
   (max 80 chars; now set to mention Discord + vendora.site). So both were done by the owner
   in the Whop dashboard: post-purchase redirect -> vendora.site/vendora-dashboard, and a
   native automated message on the "User joined" trigger with email enabled (chosen over
   building our own sending — Vendora has NO email infrastructure at all: no
   Resend/SendGrid/nodemailer/SMTP anywhere). Owner reports both CONFIGURED 2026-07-22.
   (If the automated-message feature was retired — Whop's docs hint it became "support chats"
   — the fallback is sendPushNotification from the webhook, but confirm per-buyer targeting
   works before relying on it.)
3. DISCORD MEMBERSHIP. Fixed 2026-07-22. A buyer can pay before joining the server (the
   normal case for Whop marketplace). /webhook tried to assign the role, found no member,
   logged member_not_in_server and gave up forever — and guildMemberAdd then sent them the
   "Plans from £9.99/month" pitch for the plan they'd just bought. guildMemberAdd now
   checks for an active subscription and assigns the role + welcomes them instead. This
   also affected PayPal subscribers who paid before joining.

AFFILIATE PROGRAM (configured 2026-08-02 — LIVE but NOT yet recruited)
Whop-native, zero code. Dashboard -> Marketing -> Affiliates.
  Global affiliate rate: 25% recurring   (anyone who refers)
  Member affiliate rate: 35% recurring   (existing members of the whop)
Rates are per-whop and set independently, so members can be paid more than the
public rate without advertising it. Whop generates each affiliate's link, tracks
attribution, calculates commission and handles payouts. There is a 30-DAY HOLD
between a referred purchase and the affiliate being paid.

RECURRING, not one-time — deliberate. One-time commission makes affiliates chase
clicks; recurring makes them care whether the referral sticks, which matches our
incentive. Cost is a permanent 25-35% haircut on that customer's lifetime value,
so judge the rate against LIFETIME margin, not monthly. Whop's own wording is
"% of the recurring revenue the user pays" with no cap stated — read as
uncapped, but never definitively confirmed in their docs. Say "for as long as
they stay subscribed" in any pitch; that is true either way.

THE LIMIT: Whop tracks WHOP CHECKOUTS ONLY. PayPal purchases are invisible to
attribution. So affiliate links must point at the Whop storefront and PayPal
stays for direct/organic. Unifying the two needs a third-party tracker (Affonso
~$12.50/mo has native PayPal; Rewardful $49/mo) — not worth it below roughly
£200/mo of affiliate revenue.

WHY THIS DEPENDS ON THE OAUTH WORK: affiliate traffic is COLD MARKETPLACE
TRAFFIC by definition, so those purchases carry NO metadata.discord_id and
nothing auto-matches. The buyer must link their Whop account or they have paid
and received nothing — and the claim code goes to the OWNER, not to them. The
whole funnel therefore rests on the OAuth linking path (proven 2026-08-02) plus
the post-purchase route added the same day: Whop's redirect points at
/vendora-dashboard?whop=purchased, handleWhopReturn switches to the subscription
section, scrolls the "Bought on Whop?" block into view and prompts them to hit
Connect. That block was restyled to brand-pink because it previously looked like
fine print under three bright plan cards.

STILL OUTSTANDING: (a) one REAL purchase end-to-end — Whop still shows 0 joined,
so every component is verified individually but the seams never have been, and
nobody has confirmed a stranger can self-serve; (b) recruitment has NOT started,
deliberately. Do not recruit until there are a few paying customers: affiliates
amplify a funnel that converts, they cannot create one, and promoter goodwill is
spent once.

Reference Files
- /docs/vendora-product-document.pdf — Full product spec (27 pages)
- /index.html — Landing page
- /vendora-login.html — Login/auth page
- /vendora-dashboard.html — User dashboard
- /bot/index.js — Discord bot entry point
