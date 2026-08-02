#!/usr/bin/env node
// Send a correctly-signed synthetic Whop `membership.activated` event to the
// live /whop-webhook, to prove a plan id maps to the tier you expect.
//
// Only the basic plan has ever been exercised by a real event — pro and elite
// are untested, and they are the high-value tiers. A typo in WHOP_PLAN_PRO or
// WHOP_PLAN_ELITE means a paying customer is logged "UNMAPPED PLAN" and granted
// nothing. This closes that gap without spending money.
//
//   $env:WHOP_WEBHOOK_SECRET = "ws_..."      # PowerShell — set it yourself
//   node scripts/whop-test-event.js pro
//   node scripts/whop-test-event.js elite
//
// The synthetic membership carries NO metadata.discord_id and a random whop
// user id, so it cannot match a real profile and cannot grant anyone a tier.
// It records a row in whop_memberships, mints a claim code and DMs the owner —
// all expected. Delete the row afterwards (see the SQL printed on success).
//
// Node 18+ (built-in fetch). No dependencies.

const crypto = require('crypto');

const WEBHOOK_URL = process.env.WHOP_WEBHOOK_URL
  || 'https://vendora-production-8a47.up.railway.app/whop-webhook';

// Vendora business biz_tDgAtGysVSQw4f, product prod_LlNbODGPtxp73.
// NEVER point these at the separate Fortify business — the webhook maps plan id
// to tier with no product check.
const PLANS = {
  basic: process.env.WHOP_PLAN_BASIC || 'plan_y0lLH82DL3OlF',
  pro:   process.env.WHOP_PLAN_PRO   || 'plan_Q2roL7OgEWroa',
  elite: process.env.WHOP_PLAN_ELITE || 'plan_gMttHcqPd9tg2',
};
const PRODUCT_ID = process.env.WHOP_PRODUCT_ID || 'prod_LlNbODGPtxp73';

const secret = process.env.WHOP_WEBHOOK_SECRET;
const tier   = (process.argv[2] || '').toLowerCase();

if (!secret) {
  console.error('WHOP_WEBHOOK_SECRET is not set in this shell. Set it and re-run.');
  process.exit(1);
}
if (!PLANS[tier]) {
  console.error(`Usage: node scripts/whop-test-event.js <${Object.keys(PLANS).join('|')}>`);
  process.exit(1);
}

// Whop issues secrets prefixed "ws_" (not the Standard Webhooks "whsec_") and the
// remainder is HEX — not base64, despite Whop's own docs. Confirmed by live test
// 2026-07-22. Fall back to utf8 only if it isn't clean hex.
function secretKey(s) {
  const body = String(s).replace(/^(whsec_|ws_)/, '');
  if (/^[0-9a-fA-F]+$/.test(body) && body.length % 2 === 0) {
    return { key: Buffer.from(body, 'hex'), encoding: 'hex' };
  }
  return { key: Buffer.from(body, 'utf8'), encoding: 'utf8' };
}

const suffix        = crypto.randomBytes(5).toString('hex');
const membershipId  = `mem_TEST_${suffix}`;
const webhookId     = `msg_TEST_${suffix}`;
const timestamp     = Math.floor(Date.now() / 1000); // seconds — ±300s tolerance

const payload = {
  action: 'membership.activated',
  data: {
    id:       membershipId,
    user:     { id: `user_TEST_${suffix}`, email: `test+${suffix}@vendora.site` },
    plan:     { id: PLANS[tier] },
    product:  { id: PRODUCT_ID },
    status:   'active',
    metadata: {},   // deliberately empty: must not match a real Discord profile
  },
};

// Sign the RAW bytes exactly as sent. Signed content is "{id}.{timestamp}.{body}",
// HMAC-SHA256, base64 digest, header formatted "v1,<sig>".
const raw = Buffer.from(JSON.stringify(payload), 'utf8');
const { key, encoding } = secretKey(secret);
const signature = crypto.createHmac('sha256', key)
  .update(`${webhookId}.${timestamp}.${raw.toString('utf8')}`)
  .digest('base64');

(async () => {
  console.log(`→ ${tier}  plan=${PLANS[tier]}  membership=${membershipId}  (secret decoded as ${encoding})`);

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'webhook-id':        webhookId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${signature}`,
    },
    body: raw,
  });

  const text = await res.text();
  console.log(`← HTTP ${res.status} ${text}`);

  if (res.status === 401) {
    console.error('\nRejected: signature mismatch, or the timestamp fell outside the 5-minute window.');
    console.error('Check WHOP_WEBHOOK_SECRET is the value from the Whop dashboard Developer tab.');
    process.exit(1);
  }
  if (!res.ok) { console.error('\nUnexpected response — check Railway logs.'); process.exit(1); }

  console.log(`
Now check the Railway logs. You want:
  [whop] Signature verified (secret encoding: hex)
  [whop] Event: membership.activated
and NO line containing: UNMAPPED PLAN

If you see UNMAPPED PLAN, the Railway env var for ${tier} is wrong.

Then clean up in Supabase SQL editor:
  delete from whop_memberships where membership_id = '${membershipId}';
`);
})().catch(e => { console.error('Request failed:', e.message); process.exit(1); });
