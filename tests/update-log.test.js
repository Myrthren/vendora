'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const log = require('../bot/update-log');

test('verifies GitHub signatures with a timing-safe comparison', () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const secret = 'test-secret';
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(log.validSignature(body, signature, secret), true);
  assert.equal(log.validSignature(body, signature.replace(/.$/, '0'), secret), false);
  assert.equal(log.validSignature(body, 'sha1=bad', secret), false);
});

test('groups conventional commits and selects the highest semantic bump', () => {
  const commits = [
    { message: 'fix: handle expired inventory snapshots' },
    { message: 'feat: add release digest' },
    { message: 'docs: describe webhook setup' },
  ];
  assert.equal(log.requiredBump(commits), 'minor');
  assert.deepEqual(log.releaseNotes(commits), [
    { label: 'Fixes', items: ['Handle expired inventory snapshots'] },
    { label: 'Features', items: ['Add release digest'] },
    { label: 'Documentation', items: ['Describe webhook setup'] },
  ]);
});

test('breaking changes take precedence and versions roll correctly', () => {
  assert.equal(log.parseCommit('feat!: replace webhook protocol').bump, 'major');
  assert.equal(log.parseCommit('fix: compatibility\n\nBREAKING CHANGE: old clients fail').bump, 'major');
  assert.equal(log.bumpVersion('6.153.0', 'patch'), '6.153.1');
  assert.equal(log.bumpVersion('6.153.0', 'minor'), '6.154.0');
  assert.equal(log.bumpVersion('6.153.0', 'major'), '7.0.0');
});

test('uses the established Vendora message layout with the role mention last', () => {
  const message = log.messageForRelease({ version: '6.155.0', correlation: 'release-1', commits: [
    { message: 'feat: run Intel and Vendex web features on Netlify Functions' },
    { message: 'style: tint Intel launcher effects pink' },
  ] }, '1505563141088743464');
  assert.match(message, /^📦 \*\*Vendora v6\.155\*\* — Run Intel and Vendex web features on Netlify Functions\n\n• Run Intel and Vendex web features on Netlify Functions\n• Tint Intel launcher effects pink\n\n<@&1505563141088743464>/);
  assert.equal(message.includes(log.hiddenMarker('release-1')), true);
});

test('only compare statuses with the tracked commit behind the head are reachable', () => {
  assert.equal(log.reachableCompareStatus('ahead'), true);
  assert.equal(log.reachableCompareStatus('identical'), true);
  assert.equal(log.reachableCompareStatus('diverged'), false);
  assert.equal(log.reachableCompareStatus('behind'), false);
});

