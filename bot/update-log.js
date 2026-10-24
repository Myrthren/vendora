'use strict';

// Durable GitHub-to-Discord release notes. The HTTP route and Discord client are
// deliberately injected so this module can be tested without either service.
const crypto = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;
const SECTION = {
  feat: { label: 'Features', bump: 'minor' },
  fix: { label: 'Fixes', bump: 'patch' },
  perf: { label: 'Fixes', bump: 'patch' },
  security: { label: 'Security', bump: 'patch' },
  refactor: { label: 'Improvements', bump: 'patch' },
  docs: { label: 'Documentation', bump: 'patch' },
  chore: { label: 'Maintenance', bump: 'patch' },
  test: { label: 'Maintenance', bump: 'patch' },
  build: { label: 'Maintenance', bump: 'patch' },
  ci: { label: 'Maintenance', bump: 'patch' },
};
const BUMP_RANK = { patch: 0, minor: 1, major: 2 };

function validSignature(raw, supplied, secret) {
  if (!secret || typeof supplied !== 'string' || !supplied.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCommit(message) {
  const full = String(message || '').trim();
  const subject = full.split('\n')[0] || 'Other change';
  const match = /^([a-z]+)(?:\([^)]*\))?(!)?:\s*(.+)$/i.exec(subject);
  const type = match?.[1]?.toLowerCase() || 'other';
  const breaking = Boolean(match?.[2]) || /BREAKING CHANGE:/i.test(full);
  const config = SECTION[type] || { label: 'Other changes', bump: 'patch' };
  return {
    type,
    section: config.label,
    bump: breaking ? 'major' : config.bump,
    breaking,
    text: ((match?.[3] || subject).replace(/\s+/g, ' ').trim().replace(/^./, char => char.toUpperCase())),
  };
}

function requiredBump(commits) {
  return (commits || []).reduce((highest, commit) => {
    const bump = parseCommit(commit.message).bump;
    return BUMP_RANK[bump] > BUMP_RANK[highest] ? bump : highest;
  }, 'patch');
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) };
}

function bumpVersion(current, bump) {
  const version = parseVersion(current);
  if (!version) throw new Error('UPDATE_LOG_INITIAL_VERSION must be a semantic version, for example 6.153.0.');
  if (bump === 'major') return `${version.major + 1}.0.0`;
  if (bump === 'minor') return `${version.major}.${version.minor + 1}.0`;
  return `${version.major}.${version.minor}.${version.patch + 1}`;
}

function releaseNotes(commits) {
  const groups = new Map();
  for (const commit of commits || []) {
    const parsed = parseCommit(commit.message);
    if (!groups.has(parsed.section)) groups.set(parsed.section, []);
    groups.get(parsed.section).push(parsed.text);
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}

function embedForRelease(release, repository) {
  const notes = releaseNotes(release.commits);
  const lines = [];
  for (const group of notes) {
    lines.push(`**${group.label}**`);
    for (const item of group.items) {
      if (lines.join('\n').length > 3400) { lines.push('• Additional changes are in the compare view.'); break; }
      lines.push(`• ${item}`);
    }
  }
  const compare = release.baseSha && release.headSha
    ? `https://github.com/${repository}/compare/${release.baseSha}...${release.headSha}` : null;
  const colour = release.bump === 'major' ? 0xed4245 : release.bump === 'minor' ? 0x57f287 : 0x5865f2;
  return {
    title: `Vendora v${release.version}`,
    description: lines.join('\n').slice(0, 4096) || '• Maintenance release.',
    color: colour,
    url: compare || undefined,
    footer: { text: `Vendora release · ${release.correlation}` },
    timestamp: new Date().toISOString(),
  };
}

function revertTarget(message) {
  const match = /This reverts commit ([0-9a-f]{7,40})\./i.exec(String(message || ''));
  return match ? match[1].toLowerCase() : null;
}

// GitHub's compare status tells whether the first ref is still an ancestor of
// the second: only "ahead" and "identical" are reachable from the new head.
function reachableCompareStatus(status) {
  return status === 'ahead' || status === 'identical';
}

function createStore({ url, key, request = fetch }) {
  const headers = () => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
  const table = (name, query = '') => `${url}/rest/v1/${name}${query}`;
  async function call(path, options = {}) {
    if (!key) throw new Error('Release-log storage is not configured.');
    const response = await request(path, { ...options, headers: { ...headers(), ...(options.headers || {}) }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Release-log storage failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }
  return {
    async claimDelivery(id) {
      const rows = await call(table('release_log_deliveries'), { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ delivery_id: id, expires_at: new Date(Date.now() + 90 * DAY).toISOString() }) });
      return Array.isArray(rows) && rows.length === 1;
    },
    async purgeExpiredDeliveries() {
      await call(table('release_log_deliveries', `?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`), { method: 'DELETE' });
    },
    async openBatch(branch) {
      const rows = await call(table('release_log_batches', `?branch=eq.${encodeURIComponent(branch)}&status=eq.open&select=*&limit=1`));
      return rows[0] || null;
    },
    async createBatch(row) {
      const rows = await call(table('release_log_batches'), { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      return rows[0];
    },
    async updateBatch(id, patch) {
      const rows = await call(table('release_log_batches', `?id=eq.${encodeURIComponent(id)}`), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      return rows[0] || null;
    },
    async addCommit(row) {
      await call(table('release_log_commits'), { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: JSON.stringify(row) });
    },
    async commits(batchId) {
      return call(table('release_log_commits', `?batch_id=eq.${encodeURIComponent(batchId)}&removed_at=is.null&select=*&order=committed_at.asc`));
    },
    async removeCommit(batchId, sha) {
      await call(table('release_log_commits', `?batch_id=eq.${encodeURIComponent(batchId)}&sha=ilike.${encodeURIComponent(sha)}%25&removed_at=is.null`), { method: 'PATCH', body: JSON.stringify({ removed_at: new Date().toISOString() }) });
    },
    async batchesWithCommit(sha) {
      return call(table('release_log_commits', `?sha=ilike.${encodeURIComponent(sha)}%25&removed_at=is.null&select=batch_id`));
    },
    async batch(id) {
      const rows = await call(table('release_log_batches', `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`));
      return rows[0] || null;
    },
    async dueBatches(now) {
      return call(table('release_log_batches', `?status=eq.open&window_closes_at=lte.${encodeURIComponent(now.toISOString())}&select=*`));
    },
    async trackedBatches(branch) {
      return call(table('release_log_batches', `?branch=eq.${encodeURIComponent(branch)}&status=in.(open,published)&select=*`));
    },
    async lastPublishedVersion() {
      const rows = await call(table('release_log_batches', '?status=eq.published&select=version&order=published_at.desc&limit=1'));
      return rows[0]?.version || null;
    },
    async createOutbox(row) {
      const rows = await call(table('release_log_outbox'), { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(row) });
      return rows[0] || null;
    },
    async updateOutbox(id, patch) {
      await call(table('release_log_outbox', `?id=eq.${encodeURIComponent(id)}`), { method: 'PATCH', body: JSON.stringify(patch) });
    },
    async outbox(batchId) {
      const rows = await call(table('release_log_outbox', `?batch_id=eq.${encodeURIComponent(batchId)}&operation=eq.publish&select=*&limit=1`));
      return rows[0] || null;
    },
  };
}

function createReleaseLog({ store, client, config, request = fetch, now = () => new Date(), logger = console } = {}) {
  const ready = () => Boolean(config?.secret && config?.channelId && config?.initialVersion && client?.isReady?.());
  const channel = async () => {
    const value = await client.channels.fetch(config.channelId);
    if (!value?.isTextBased?.()) throw new Error('DISCORD_UPDATE_LOG_CHANNEL_ID is not a text channel.');
    return value;
  };
  const active = async batch => store.commits(batch.id);

  async function updatePublished(batch) {
    const commits = await active(batch);
    const ch = await channel();
    const message = await ch.messages.fetch(batch.discord_message_id).catch(() => null);
    if (!commits.length) {
      if (message) await message.delete().catch(() => {});
      await store.updateBatch(batch.id, { status: 'reverted', reverted_at: now().toISOString() });
      return;
    }
    const release = { version: batch.version, bump: requiredBump(commits), commits, baseSha: batch.base_sha, headSha: batch.head_sha, correlation: batch.correlation };
    if (message) await message.edit({ content: config.roleId ? `<@&${config.roleId}>` : '', embeds: [embedForRelease(release, config.repository)], allowedMentions: { parse: [] } });
  }

  async function publish(batch) {
    const commits = await active(batch);
    if (!commits.length) return store.updateBatch(batch.id, { status: 'reverted', reverted_at: now().toISOString() });
    let outbox = await store.outbox(batch.id);
    if (!outbox) outbox = await store.createOutbox({ batch_id: batch.id, operation: 'publish', state: 'pending', correlation: batch.correlation });
    const ch = await channel();
    // Recover a send that succeeded just before a process crash. The stable
    // footer marker means a retry can adopt that message instead of duplicating it.
    const recent = await ch.messages.fetch({ limit: 100 });
    let message = recent.find(m => m.embeds.some(e => e.footer?.text === `Vendora release · ${batch.correlation}`));
    if (!message) {
      await store.updateOutbox(outbox.id, { state: 'sending', attempted_at: now().toISOString() });
      const previous = await store.lastPublishedVersion() || config.initialVersion;
      const release = { version: bumpVersion(previous, requiredBump(commits)), bump: requiredBump(commits), commits, baseSha: batch.base_sha, headSha: batch.head_sha, correlation: batch.correlation };
      message = await ch.send({ content: config.roleId ? `<@&${config.roleId}>` : '', embeds: [embedForRelease(release, config.repository)], allowedMentions: config.roleId ? { roles: [config.roleId] } : { parse: [] } });
      await store.updateBatch(batch.id, { version: release.version });
    }
    const version = batch.version || (await store.batch(batch.id))?.version;
    await store.updateBatch(batch.id, { status: 'published', published_at: now().toISOString(), discord_message_id: message.id, discord_channel_id: ch.id, version });
    await store.updateOutbox(outbox.id, { state: 'sent', discord_message_id: message.id, sent_at: now().toISOString() });
  }

  async function reconcileForcePush(branch, after) {
    for (const batch of await store.trackedBatches(branch)) {
      for (const commit of await active(batch)) {
        const response = await request(`https://api.github.com/repos/${config.repository}/compare/${commit.sha}...${after}`, { headers: config.githubToken ? { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json' } : { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
        // A transient GitHub failure must never be interpreted as proof that a
        // commit disappeared from the branch. The next forced-push delivery can
        // safely retry this check.
        if (!response.ok) {
          logger.warn('[update-log] Could not reconcile forced push:', response.status);
          continue;
        }
        if (!reachableCompareStatus((await response.json()).status)) await store.removeCommit(batch.id, commit.sha);
      }
      const fresh = await store.batch(batch.id);
      if (fresh?.status === 'published') await updatePublished(fresh);
    }
  }

  async function receive(raw, headers) {
    if (!ready()) return { status: 503, body: { error: 'Release log is not configured.' } };
    if (headers['x-github-event'] !== 'push') return { status: 202, body: { ignored: 'event' } };
    if (!validSignature(raw, headers['x-hub-signature-256'], config.secret)) return { status: 401, body: { error: 'Invalid GitHub signature.' } };
    const delivery = headers['x-github-delivery'];
    if (!delivery) return { status: 400, body: { error: 'Missing GitHub delivery ID.' } };
    if (!await store.claimDelivery(delivery)) return { status: 202, body: { duplicate: true } };
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { error: 'Invalid JSON.' } }; }
    const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
    if (branch !== config.branch || payload.deleted) return { status: 202, body: { ignored: 'branch' } };
    if (payload.forced) await reconcileForcePush(branch, payload.after);
    let batch = await store.openBatch(branch);
    if (!batch) {
      const opened = now();
      batch = await store.createBatch({ branch, base_sha: payload.before, head_sha: payload.after, opened_at: opened.toISOString(), window_closes_at: new Date(opened.getTime() + config.windowHours * 3600000).toISOString(), status: 'open', correlation: crypto.randomUUID() });
    } else batch = await store.updateBatch(batch.id, { head_sha: payload.after });
    for (const commit of payload.commits || []) {
      const reverted = revertTarget(commit.message);
      if (reverted) {
        for (const row of await store.batchesWithCommit(reverted)) {
          await store.removeCommit(row.batch_id, reverted);
          const prior = await store.batch(row.batch_id);
          if (prior?.status === 'published') await updatePublished(prior);
        }
        // A standard revert represents removing the original work; it does not
        // become a second release-note bullet of its own.
        continue;
      }
      await store.addCommit({ batch_id: batch.id, sha: commit.id, message: commit.message, committed_at: commit.timestamp || now().toISOString(), author_name: commit.author?.name || null });
    }
    return { status: 202, body: { accepted: true, closesAt: batch.window_closes_at } };
  }

  async function flush() {
    if (!ready()) return;
    await store.purgeExpiredDeliveries();
    for (const batch of await store.dueBatches(now())) {
      try { await publish(batch); } catch (error) { logger.error('[update-log] Publish failed:', error.message); }
    }
  }
  return { receive, flush, enabled: ready };
}

module.exports = { validSignature, parseCommit, requiredBump, parseVersion, bumpVersion, releaseNotes, embedForRelease, revertTarget, reachableCompareStatus, createStore, createReleaseLog };

