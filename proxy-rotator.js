// proxy-rotator.js - Smart Proxy & IP Rotation with Failure Blacklisting
// Used by both GMP scraper and Subscription data scraper

const fs = require('fs');
const path = require('path');

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

// In-memory health and blacklist state
const proxyHealth = new Map();
const BLACKLIST_DURATION_MS = 15 * 60 * 1000; // 15 minutes blacklist for failed proxies

class ProxyRotator {
  constructor() {
    this.strategies = [];
    this.initStrategies();
  }

  initStrategies() {
    // Strategy definitions
    this.strategies = [
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
        }
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
        }
      },
      {
        id: 'jina-clean',
        name: 'Jina Edge Proxy (Standard)',
        type: 'proxy',
        buildUrl: (targetUrl) => `https://r.jina.ai/${targetUrl}?_t=${Date.now()}`,
        buildHeaders: () => ({
          'Accept': 'text/plain,text/html',
          'x-no-cache': 'true',
          'User-Agent': getRandomUserAgent()
        })
      },
      {
        id: 'jina-mirror',
        name: 'Jina Edge Proxy (Uncached Raw)',
        type: 'proxy',
        buildUrl: (targetUrl) => `https://r.jina.ai/${targetUrl}`,
        buildHeaders: () => ({
          'Accept': 'text/plain',
          'x-no-cache': 'true'
        })
      },
      {
        id: 'allorigins-edge',
        name: 'AllOrigins Edge Proxy',
        type: 'proxy',
        buildUrl: (targetUrl) => `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
        buildHeaders: () => ({
          'User-Agent': getRandomUserAgent(),
          'Accept': '*/*'
        })
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
    if (health.blacklistedUntil > Date.now()) {
      return true;
    }
    return false;
  }

  recordFailure(strategyId, errorMsg) {
    const health = proxyHealth.get(strategyId) || { failCount: 0, blacklistedUntil: 0, successCount: 0 };
    health.failCount += 1;
    health.lastError = errorMsg;
    // Blacklist on failure
    health.blacklistedUntil = Date.now() + BLACKLIST_DURATION_MS;
    proxyHealth.set(strategyId, health);
    console.warn(`[PROXY-ROTATOR] ❌ Strategy "${strategyId}" failed (${errorMsg}). Blacklisted for 15 mins.`);
  }

  recordSuccess(strategyId) {
    const health = proxyHealth.get(strategyId) || { failCount: 0, blacklistedUntil: 0, successCount: 0 };
    health.failCount = 0;
    health.blacklistedUntil = 0;
    health.successCount += 1;
    health.lastError = null;
    proxyHealth.set(strategyId, health);
  }

  getAvailableStrategies() {
    const now = Date.now();
    const available = this.strategies.filter(s => !this.isBlacklisted(s.id));

    if (available.length === 0) {
      console.warn('[PROXY-ROTATOR] ⚠️ All proxy strategies were blacklisted. Auto-clearing oldest blacklist to maintain service.');
      // Find strategy with earliest expiry
      let oldest = this.strategies[0];
      let minExpiry = Infinity;
      for (const s of this.strategies) {
        const h = proxyHealth.get(s.id);
        if (h && h.blacklistedUntil < minExpiry) {
          minExpiry = h.blacklistedUntil;
          oldest = s;
        }
      }
      const h = proxyHealth.get(oldest.id);
      if (h) h.blacklistedUntil = 0;
      return [oldest];
    }

    return available;
  }

  async fetchWithRotation(targetUrl, options = {}, validator = null) {
    const available = this.getAvailableStrategies();
    const totalCount = this.strategies.length;
    const blacklistedCount = totalCount - available.length;

    console.log(`[PROXY-ROTATOR] Starting fetch for target: ${targetUrl.substring(0, 60)}...`);
    console.log(`[PROXY-ROTATOR] Healthy proxies: ${available.length}/${totalCount} | Blacklisted: ${blacklistedCount}`);

    let lastError = null;

    for (let i = 0; i < available.length; i++) {
      const strategy = available[i];
      const fetchUrl = strategy.buildUrl(targetUrl);
      const headers = { ...strategy.buildHeaders(), ...(options.headers || {}) };
      const timeoutMs = options.timeoutMs || 12000;

      console.log(`[PROXY-ROTATOR] [Attempt ${i + 1}/${available.length}] Trying strategy: "${strategy.name}"...`);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(fetchUrl, {
          method: options.method || 'GET',
          headers,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        const text = await res.text();
        if (!text || text.length < 200) {
          throw new Error(`Empty or truncated response (${text ? text.length : 0} bytes)`);
        }

        // Run custom validator if provided
        if (typeof validator === 'function') {
          const valid = validator(text, res);
          if (!valid) {
            throw new Error('Response validation failed (unexpected format or 0 items parsed)');
          }
        }

        // Success!
        this.recordSuccess(strategy.id);
        console.log(`[PROXY-ROTATOR] ✅ Success with "${strategy.name}"! Received ${text.length} bytes.`);
        return { text, response: res, strategy: strategy.name };

      } catch (err) {
        lastError = err;
        this.recordFailure(strategy.id, err.message);
      }

      // Small pause before trying next proxy
      if (i < available.length - 1) {
        await new Promise(r => setTimeout(r, 600));
      }
    }

    throw new Error(`All available proxies failed. Last error: ${lastError ? lastError.message : 'Unknown'}`);
  }
}

const rotatorInstance = new ProxyRotator();

module.exports = {
  ProxyRotator,
  proxyRotator: rotatorInstance,
  getRandomUserAgent,
  getRandomPublicIp
};
