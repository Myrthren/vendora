#!/usr/bin/env node
// Writes version.json at the site root on every Netlify build.
// Auto-bumps semver patch per commit, no manual file to maintain.
//
// Versioning scheme: vMAJOR.MINOR.PATCH
//   MAJOR + MINOR = constants below (bump manually for big changes)
//   PATCH = number of commits since BASELINE_COMMIT_COUNT
// Result: every push → patch bumps by 1. Starts at v1.0.0 on the
// first deploy after this script lands.

const { execSync } = require('child_process');
const { writeFileSync } = require('fs');
const { join } = require('path');

const MAJOR = 1;
const MINOR = 5;
// Bump MINOR manually for each feature release (matches changelog MAJOR.MINOR).
// Patch = commits since this baseline — increments automatically per push.
// Baseline reset to 90 when v1.5.0 shipped, so next deploy = v1.5.0.
const BASELINE_COMMIT_COUNT = 90;

function sh(cmd, fallback = '') {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch { return fallback; }
}

function getCommitCount() {
  // Netlify clones with full history by default; locally `git` is available.
  const n = parseInt(sh('git rev-list --count HEAD', '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

const sha     = process.env.COMMIT_REF || sh('git rev-parse HEAD', 'unknown');
const short   = sha.slice(0, 7);
const builtAt = new Date().toISOString();
const message = sh(`git log -1 --pretty=%s ${process.env.COMMIT_REF || ''}`).slice(0, 200);

const count   = getCommitCount();
const patch   = Math.max(0, count - BASELINE_COMMIT_COUNT);
const version = `v${MAJOR}.${MINOR}.${patch}`;

const out = { version, sha, short, builtAt, message };
const target = join(__dirname, '..', 'version.json');
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log('[build-version]', JSON.stringify(out));
