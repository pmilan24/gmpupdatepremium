const test = require('node:test');
const assert = require('node:assert/strict');
const { readLatest } = require('../subscription-feed');
const { runSession } = require('../subscription-session');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const snapshot = (time, total) => ({ lastUpdated: time, companies: [{ summary: { totalTimes: total } }] });

test('manual Pages refresh selects newer repository data over stale deployment', async () => {
  const calls = [];
  const result = await readLatest({ pages: true, manual: true, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => url.includes('raw.githubusercontent.com')
      ? snapshot('2026-09-22T07:10:00Z', 33.37) : snapshot('2026-09-22T06:58:00Z', 32.74) };
  } });
  assert.equal(result.data.companies[0].summary.totalTimes, 33.37);
  assert.ok(calls.every(url => url.includes('force=1')));
});
test('repository outage falls back to deployed snapshot', async () => {
  const result = await readLatest({ pages: true, fetchImpl: async url => {
    if (url.includes('raw.githubusercontent.com')) throw new Error('offline');
    return { ok: true, json: async () => snapshot('2026-09-22T06:58:00Z', 32.74) };
  } });
  assert.equal(result.source, 'Saved website snapshot');
});
test('does not prefer an older repository cache over a newer website snapshot', async () => {
  const result = await readLatest({ pages: true, fetchImpl: async url => ({ ok: true,
    json: async () => url.includes('raw.githubusercontent.com')
      ? snapshot('2026-09-22T06:58:00Z', 32.74) : snapshot('2026-09-22T07:10:00Z', 33.37) }) });
  assert.equal(result.data.companies[0].summary.totalTimes, 33.37);
});
test('live session publishes each minute without waiting for another cron event', async () => {
  let time = 0, syncs = 0, publishes = 0;
  const result = await runSession({ durationMs: 180000, now: () => time,
    wait: async ms => { time += ms; }, schedule: () => ({ open: true, intervalSec: 60 }),
    sync: async () => { syncs++; time += 9000; }, publish: async () => { publishes++; time += 1000; } });
  assert.equal(result.cycles, 3); assert.equal(syncs, 3); assert.equal(publishes, 3);
});
test('scheduled session stops outside market hours, manual run syncs only once', async () => {
  let syncs = 0;
  const options = { schedule: () => ({ open: false }), sync: async () => { syncs++; }, publish: async () => {} };
  await runSession(options); assert.equal(syncs, 0);
  await runSession({ ...options, forceFirst: true }); assert.equal(syncs, 1);
});
test('primary failure uses alternate direct source with validated content', async () => {
  const calls = [];
  const html = `<div class="ipo-item" data-id="7"><h3 class="sp-ipo-name">Example IPO</h3>
    Subscription Details<table><tr><th>Category</th><th>Offered</th><th>Applied</th><th>Times</th></tr>
    <tr><td>Total</td><td>100</td><td>3300</td><td>33</td></tr></table></div>`;
  const context = { require(name) {
    if (name === './sources') return { SUB_DASH_URL: 'https://primary.test/', SUB_WEB_URL: 'https://alternate.test/' };
    if (name === './proxy-rotator') return { proxyRotator: { async fetchWithRotation(url, options, validate) {
      calls.push(url); assert.equal(options.directOnly, true);
      if (calls.length === 1) throw new Error('timeout');
      assert.equal(validate(html), true); return { text: html, strategy: 'direct' };
    } } };
    return require(name);
  }, module: { exports: {} }, console: { log() {}, warn() {} }, __dirname: path.resolve(__dirname, '..') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../fetch-subscription.js'), 'utf8'), context);
  const data = await context.module.exports.fetchLiveSubscription();
  assert.equal(calls.length, 2); assert.equal(data[0].summary.totalTimes, 33);
});
