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
- Current LIVE version: v6.124 (verified live 2026-09-12 at vendora.site/version.json, built from 938af21). Version is stamped automatically by scripts/build-version.js into version.json on every deploy — the local version.json is gitignored and stale (says v6.0), so read the live URL, not the file.
- Real flow: commit + push to main (GitHub Myrthren/vendora) → Netlify auto-builds → version.json bumped automatically. There is no manual "stage then owner clicks Publish" gate on the live site deploy.
- GIT AUTH: the remote used to carry a PAT inline, which expired three times. Fixed 2026-09-09 — the remote is now a plain https URL and auth goes through the `gh` credential helper (already logged in as Myrthren). Nothing to rotate.
- The admin panel Update Log (vendora-dashboard.html, ~line 4437) reads the LAST 3 DAYS OF COMMITS FROM THE GITHUB API and groups them by calendar day. Rewritten 2026-09-09: it used to poll version.json, which only ever holds the single latest commit, and accumulate history in localStorage from whatever it happened to observe while the dashboard was open — so every deploy that shipped with the panel closed was invisible, and one July entry spent two months absorbing unrelated commits. Docs and chores are filtered out; each line is tagged Feature/Fix/Polish. Version and title are editable fields because the announcement header has always been written by hand. Copy output matches the posted format: `📦 **Vendora v6.x** — Title`, blank line, `• bullets`.
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

Rate Limits (RATE_LIMITS, bot/index.js ~line 198 — hot-editable from the admin panel)
/scan: Basic 5/day | Pro 50/day | Elite unlimited
/reply+/lowball+/price: Basic 20/day | Pro 100/day | Elite unlimited
/research (+/margins /sold /competitor /trends): Basic 3/day | Pro 20/day | Elite unlimited
/flip: Elite only 20/day
everything else: Basic 10/day | Pro 50/day | Elite unlimited

TWO SUBSYSTEMS DISAGREE ABOUT BASIC — unresolved, decide before selling Basic.
RATE_LIMITS gives Basic 5 scans and 3 research a day, but CMD_TIER_REQUIRED
(~line 213) gates scan/research/margins/pricedrop/trends/tracker/sold/competitor/
vinted-alert at 'pro'. The tier check runs BEFORE the rate limiter, so those Basic
allowances are dead code that has never executed. The pricing page was selling
Basic as "Limited product research", which matches the RATE_LIMITS intent — so the
gate is probably the later mistake. Site copy was corrected 2026-09-09 to match the
code as it actually behaves; the alternative fix is to drop those commands from
CMD_TIER_REQUIRED and let RATE_LIMITS do the tiering, which is what it was written for.

/crosslist IS NOT A DISCORD COMMAND. Zero setName('crosslist') in the bot — it is
dashboard-only (POST /api/crosslist plus a job scheduler). The old rate-limit row
for it here described a command that never existed.

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
  Rate quoted everywhere in code: 30% recurring (AFFILIATE_RATE_PCT, bot/index.js ~195)
  (An earlier note here said 25% global / 35% member. The code says a flat 30 and
   every DM, the #affiliates embed and /postaffiliate all read AFFILIATE_RATE_PCT.
   CONFIRM WHAT WHOP IS ACTUALLY SET TO — quoting a rate Whop does not pay is the
   one affiliate mistake you cannot walk back.)
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

VINTED REACHABILITY — read this before debugging "no results" (2026-09-09)
Every Vinted feature shares one network path, so when it breaks, ALL of them break
together: /scan /research /price comps, the alert crons, auto-buy, inventory sync,
the watchlist, the deal feed and Vendex.

WHAT HAPPENED: the SmartProxy (PROXY_URL, proxy.smartproxy.net:3120) stopped
answering. A dead proxy HANGS rather than refusing, so it surfaced as
`page.goto: Timeout 25000ms exceeded` and `getVintedBase failed: fetch failed`,
not as a proxy error. Two bugs turned that into a silent total outage:
  1. resolveVintedBase caught the timeout and returned the default URL anyway. The
     caller then ran page.evaluate against a page that never loaded, the inner fetch
     failed and returned [], so vintedBrowserSearchItems reported { items: [] } with
     NO error — indistinguishable from "Vinted has nothing matching". Apify was
     therefore never tried. FIXED: resolveVintedBase(page, strict) throws instead;
     only search passes strict, since search is the path with a fallback worth reaching.
  2. The no-proxy retry only matched ERR_TUNNEL_CONNECTION_FAILED and only ran in
     the login path. FIXED: a circuit breaker in bot/vinted-browser.js — two
     consecutive failures to reach vinted.co.uk drop the proxy, close the browser and
     run direct for 30 minutes, then retry the proxy automatically. A datacenter IP
     risks DataDome, but a proxy that cannot connect is a guaranteed outage.

DIAGNOSE IT IN ONE CALL: GET / now returns a `vinted` block —
{ playwright, stealth, proxyConfigured, proxyDisabled, proxyRetryAt, consecutiveFails }.
proxyDisabled:true means the breaker has tripped and it is running direct.
GET /api/vinted/proxy-test (owner-only) probes the proxy step by step.
AS OF 2026-09-12 the proxy is STILL DEAD and the breaker is carrying it — Vinted
works, but on Railway's own IP. Fixing PROXY_URL is still outstanding.

APIFY — migrated off the hot paths 2026-09-09
The account is on the FREE $5/month cap and kazkn~vinted-smart-scraper is
pay-per-event ($0.02 a run + $0.002 a result), so a 12-item search is $0.044 —
about 83 searches a month for ALL users. One Basic customer at 5 scans/day exceeds
that alone, so no tier structure was affordable on it.
  - searchVinted (~line 891) is browser-first with a CONCURRENCY GUARD: past 3
    in-flight browser searches it spills to Apify. Apify is burst capacity now, not
    the cost of every search — crons are serial but user commands are not, and ten
    people running /scan at once would otherwise queue behind one Chromium.
  - vintedItemDetail (~line 824) added for the watchlist cron, which was ~$317/month
    for one Elite user watching 20 items.
  - Alert baselining moved off Apify (30 alerts cost $1.80 to set up).
  - STILL ON APIFY DELIBERATELY: cross-country arbitrage (~line 8337). Credit-gated
    at ~£0.48 revenue against ~£0.32 cost, and there is no browser equivalent.
  - Deleted: apifyVintedFetchUserByUsername / apifyVintedFetchUserItems (zero
    callers) and APIFY_VINTED_USER_ACTOR with them.

THE MARKET — channel feeds (built 2026-09-08/09, bot/feeds.js)
An owner-curated keyword list searched every 10 min via alertKeywordSearch (browser
path, £0 per call), filtered to listings >=35% under the median of their OWN search
results, with a floor at 15% of median to exclude bundle and photo-only listings.
  #early-deals (Elite) posts at T+0; #deals (Pro) gets the same find 10 minutes
  later. The delay is the "speed edge" the pricing page sells, so it is a product
  value, not an artefact. The queue lives in the settings table, NOT a setTimeout —
  Railway redeploys constantly and timers would silently drop queued finds.
  #price-drops (Pro) reports category going-rate falls every 6h; #trend-reports (Pro)
  and #whats-selling (all) post weekly on Sundays at 17:00 and 18:00.
  DELIBERATELY A GLOBAL SOURCE: processVintedAlerts is PER USER, so piping it into a
  shared channel would leak what individuals are hunting and go silent when nobody
  has alerts set.
Settings keys: feed_keywords (the list), feed_tuning (thresholds, no deploy needed),
deal_feed_queue, deal_feed_seen_ids, feed_keyword_stats, price_drop_last_posted.
Channel ids live in bot/feeds.js CHANNELS. #competitor-watch was created then deleted
— /competitor is a one-shot AI breakdown, nothing is stored and nothing notifies, so
there was no feed to wire.

VENDEX — public price index (built 2026-09-09, LIVE and producing)
GET /api/vendex (public, unauthenticated, 5-min memory cache) + vendex.html.
Median asking price per category from the hourly medians the deal feed already
records, plus an equal-weighted index rebased to 100 at each category's first
reading. Averaging RELATIVE change is the only honest way to combine categories
whose prices differ by an order of magnitude.
As of 2026-09-12: index 90.3, 6 categories, ~50 samples each since 09-09 21:31.
NOT LINKED from the main site yet — owner's call.
KNOWN DATA-QUALITY ISSUE: the search takes the 20 NEWEST listings, which drags some
medians well below the real market (nike tech fleece reads £16.45 against a true
£40-80) because kids' sizes, shorts and accessories match the keyword. Fix by
sampling more items or trimming outliers before taking the median. Worth doing
before Vendex is linked publicly — resellers will spot it immediately.

FREE TRIAL (built 2026-09-08, bot/trial.js)
7 days, PRO-EQUIVALENT, DISCORD ONLY — no dashboard, stated on the embed so it does
not become a day-one support ticket. /posttrial posts and pins the embed in
#try-vendora (1546270485803704440); the button grants role 1546263632617144411.
  - Eligibility is STORED (settings key `trials`), never inferred from the role.
    Someone can leave and rejoin or lose the role, and a role check would hand them a
    fresh trial each time. `done` is kept forever as the record they have had theirs.
  - The command gate (~line 3556) accepts an active trial as well as a subscription.
    Without that branch a trial member gets the role, opens the feeds, runs /scan and
    is told to subscribe.
  - Expiry is a 15-min sweep against the stored end time, not a setTimeout. Access is
    gated on the timestamp, so an expired trial stops working on time even before the
    sweep strips the role.
  - Converting mid-trial closes the trial and removes the role: assignRole only
    manages the tier roles in ROLE_IDS, so it would otherwise leave a Basic subscriber
    sitting in the Pro feed channels.
  - DMs: start (also opens the DM channel, which is what makes the later DMs
    deliverable at all), day 6, and day 7. The closing DM sells on what the trial
    WITHHELD — the dashboard — which only works because the trial is scoped this way.

OWNER COMMANDS ADDED: /postaffiliate (affiliate embed, channel 1546264798876930151)
and /posttrial. Both are owner-only, post-and-pin, and edit in place when re-run so
revising copy does not leave duplicates or lose the pin. Same pattern as /postrules.

SITE HONESTY PASS (2026-09-09) — the landing page was selling things that do not work
eBay's Finding API is retired (503 every call) and Depop is 403 bot-blocked; both
fail silently to null. The page said "3 Platforms Live" and listed both as
"Research + List". Now: 1 Platform Live, Vinted first, Depop and eBay "In Progress",
feature copy and all three meta/OG/Twitter descriptions say Vinted only, and the
live-scan mock rows are all Vinted.
Three fabricated testimonials (named reviewers with handles and "Pro Member" tags,
against zero customers all-time) were replaced with three factual cards.
Pricing cards corrected: Basic no longer claims research or DM alerts it cannot
reach, Pro no longer claims "all platforms" cross-listing or "Competitor tracking"
that implies monitoring. Checkout step now names Whop as well as PayPal — Whop is the
only checkout affiliate links can attribute, so naming PayPal alone worked against
the affiliate program.

Reference Files
- /docs/vendora-product-document.pdf — Full product spec (27 pages)
- /index.html — Landing page
- /vendex.html — Vendex, the public price index
- /vendora-login.html — Login/auth page
- /vendora-dashboard.html — User dashboard
- /bot/index.js — Discord bot AND backend API (one process)
- /bot/feeds.js — The Market channel feeds: channel ids, underpriced filter, embeds
- /bot/trial.js — Free trial payloads
- /bot/outreach.js — Setup + affiliate DMs, and the #affiliates channel embed
- /bot/onboarding.js — Onboarding quiz + day-one affiliate DM
- /bot/winback-embed.js — Win-back DM payload
- /bot/vinted-browser.js — Playwright flow + the proxy circuit breaker
- /scripts/discord-server-map.js — read-only dump of every channel, role and
  permission overwrite. Needs DISCORD_BOT_TOKEN in your own shell.
- /scripts/vinted-search-compare.js — Apify vs browser field-parity check

CONVENTION: payload builders (feeds/trial/outreach/onboarding/winback-embed) are
PURE — no client, no database, no config imports — so the exact object the owner
approves in a preview is the object members receive.
