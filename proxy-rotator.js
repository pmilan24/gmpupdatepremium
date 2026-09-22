// proxy-rotator.js - Smart Proxy & IP Rotation with Failure Blacklisting
// Used by both GMP scraper and Subscription data scraper

const https = require('https');
const http = require('http');

// Diverse pool of User-Agents across iOS, Mac, Windows, Android
const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.52 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Generate realistic rotating public IP addresses for headers
function getRandomPublicIp() {
  // Indian ISP IP ranges (Airtel, Jio, ACT, Vodafone)
  const subnets = [
    [103, Math.floor(Math.random() * 255)],
    [49, Math.floor(Math.random() * 64) + 32],
    [106, Math.floor(Math.random() * 64) + 192],
    [157, Math.floor(Math.random() * 64) + 32],
    [122, Math.floor(Math.random() * 64) + 160]
  ];
  const prefix = subnets[Math.floor(Math.random() * subnets.length)];
  return `${prefix[0]}.${prefix[1]}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
}

// --- Native HTTPS GET helper (bypasses fetch() issues in some CI/Node environments) ---
function nativeHttpsGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Native fetch timeout after ${timeoutMs}ms`));
    }, timeoutMs || 20000);

    try {
      const urlObj = new URL(url);
      const lib = urlObj.protocol === 'http:' ? http : https;
      const req = lib.request({
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: headers || {},
        timeout: timeoutMs || 20000,
        rejectUnauthorized: false // some proxies need this
      }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timeoutId);
          let redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith('http')) {
            redirectUrl = new URL(redirectUrl, url).toString();
          }
          return nativeHttpsGet(redirectUrl, headers, timeoutMs).then(resolve).catch(reject);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          clearTimeout(timeoutId);
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }

        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timeoutId);
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });
        res.on('error', err => { clearTimeout(timeoutId); reject(err); });
      });

      req.on('error', err => { clearTimeout(timeoutId); reject(err); });
      req.on('timeout', () => { clearTimeout(timeoutId); req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    } catch (e) {
      clearTimeout(timeoutId);
      reject(e);
    }
  });
}

// In-memory health and blacklist state
const proxyHealth = new Map();
const BLACKLIST_DURATION_MS = 5 * 60 * 1000; // 5 minutes (was 15 — shorter so GH Actions re-tries quickly)

class ProxyRotator {
  constructor() {
    this.strategies = [];
    this.initStrategies();
  }

  initStrategies() {
    this.strategies = [
      // --- Direct strategies (native https — most reliable, avoids fetch() quirks) ---
      {
        id: 'native-mobile',
        name: 'Native HTTPS (Mobile UA + Rotating IP)',
        type: 'native',
        buildUrl: (targetUrl) => `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`,
        buildHeaders: () => {
          const ip = getRandomPublicIp();
          return {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-IN,en;q=0.9',
            'X-Forwarded-For': ip,
            'Client-IP': ip,
            'X-Real-IP': ip,
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          };
        },
        useNative: true,
        timeoutMs: 20000
      },
      {
        id: 'native-desktop',
        name: 'Native HTTPS (Desktop UA + Clean Headers)',
        type: 'native',
        buildUrl: (targetUrl) => `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}_nc=${Date.now()}`,
        buildHeaders: () => ({
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-Forwarded-For': getRandomPublicIp(),
          'Cache-Control': 'no-cache'
        }),
        useNative: true,
        timeoutMs: 20000
      },
      // --- fetch()-based direct strategies ---
      {
        id: 'direct-mobile',
        name: 'Direct Primary (Mobile UA + Rotating IP Headers)',
        type: 'direct',
        buildUrl: (targetUrl) => `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`,
        buildHeaders: () => {
          const ip = getRandomPublicIp();
          return {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'X-Forwarded-For': ip,
            'Client-IP': ip,
            'X-Real-IP': ip
          };
        },
        timeoutMs: 20000
      },
      {
        id: 'direct-desktop',
        name: 'Direct Secondary (Desktop UA + Clean Headers)',
        type: 'direct',
        buildUrl: (targetUrl) => `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}_nocache=${Date.now()}`,
        buildHeaders: () => {
          const ip = getRandomPublicIp();
          return {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Forwarded-For': ip
          };
        },
        timeoutMs: 20000
      },
      // --- Proxy-based strategies ---
      {
        id: 'jina-clean',
        name: 'Jina Edge Proxy (Standard)',
        type: 'proxy',
        buildUrl: (targetUrl) => `https://r.jina.ai/${targetUrl}?_t=${Date.now()}`,
        buildHeaders: () => ({
          'Accept': 'text/plain,text/html',
          'x-no-cache': 'true',
          'User-Agent': getRandomUserAgent()
        }),
        timeoutMs: 30000 // Jina needs longer
      },
      {
        id: 'allorigins-edge',
        name: 'AllOrigins Edge Proxy',
        type: 'proxy',
        buildUrl: (targetUrl) => `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}&_t=${Date.now()}`,
        buildHeaders: () => ({
          'User-Agent': getRandomUserAgent(),
          'Accept': '*/*'
        }),
        timeoutMs: 25000
      },
      {
        id: 'corsproxy',
        name: 'CORSProxy.io Edge Proxy',
        type: 'proxy',
        buildUrl: (targetUrl) => `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
        buildHeaders: () => ({
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,*/*'
        }),
        timeoutMs: 25000
      }
    ];

    // Initialize state
    for (const s of this.strategies) {
      if (!proxyHealth.has(s.id)) {
        proxyHealth.set(s.id, {
          failCount: 0,
          blacklistedUntil: 0,
          lastError: null,
          successCount: 0
        });
      }
    }
  }

  isBlacklisted(strategyId) {
    const health = proxyHealth.get(strategyId);
    if (!health) return false;
    return health.blacklistedUntil > Date.now();
  }

  recordFailure(strategyId, errorMsg) {
    const health = proxyHealth.get(strategyId) || { failCount: 0, blacklistedUntil: 0, successCount: 0 };
    health.failCount += 1;
    health.lastError = errorMsg;
    health.blacklistedUntil = Date.now() + BLACKLIST_DURATION_MS;
    proxyHealth.set(strategyId, health);
    console.warn(`[PROXY-ROTATOR] ❌ Strategy "${strategyId}" failed (${errorMsg}). Blacklisted for 5 mins.`);
  }

  recordSuccess(strategyId) {
    const health = proxyHealth.get(strategyId) || { failCount: 0, blacklistedUntil: 0, successCount: 0 };
    health.failCount = 0;
    health.blacklistedUntil = 0;
    health.successCount += 1;
    health.lastError = null;
    proxyHealth.set(strategyId, health);
  }

  clearAllBlacklists() {
    for (const [id, health] of proxyHealth.entries()) {
      health.blacklistedUntil = 0;
    }
    console.warn('[PROXY-ROTATOR] 🔄 Cleared all blacklists for last-resort retry.');
  }

  getAvailableStrategies(forceAll = false) {
    if (forceAll) return this.strategies;

    const available = this.strategies.filter(s => !this.isBlacklisted(s.id));

    if (available.length === 0) {
      console.warn('[PROXY-ROTATOR] ⚠️ All proxy strategies blacklisted. Auto-clearing to maintain service.');
      this.clearAllBlacklists();
      return [...this.strategies]; // return all after clearing
    }

    return available;
  }

  async tryStrategy(strategy, targetUrl, options, validator) {
    const fetchUrl = strategy.buildUrl(targetUrl);
    const headers = { ...strategy.buildHeaders(), ...(options.headers || {}) };
    const timeoutMs = strategy.timeoutMs || options.timeoutMs || 20000;

    let text;

    if (strategy.useNative) {
      // Use native https module (most reliable in CI)
      text = await nativeHttpsGet(fetchUrl, headers, timeoutMs);
    } else {
      // Use global fetch()
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(fetchUrl, {
          method: options.method || 'GET',
          headers,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        text = await res.text();
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (!text || text.length < 200) {
      throw new Error(`Empty or truncated response (${text ? text.length : 0} bytes)`);
    }

    // Run custom validator if provided
    if (typeof validator === 'function') {
      const valid = validator(text);
      if (!valid) {
        throw new Error('Response validation failed (unexpected format or 0 items parsed)');
      }
    }

    return text;
  }

  async fetchWithRotation(targetUrl, options = {}, validator = null) {
    const available = this.getAvailableStrategies();
    const totalCount = this.strategies.length;
    const blacklistedCount = totalCount - available.length;

    console.log(`[PROXY-ROTATOR] Starting fetch for target: ${targetUrl.substring(0, 60)}...`);
    console.log(`[PROXY-ROTATOR] Healthy proxies: ${available.length}/${totalCount} | Blacklisted: ${blacklistedCount}`);

    let lastError = null;

    // First pass: try all available (non-blacklisted) strategies
    for (let i = 0; i < available.length; i++) {
      const strategy = available[i];
      console.log(`[PROXY-ROTATOR] [Attempt ${i + 1}/${available.length}] Trying strategy: "${strategy.name}"...`);

      try {
        const text = await this.tryStrategy(strategy, targetUrl, options, validator);
        this.recordSuccess(strategy.id);
        console.log(`[PROXY-ROTATOR] ✅ Success with "${strategy.name}"! Received ${text.length} bytes.`);
        return { text, strategy: strategy.name };
      } catch (err) {
        lastError = err;
        console.warn(`[PROXY-ROTATOR] ❌ "${strategy.name}" failed: ${err.message}`);
        this.recordFailure(strategy.id, err.message);
      }

      // Small pause before trying next proxy
      if (i < available.length - 1) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    // Second pass: Last-resort — clear all blacklists and retry strategies that weren't in the first pass
    const alreadyTried = new Set(available.map(s => s.id));
    const untried = this.strategies.filter(s => !alreadyTried.has(s.id));

    if (untried.length > 0) {
      console.warn(`[PROXY-ROTATOR] 🔄 Last-resort: trying ${untried.length} blacklisted strategies...`);
      for (let i = 0; i < untried.length; i++) {
        const strategy = untried[i];
        console.log(`[PROXY-ROTATOR] [Last-resort ${i + 1}/${untried.length}] Trying: "${strategy.name}"...`);
        try {
          const text = await this.tryStrategy(strategy, targetUrl, options, validator);
          this.recordSuccess(strategy.id);
          console.log(`[PROXY-ROTATOR] ✅ Last-resort success with "${strategy.name}"! Received ${text.length} bytes.`);
          return { text, strategy: strategy.name + ' (last-resort)' };
        } catch (err) {
          lastError = err;
          console.warn(`[PROXY-ROTATOR] ❌ Last-resort "${strategy.name}" failed: ${err.message}`);
          this.recordFailure(strategy.id, err.message);
        }
        if (i < untried.length - 1) {
          await new Promise(r => setTimeout(r, 400));
        }
      }
    }

    throw new Error(`All ${this.strategies.length} proxy strategies failed. Last error: ${lastError ? lastError.message : 'Unknown'}`);
  }
}

const rotatorInstance = new ProxyRotator();

module.exports = {
  ProxyRotator,
  proxyRotator: rotatorInstance,
  getRandomUserAgent,
  getRandomPublicIp
};
