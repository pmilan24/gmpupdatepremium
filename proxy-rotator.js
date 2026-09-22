// Bounded source requests. Configure real proxy endpoints with SOURCE_PROXY_URLS.
// Fake forwarded-IP headers do not change the outgoing connection's IP address.
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
require('./sources');

function getRandomUserAgent() {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
}

class ProxyRotator {
  constructor() {
    this.health = new Map();
    this.cursor = 0;
    this.proxies = (process.env.SOURCE_PROXY_URLS || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    for (const proxy of this.proxies) {
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(new URL(proxy).protocol)) {
        throw new Error('Unsupported SOURCE_PROXY_URLS protocol');
      }
    }
  }
  isBlacklisted(id) { return (this.health.get(id) || 0) > Date.now(); }
  recordFailure(id) { this.health.set(id, Date.now() + 5 * 60 * 1000); }
  recordSuccess(id) { this.health.delete(id); }

  async fetchWithRotation(targetUrl, options = {}, validator = null) {
    const url = new URL(targetUrl);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid source protocol');
    url.searchParams.set('_t', Date.now());
    const routes = !options.directOnly && this.proxies.length
      ? this.proxies.map((_, i) => {
          const index = (this.cursor + i) % this.proxies.length;
          return { id: `proxy-${index + 1}`, proxy: this.proxies[index] };
        })
      : [{ id: 'direct', proxy: null }];
    // A failure on one domain must not blacklist an independent fallback domain.
    for (const route of routes) route.healthId = `${url.origin}:${route.id}`;
    this.cursor = (this.cursor + 1) % Math.max(1, this.proxies.length);
    for (const route of routes.slice(0, 3)) {
      if (this.isBlacklisted(route.healthId)) continue;
      // curl verifies TLS and enforces a total deadline including body downloads.
      const args = ['--silent', '--show-error', '--location', '--max-redirs', '3',
        '--proto', '=http,https', '--proto-redir', '=http,https',
        '--max-time', String((options.timeoutMs || 20000) / 1000),
        '--user-agent', getRandomUserAgent(), '--header', 'Cache-Control: no-cache',
        '--write-out', '\n%{http_code}'];
      if (route.proxy) args.push('--proxy', route.proxy);
      for (const [key, value] of Object.entries(options.headers || {})) args.push('--header', `${key}: ${value}`);
      args.push(url.toString());
      let output;
      try {
        output = (await execFileAsync('curl', args, { maxBuffer: 10 * 1024 * 1024,
          timeout: (options.timeoutMs || 20000) + 2000 })).stdout;
      } catch (_) {
        this.recordFailure(route.healthId);
        console.warn(`[SOURCE] ${route.id}: network request failed (details redacted)`);
        continue;
      }
      const boundary = output.lastIndexOf('\n');
      const status = Number(output.slice(boundary + 1));
      const text = output.slice(0, boundary);
      if (status === 429 || status === 403) {
        // Do not rotate around an explicit rate limit or denied access.
        for (const entry of routes) this.recordFailure(entry.healthId);
        throw new Error(`Source HTTP ${status}; requests paused for this cycle`);
      }
      if (status < 200 || status >= 300 || !text || (validator && !validator(text))) {
        this.recordFailure(route.healthId);
        console.warn(`[SOURCE] ${route.id}: HTTP ${status} or invalid source content`);
        continue;
      }
      this.recordSuccess(route.healthId);
      return { text, strategy: route.id };
    }
    throw new Error('No healthy source route succeeded; retry after cooldown');
  }
}
module.exports = { ProxyRotator, proxyRotator: new ProxyRotator(), getRandomUserAgent };
