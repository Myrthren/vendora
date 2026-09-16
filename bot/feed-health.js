// Deal feed health — noticing when the feed cannot reach Vinted, and saying so.
//
// The feed runs on the browser only; there is no paid fallback, so a failed
// search means a keyword simply was not checked. That must never be silent:
//   - the first failing run DMs the owner straight away;
//   - if failures are still happening ALERT_AFTER_MS later, a notice goes to
//     the feed channels so members know finds may be missing;
//   - the first clean run closes the outage: the owner is told, and the
//     channel notices are edited in place to say the feed is back.
//
// State lives in the settings table (FEED_HEALTH_KEY), not in memory, because
// Railway redeploys often and a restart must not reset the one-hour clock.
//
// Pure, like the other payload builders: no client, no database.

const { EmbedBuilder } = require('discord.js');

const PINK  = '#e8217a';
const GREEN = '#4ade80';
const RED   = '#f87171';

const ALERT_AFTER_MS = 60 * 60 * 1000;

function emptyState() {
  return { failingSince: null, lastFailureAt: null, failures: [], failedRuns: 0, alertMessages: null };
}

// Decide what one feed run means for the outage state.
//   failures — [{ keyword, error }] from this run
//   searched — keywords attempted this run (0 means nothing to judge)
// Returns { state, actions } where actions says which messages to send.
function nextHealth(prev, { failures = [], searched = 0, now = Date.now(), alertAfterMs = ALERT_AFTER_MS } = {}) {
  const state   = { ...emptyState(), ...(prev || {}) };
  const actions = { dmDown: false, postAlert: false, resolve: false };

  if (!searched) return { state, actions };

  if (failures.length) {
    if (!state.failingSince) {
      state.failingSince = now;
      state.failedRuns   = 0;
      actions.dmDown     = true;
    }
    state.lastFailureAt = now;
    state.failures      = failures.slice(0, 25);
    state.failedRuns   += 1;
    if (!state.alertMessages && now - state.failingSince >= alertAfterMs) actions.postAlert = true;
    return { state, actions };
  }

  if (state.failingSince) actions.resolve = true;
  return { state: emptyState(), actions, closed: actions.resolve ? state : null };
}

function formatDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

function failureLines(failures) {
  const lines = failures.slice(0, 10).map(f => `• **${f.keyword}** — ${String(f.error || 'unknown error').slice(0, 140)}`);
  if (failures.length > 10) lines.push(`• +${failures.length - 10} more`);
  return lines.join('\n') || '—';
}

// Owner DM, sent on the first failing run of an outage.
function buildOwnerDownPayload({ failures, searched, now = Date.now() }) {
  const embed = new EmbedBuilder()
    .setColor(RED)
    .setTitle('Deal feed: Vinted search failing')
    .setDescription(
      `${failures.length} of ${searched} keyword search${searched === 1 ? '' : 'es'} failed this run. ` +
      `Those keywords were skipped — the feed has no paid fallback.\n\n${failureLines(failures)}`
    )
    .addFields({
      name: 'What happens next',
      value: 'If searches are still failing in 1 hour, a notice goes to the feed channels. ' +
             'You will get another DM as soon as a run succeeds. ' +
             'First thing to check: the `vinted` block on the bot\'s `GET /`.',
    })
    .setFooter({ text: 'Vendora · deal feed health' })
    .setTimestamp(now);
  return { embeds: [embed] };
}

// Owner DM, sent when a clean run closes the outage.
function buildOwnerResolvedPayload({ closed, now = Date.now() }) {
  const embed = new EmbedBuilder()
    .setColor(GREEN)
    .setTitle('Deal feed: Vinted search recovered')
    .setDescription(
      `Every keyword searched cleanly again after ${formatDuration(now - closed.failingSince)} ` +
      `(${closed.failedRuns} failing run${closed.failedRuns === 1 ? '' : 's'}).` +
      (closed.alertMessages ? '\nThe channel notices have been updated to say the feed is back.' : '')
    )
    .setFooter({ text: 'Vendora · deal feed health' })
    .setTimestamp(now);
  return { embeds: [embed] };
}

// Member-facing notice. Says what members can observe — finds may be missing —
// without internal detail they cannot act on.
function buildChannelAlertPayload({ failingSince, now = Date.now() }) {
  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle('Deal feed disrupted')
    .setDescription(
      `We have been having trouble reaching Vinted for about ${formatDuration(now - failingSince)}, ` +
      'so some finds may be delayed or missing from this channel.\n\n' +
      'We are on it. This message will update when the feed is back to normal.'
    )
    .setFooter({ text: 'Vendora · The Market' })
    .setTimestamp(now);
  return { embeds: [embed] };
}

function buildChannelResolvedPayload({ closed, now = Date.now() }) {
  const embed = new EmbedBuilder()
    .setColor(GREEN)
    .setTitle('Deal feed back to normal')
    .setDescription(
      `The feed is reaching Vinted again. It was disrupted for about ${formatDuration(now - closed.failingSince)}.`
    )
    .setFooter({ text: 'Vendora · The Market' })
    .setTimestamp(now);
  return { embeds: [embed] };
}

module.exports = {
  ALERT_AFTER_MS,
  emptyState,
  nextHealth,
  formatDuration,
  buildOwnerDownPayload,
  buildOwnerResolvedPayload,
  buildChannelAlertPayload,
  buildChannelResolvedPayload,
};
