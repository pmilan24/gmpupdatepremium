const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadSync({ scrape, request } = {}) {
  const writes = [];
  const context = {
    require(name) {
      if (name === 'fs') return { existsSync: () => false, appendFileSync() {},
        writeFileSync: (...args) => writes.push(args) };
      if (name === './sources') return { BACKEND_IPO_LIST_URL: 'https://backend.test/list/',
        BACKEND_UPDATE_SUB_URL: 'https://backend.test/update/', BACKEND_API_TOKEN: 'test' };
      if (name === './fetch-subscription') return { fetchLiveSubscription: scrape || (async () => []) };
      if (name === './auth-manager') return { getBearerToken: async () => 'test' };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { argv: [], env: {} }, console: { log() {}, warn() {} },
    fetch: request, AbortSignal, Date, Intl, setTimeout: fn => setTimeout(fn, 0)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../sync-subscription-api.js'), 'utf8'), context);
  return { ...context.module.exports, writes };
}
const company = { companyName: 'Vivekanand Cotspin', sharesBreakup: [
  { category: 'Retail', offered: 100, applied: 25 }
], applicationsBreakup: [] };

test('matching never maps Vivekanand to ANAND', () => {
  const { findMatchingIpo } = loadSync();
  const backend = [{ symbol: 'ANAND', company_name: 'Anand Seamless' },
    { symbol: 'VIVEKANAND', company_name: 'Vivekanand Cotspin Limited' }];
  assert.equal(findMatchingIpo(company, backend).symbol, 'VIVEKANAND');
  assert.equal(findMatchingIpo(company, backend.slice(0, 1)), null);
});
test('IST schedule boundaries and weekends', () => {
  const { getMarketScheduleStatus: schedule } = loadSync();
  assert.equal(schedule(new Date('2026-09-22T04:24:00Z')).open, false);
  assert.equal(schedule(new Date('2026-09-22T04:25:00Z')).intervalSec, 60);
  assert.equal(schedule(new Date('2026-09-22T11:31:00Z')).intervalSec, 600);
  assert.equal(schedule(new Date('2026-09-22T12:31:00Z')).open, false);
  assert.equal(schedule(new Date('2026-09-26T06:00:00Z')).open, false);
});
test('failed scrape preserves snapshot and rejects', async () => {
  const sync = loadSync();
  await assert.rejects(sync.runSyncCycle(), /No valid/);
  assert.equal(sync.writes.length, 0);
});
test('backend failures reject after saving valid website snapshot', async () => {
  const sync = loadSync({ scrape: async () => [company], request: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(sync.runSyncCycle(), /Backend IPO list/);
  assert.equal(sync.writes.length, 1);
});
test('concurrent refreshes share a single scrape and PUT', async () => {
  let scrapes = 0, puts = 0;
  const sync = loadSync({ scrape: async () => { scrapes++; return [company]; },
    request: async (url, options) => {
      if (options.method === 'GET') return { ok: true, json: async () => ({ data: [
        { symbol: 'VIVEKANAND', company_name: company.companyName }
      ] }) };
      puts++;
      assert.match(url, /VIVEKANAND\/$/);
      assert.equal(JSON.parse(options.body).subscription[0].Applied, 25);
      return { ok: true, status: 200, text: async () => '{}' };
    } });
  await Promise.all([sync.runSyncCycle(), sync.runSyncCycle()]);
  assert.equal(scrapes, 1);
  assert.equal(puts, 1);
});
test('failed PUT does not report a successful cycle', async () => {
  const sync = loadSync({ scrape: async () => [company], request: async (_, options) =>
    options.method === 'GET' ? { ok: true, json: async () => ({ data: [
      { symbol: 'VIVEKANAND', company_name: company.companyName }
    ] }) } : { ok: false, status: 500, text: async () => 'failed' } });
  await assert.rejects(sync.runSyncCycle(), /no backend updates succeeded/);
});

test('HTTP 200 PUT with API permission error is treated as failed', async () => {
  const sync = loadSync({ scrape: async () => [company], request: async (_, options) =>
    options.method === 'GET' ? { ok: true, json: async () => ({ data: [
      { symbol: 'VIVEKANAND', company_name: company.companyName }
    ] }) } : { ok: true, status: 200, text: async () => JSON.stringify({
      meta: { status: false, status_code: 403, message: 'Validation error',
        validations: [{ error: ['You do not have permission to perform this action.'] }] },
      data: {}
    }) } });
  await assert.rejects(sync.runSyncCycle(), /no backend updates succeeded/);
});

test('proxy requests use real proxies and block denied routes', async () => {
  const calls = [];
  const context = {
    require(name) {
      if (name === './sources') return {};
      if (name === 'fs') return { readFileSync() { throw new Error('no cache'); },
        mkdirSync() {}, writeFileSync() {} };
      if (name === 'child_process') return { execFile: (file, args, opts, callback) => {
        calls.push({ file, args }); callback(null, { stdout: 'limited\n429' });
      } };
      if (name === 'util') return { promisify: fn => (...args) => new Promise((resolve, reject) =>
        fn(...args, (err, result) => err ? reject(err) : resolve(result))) };
      return require(name);
    },
    process: { env: { SOURCE_PROXY_URLS: 'http://proxy1.test:8080,http://proxy2.test:8080' } },
    module: { exports: {} }, URL, Date, console: { warn() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../proxy-rotator.js'), 'utf8'), context);
  await assert.rejects(context.module.exports.proxyRotator.fetchWithRotation('https://source.test/'), /No healthy/);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args[calls[0].args.indexOf('--proxy') + 1], 'http://proxy1.test:8080');
  assert.equal(calls[0].args.some(arg => /X-Forwarded|insecure/.test(arg)), false);
  assert.equal(context.module.exports.proxyRotator.permanentBlocks.has('http://proxy1.test:8080'), true);
});
