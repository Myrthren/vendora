#!/usr/bin/env node
// Pre-flight: does Whop's token endpoint accept our client authentication?
//
// Answers that WITHOUT a real authorization code, so you can validate the fix
// before deploying and before burning a Connect click.
//
// The trick: send a deliberately fake `code`. Client authentication is checked
// BEFORE the code is validated, so the error tells you which stage you reached:
//
//   invalid_grant   -> client auth SUCCEEDED, only the fake code was rejected  ✅
//   invalid_client  -> client auth FAILED, this method is wrong                ❌
//
//   $env:WHOP_OAUTH_CLIENT_ID     = "app_HgEVw8r6BGL7XO"   # PowerShell
//   $env:WHOP_OAUTH_CLIENT_SECRET = "..."                  # set it yourself
//   node scripts/whop-preflight-auth.js
//
// Node 18+ (built-in fetch). No dependencies. Nothing is written anywhere.

const TOKEN_URL = 'https://api.whop.com/oauth/token';

const clientId     = process.env.WHOP_OAUTH_CLIENT_ID;
const clientSecret = process.env.WHOP_OAUTH_CLIENT_SECRET;
const redirectUri  = process.env.WHOP_OAUTH_REDIRECT_URI
  || 'https://vendora-production-8a47.up.railway.app/api/whop/oauth/callback';

if (!clientId || !clientSecret) {
  console.error('Set WHOP_OAUTH_CLIENT_ID and WHOP_OAUTH_CLIENT_SECRET in this shell first.');
  process.exit(1);
}

// Fake but well-formed. Never a real code — this must not consume anything.
const params = {
  grant_type:    'authorization_code',
  code:          'PREFLIGHT_NOT_A_REAL_CODE',
  redirect_uri:  redirectUri,
  client_id:     clientId,
  code_verifier: 'preflight_verifier_that_is_long_enough_to_be_well_formed_0123456789',
};

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

const attempts = [
  {
    label:   'client_secret_basic  (what the patch now tries first)',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
    body:    JSON.stringify(params),
  },
  {
    label:   'client_secret_post   (form-encoded)',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ ...params, client_secret: clientSecret }).toString(),
  },
  {
    label:   'secret in JSON body  (the OLD broken behaviour)',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...params, client_secret: clientSecret }),
  },
  {
    label:   'none                 (public PKCE)',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params),
  },
];

(async () => {
  console.log(`Probing ${TOKEN_URL} with client_id=${clientId}\n`);
  const results = [];

  for (const a of attempts) {
    let status = 0, payload = {};
    try {
      const res = await fetch(TOKEN_URL, { method: 'POST', headers: a.headers, body: a.body });
      status = res.status;
      payload = await res.json().catch(() => ({}));
    } catch (e) {
      console.log(`${a.label}\n   request failed: ${e.message}\n`);
      continue;
    }

    const err = payload?.error || '(none)';
    // invalid_grant means we got PAST client authentication — the only thing it
    // objected to was our deliberately fake code. That is the result we want.
    const authOk = err === 'invalid_grant';
    results.push({ label: a.label, authOk, err });

    console.log(`${a.label}`);
    console.log(`   HTTP ${status}  error=${err}`);
    if (payload?.error_description) console.log(`   ${payload.error_description}`);
    console.log(`   -> client auth ${authOk ? 'ACCEPTED ✅' : 'REJECTED ❌'}\n`);
  }

  const winners = results.filter(r => r.authOk).map(r => r.label.split('(')[0].trim());
  console.log('─'.repeat(60));
  if (winners.length) {
    console.log(`Accepted auth method(s): ${winners.join(', ')}`);
    if (winners.some(w => w.startsWith('client_secret_basic'))) {
      console.log('client_secret_basic works — the patch will succeed. Deploy it.');
    } else {
      console.log('Basic did NOT work but another method did — reorder the attempts in');
      console.log('bot/index.js so the working one is tried first.');
    }
  } else {
    console.log('No method authenticated. The credentials themselves are wrong,');
    console.log('or the client_id/secret pair do not belong together.');
    console.log('Do NOT deploy yet — recheck both values in the Whop developer dashboard.');
  }
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
