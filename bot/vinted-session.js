// Reading Vinted's "who is this session" endpoint.
//
// /api/v2/users/me is gone — it 404s ("Content not found") for every caller.
// Probed 2026-09-16, the site's session endpoint is /api/v2/users/current_user:
//   - no token (anonymous session) → 200 with a placeholder user:
//       { id, anon_id: "<uuid>", login: "current_user", ... }
//   - expired, forged or malformed token → 401, empty body
//   - a real member token → 200 with that member (not probed: no member token
//     was available; this is what the placeholder implies)
// /api/v2/users/{id} must NOT be used to validate: it is a public profile and
// answers for any token, including a dead one.
//
// Pure — callers do the fetch and pass in status + parsed body.

const CURRENT_USER_PATH = '/api/v2/users/current_user';

// Returns { valid: true, username, user_id } | { valid: false, error } | { valid: null, warning }
function interpretCurrentUser(status, data) {
  if (status === 401) {
    return { valid: false, error: 'Token is invalid or expired. Copy a fresh access_token_web cookie from your Vinted browser session and paste it again.' };
  }
  if (status !== 200) {
    return { valid: null, warning: `Vinted returned ${status || 'no status'} during validation — token saved.` };
  }
  const u = data?.user || null;
  if (!u || !u.id) {
    return { valid: null, warning: 'Vinted returned an unexpected response during validation — token saved.' };
  }
  // The anonymous placeholder means the token was not applied to the request,
  // which says nothing about the token itself. Unvalidated, not rejected: a
  // real member must never be locked out by an assumption about this payload.
  if (u.anon_id || u.login === 'current_user') {
    return { valid: null, warning: 'Vinted did not recognise the session during validation — token saved unvalidated.' };
  }
  return { valid: true, username: u.login || u.username || '', user_id: String(u.id) };
}

module.exports = { CURRENT_USER_PATH, interpretCurrentUser };
