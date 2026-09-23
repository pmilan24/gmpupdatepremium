// Bounded source requests. Configure real proxy endpoints with SOURCE_PROXY_URLS
// or refresh cache/source-proxies.json with manage-source-proxies.js.
// Fake forwarded-IP headers do not change the outgoing connection's IP address.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
require('./sources');

const BASE_DIR = typeof __dirname !== 'undefined'
  ? __dirname
  : (typeof process !== 'undefined' && process.cwd ? process.cwd() : '.');
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const PROXY_CACHE_FILE = path.join(CACHE_DIR, 'source-proxies.json');
const DEFAULT_BLOCK_MS = 30 * 60 * 1000;
const PERMANENT_BLOCK_AFTER = 3;
let cacheBustCounter = 0;

function getRandomUserAgent() {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
}

class ProxyRotator {
  constructor() {
    this.health = new Map();
    this.failureCounts = new Map();
    this.permanentBlocks = new Set();
    this.cursor = 0;
    this.proxies = this.loadProxies();
    for (const proxy of this.proxies) {
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(new URL(proxy).protocol)) {
        throw new Error('Unsupported SOURCE_PROXY_URLS protocol');
      }
    }
  }

  loadProxies() {
    const configured = (process.env.SOURCE_PROXY_URLS || '')
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const cached = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(PROXY_CACHE_FILE, 'utf8'));
      for (const route of parsed.routes || []) {
        if (route && route.proxy && !route.blockedPermanently) cached.push(route.proxy);
        if (route && route.proxy && route.blockedPermanently) this.permanentBlocks.add(route.proxy);
      }
    } catch (_) {}
    return [...new Set([...configured, ...cached])].filter(proxy => !this.permanentBlocks.has(proxy));
  }

  isBlacklisted(id) { return (this.health.get(id) || 0) > Date.now(); }
  persistProxyHealth(proxy, patch) {
    if (!proxy) return;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      let parsed = { routes: [] };
      try { parsed = JSON.parse(fs.readFileSync(PROXY_CACHE_FILE, 'utf8')); } catch (_) {}
      const routes = Array.isArray(parsed.routes) ? parsed.routes : [];
      const found = routes.find(route => route.proxy === proxy);
      if (found) Object.assign(found, patch);
      else routes.push({ proxy, ...patch });
      fs.writeFileSync(PROXY_CACHE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), routes }, null, 2));
    } catch (_) {}
  }
  recordFailure(route, reason = 'network') {
    this.health.set(route.healthId, Date.now() + DEFAULT_BLOCK_MS);
    if (route.proxy) {
      const count = (this.failureCounts.get(route.proxy) || 0) + 1;
      this.failureCounts.set(route.proxy, count);
      const permanentlyBlocked = reason === 'blocked' || count >= PERMANENT_BLOCK_AFTER;
      if (permanentlyBlocked) this.permanentBlocks.add(route.proxy);
      this.persistProxyHealth(route.proxy, {
        lastFailureAt: new Date().toISOString(),
        lastFailureReason: reason,
        failureCount: count,
        blockedUntil: new Date(Date.now() + DEFAULT_BLOCK_MS).toISOString(),
        blockedPermanently: permanentlyBlocked
      });
    }
  }
  recordSuccess(route) {
    this.health.delete(route.healthId);
    if (route.proxy) {
      this.failureCounts.delete(route.proxy);
      this.persistProxyHealth(route.proxy, {
        lastSuccessAt: new Date().toISOString(),
        lastFailureReason: null,
        failureCount: 0,
        blockedUntil: null,
        blockedPermanently: false
      });
    }
  }

  async fetchWithRotation(targetUrl, options = {}, validator = null) {
    const url = new URL(targetUrl);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid source protocol');
    const bust = `${Date.now()}-${process.pid || 0}-${++cacheBustCounter}`;
    url.searchParams.set('_t', bust);
    url.searchParams.set('_cb', bust);
    this.proxies = this.loadProxies();
    const directFallback = options.directFallback !== false;
    const routes = !options.directOnly && this.proxies.length
      ? this.proxies.map((_, i) => {
          const index = (this.cursor + i) % this.proxies.length;
          return { id: `proxy-${index + 1}`, proxy: this.proxies[index] };
        })
      : [{ id: 'direct', proxy: null }];
    if (!options.directOnly && this.proxies.length && directFallback) routes.push({ id: 'direct', proxy: null });
    // A failure on one domain must not blacklist an independent fallback domain.
    for (const route of routes) route.healthId = `${url.origin}:${route.id}`;
    this.cursor = (this.cursor + 1) % Math.max(1, this.proxies.length);
    const maxAttempts = Math.max(1, Number(process.env.SOURCE_PROXY_ATTEMPTS || options.maxAttempts || 5));
    for (const route of routes.slice(0, maxAttempts)) {
      if (this.isBlacklisted(route.healthId)) continue;
      // curl verifies TLS and enforces a total deadline including body downloads.
      const args = ['--silent', '--show-error', '--location', '--max-redirs', '3',
        '--proto', '=http,https', '--proto-redir', '=http,https',
        '--max-time', String((options.timeoutMs || 20000) / 1000),
        '--user-agent', getRandomUserAgent(),
        '--header', 'Cache-Control: no-cache, no-store, max-age=0',
        '--header', 'Pragma: no-cache',
        '--header', 'Expires: 0',
        '--write-out', '\n%{http_code}'];
      if (route.proxy) args.push('--proxy', route.proxy);
      for (const [key, value] of Object.entries(options.headers || {})) args.push('--header', `${key}: ${value}`);
      args.push(url.toString());
      let output;
      try {
        output = (await execFileAsync('curl', args, { maxBuffer: 10 * 1024 * 1024,
          timeout: (options.timeoutMs || 20000) + 2000 })).stdout;
      } catch (_) {
        this.recordFailure(route, 'network');
        console.warn(`[SOURCE] ${route.id}: network request failed (details redacted)`);
        continue;
      }
      const boundary = output.lastIndexOf('\n');
      const status = Number(output.slice(boundary + 1));
      const text = output.slice(0, boundary);
      if (status === 429 || status === 403) {
        this.recordFailure(route, 'blocked');
        console.warn(`[SOURCE] ${route.id}: HTTP ${status}; route blocked and removed from rotation`);
        continue;
      }
      if (status < 200 || status >= 300 || !text || (validator && !validator(text))) {
        this.recordFailure(route, 'invalid');
        console.warn(`[SOURCE] ${route.id}: HTTP ${status} or invalid source content`);
        continue;
      }
      this.recordSuccess(route);
      return { text, strategy: route.id };
    }
    throw new Error('No healthy source route succeeded; retry after cooldown');
  }
}
module.exports = { ProxyRotator, proxyRotator: new ProxyRotator(), getRandomUserAgent };
