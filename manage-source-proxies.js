// Refresh and validate free proxy routes for subscription scraping.
// Secrets stay in .env; this file only writes cache/source-proxies.json.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const cacheDir = path.join(__dirname, 'cache');
const cacheFile = path.join(cacheDir, 'source-proxies.json');

const defaultSources = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt'
];

function parseProxyLine(line, fallbackProtocol = 'http') {
  const clean = String(line || '').trim();
  if (!clean || clean.startsWith('#')) return null;
  if (/^(https?|socks5h?|socks4):\/\//i.test(clean)) return clean.replace(/^socks5:\/\//i, 'socks5h://');
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(clean)) return `${fallbackProtocol}://${clean}`;
  return null;
}

async function fetchText(url) {
  const { stdout } = await execFileAsync('curl', [
    '--silent', '--show-error', '--location', '--max-time', '15',
    '--proto', '=http,https', '--proto-redir', '=http,https',
    url
  ], { maxBuffer: 8 * 1024 * 1024, timeout: 18000 });
  return stdout;
}

async function collectCandidates() {
  const configuredSources = (process.env.SOURCE_PROXY_PROVIDER_URLS || '')
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const urls = [...new Set([...configuredSources, ...defaultSources])];
  const candidates = new Set();
  const settled = await Promise.allSettled(urls.map(async url => {
    const text = await fetchText(url);
    const fallbackProtocol = /socks5/i.test(url) ? 'socks5h' : 'http';
    for (const line of text.split(/\r?\n/)) {
      const proxy = parseProxyLine(line, fallbackProtocol);
      if (proxy) candidates.add(proxy);
    }
  }));
  const failures = settled.filter(r => r.status === 'rejected').length;
  return { proxies: [...candidates], sourceCount: urls.length, failures };
}

function loadExisting() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return Array.isArray(parsed.routes) ? parsed.routes : [];
  } catch (_) {
    return [];
  }
}

async function testProxy(proxy) {
  try {
    const args = [
      '--silent', '--show-error', '--location',
      '--max-time', String(Number(process.env.SOURCE_PROXY_TEST_TIMEOUT_SEC || 8)),
      '--proxy', proxy,
      '--write-out', '\n%{http_code}',
      'https://api.ipify.org?format=json'
    ];
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 256 * 1024, timeout: 10000 });
    const splitAt = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(splitAt + 1));
    const body = stdout.slice(0, splitAt);
    if (status !== 200 || !/"ip"\s*:/.test(body)) throw new Error(`HTTP ${status}`);
    return { ok: true, egress: body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function refreshProxyCache() {
  const maxTest = Number(process.env.SOURCE_PROXY_MAX_TEST || 40);
  const maxSave = Number(process.env.SOURCE_PROXY_MAX_SAVE || 15);
  const existing = loadExisting();
  const permanentlyBlocked = new Set(existing.filter(r => r.blockedPermanently).map(r => r.proxy));
  const { proxies, sourceCount, failures } = await collectCandidates();
  const candidates = proxies.filter(proxy => !permanentlyBlocked.has(proxy)).slice(0, maxTest);

  const valid = [];
  for (const proxy of candidates) {
    const result = await testProxy(proxy);
    if (result.ok) {
      valid.push({
        proxy,
        lastValidatedAt: new Date().toISOString(),
        failureCount: 0,
        blockedUntil: null,
        blockedPermanently: false
      });
      console.log(`[PROXY] valid ${valid.length}/${maxSave}: ${proxy}`);
      if (valid.length >= maxSave) break;
    }
  }

  const merged = [
    ...valid,
    ...existing.filter(route => route.blockedPermanently)
  ];
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    sourceCount,
    failedSources: failures,
    routes: merged
  }, null, 2));
  console.log(`[PROXY] Saved ${valid.length} healthy proxies from ${sourceCount} source lists.`);
  return valid;
}

if (require.main === module) {
  refreshProxyCache().catch(err => {
    console.error(`[PROXY] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { refreshProxyCache, parseProxyLine };
