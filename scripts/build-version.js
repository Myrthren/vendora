#!/usr/bin/env node
// Writes version.json at the site root on every Netlify/Railway build.
//
// Versioning scheme:
//   • Before v6.2: vMAJOR.MINOR.PATCH  (three-part, patch auto-increments per commit)
//   • From v6.2 onwards: vMAJOR.MINOR   (two-part, MINOR auto-increments per commit,
//     giving v6.2 → v6.3 → v6.4 … i.e. +0.1 per release, not +0.01)
//
// To release v6.2: set MAJOR=6, MINOR=2, set BASELINE_COMMIT_COUNT to current
// git rev-list count. Each subsequent push will show v6.3, v6.4, etc.

const { execSync } = require('child_process');
const { writeFileSync } = require('fs');
const { join } = require('path');

// ── Bump these manually when making a major/minor version jump ────────────────
const MAJOR = 6;
const MINOR = 2;
// Set to the git commit count at the time MAJOR.MINOR was set.
// Every commit after this baseline adds 1 to the displayed minor version.
// Current count at v6.2 baseline: 110
const BASELINE_COMMIT_COUNT = 110;
// ─────────────────────────────────────────────────────────────────────────────

function sh(cmd, fallback = '') {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch { return fallback; }
}

function getCommitCount() {
  const n = parseInt(sh('git rev-list --count HEAD', '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

const sha     = process.env.COMMIT_REF || sh('git rev-parse HEAD', 'unknown');
const short   = sha.slice(0, 7);
const builtAt = new Date().toISOString();
const message = sh(`git log -1 --pretty=%s ${process.env.COMMIT_REF || ''}`).slice(0, 200);

const count = getCommitCount();
const bump  = Math.max(0, count - BASELINE_COMMIT_COUNT);

// From v6.2 onwards: two-part versioning (MAJOR.MINOR+bump), +0.1 per release
const version = `v${MAJOR}.${MINOR + bump}`;

const out = { version, sha, short, builtAt, message };
const target = join(__dirname, '..', 'version.json');
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log('[build-version]', JSON.stringify(out));
