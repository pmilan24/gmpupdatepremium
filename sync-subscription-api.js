// sync-subscription-api.js - Automated Subscription Data Sync to Backend API & GitHub Pages
// Fully automated with Indian Time (IST) schedule:
// - 09:55 AM to 05:00 PM IST: 1-minute live sync
// - 05:00 PM to 06:00 PM IST: 10-minute closing tally
// - After 06:00 PM IST & Weekends: Sleeps until next market session
// No browser or website opening required.

const fs = require('fs');
const path = require('path');
const SOURCES = require('./sources');
const { fetchLiveSubscription } = require('./fetch-subscription');
const { getBearerToken } = require('./auth-manager');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  } catch (e) {}
}

// Parse CLI flags
const args = process.argv.slice(2);
const IS_FORCE = args.includes('--force');
const RUN_ONCE = args.includes('--once');
const IS_VERBOSE = args.includes('--verbose') || process.env.DEBUG === 'true';

const rawIpoListUrl = (SOURCES.BACKEND_IPO_LIST_URL || process.env.BACKEND_IPO_LIST_URL || '').trim();
const rawUpdateSubUrl = (SOURCES.BACKEND_UPDATE_SUB_URL || process.env.BACKEND_UPDATE_SUB_URL || '').trim();

// --- Configuration ---
const CONFIG = {
  IPO_LIST_URL: rawIpoListUrl ? (rawIpoListUrl.endsWith('/') || rawIpoListUrl.includes('?') ? rawIpoListUrl : `${rawIpoListUrl}/`) : '',
  UPDATE_SUB_URL: rawUpdateSubUrl.replace(/\/+$/, ''),
  AUTH_TOKEN: SOURCES.BACKEND_API_TOKEN || process.env.BACKEND_API_TOKEN || '',
  AUTH_HEADER_NAME: process.env.BACKEND_AUTH_HEADER || 'Authorization',
  IPO_LIST_CACHE_TTL_MS: 15 * 60 * 1000,
  LOG_FILE: path.join(__dirname, 'subscription-sync.log'),
  SNAPSHOT_FILE: path.join(__dirname, 'subscription-data.json')
};

const tokenArgIndex = args.indexOf('--token');
if (tokenArgIndex !== -1 && args[tokenArgIndex + 1]) {
  CONFIG.AUTH_TOKEN = args[tokenArgIndex + 1].trim();
}

// --- Logging Utilities (Clean, Compact, Auto-Pruned) ---
function log(msg, level = 'INFO') {
  const istStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date());

  const consoleMsg = `[${istStr} IST] [${level}] ${msg}`;
  console.log(consoleMsg);

  try {
    fs.appendFileSync(CONFIG.LOG_FILE, consoleMsg + '\n', 'utf8');

    // Keep log file bounded to last 200 lines to prevent disk bloat
    if (Math.random() < 0.05) {
      pruneLogFile();
    }
  } catch (e) {}
}

function pruneLogFile() {
  try {
    if (fs.existsSync(CONFIG.LOG_FILE)) {
      const content = fs.readFileSync(CONFIG.LOG_FILE, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      if (lines.length > 250) {
        const kept = lines.slice(-200);
        fs.writeFileSync(CONFIG.LOG_FILE, kept.join('\n') + '\n', 'utf8');
      }
    }
  } catch (e) {}
}

function compactApiResponse(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function responseIndicatesSuccess(json) {
  if (!json || typeof json !== 'object' || !json.meta) return true;
  if (json.meta.status === false) return false;
  if (Number(json.meta.status_code) >= 400) return false;
  return true;
}

// --- Adaptive Indian Time (IST) Schedule Checker ---
function getMarketScheduleStatus(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(now);

  let day = '';
  let hour = 0;
  let minute = 0;

  for (const p of parts) {
    if (p.type === 'weekday') day = p.value;
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }

  // Weekends (Saturday & Sunday): Market closed
  if (['Sat', 'Sun'].includes(day)) {
    return {
      open: false,
      intervalSec: 15 * 60, // Check every 15m on weekends
      reason: `Weekend (${day}) - Market closed`
    };
  }

  const currentMinutes = hour * 60 + minute;
  const startMinutes = 9 * 60 + 55; // 09:55 AM IST
  const peakEndMinutes = 17 * 60;   // 05:00 PM IST
  const closeMinutes = 18 * 60;     // 06:00 PM IST

  // Pre-market (Before 09:55 AM IST)
  if (currentMinutes < startMinutes) {
    return {
      open: false,
      intervalSec: 5 * 60,
      reason: `Pre-market (Opens at 09:55 AM IST, current: ${hour}:${String(minute).padStart(2, '0')})`
    };
  }

  // Post-market (After 06:00 PM IST)
  if (currentMinutes > closeMinutes) {
    return {
      open: false,
      intervalSec: 15 * 60,
      reason: `Post-market (Closed at 06:00 PM IST, current: ${hour}:${String(minute).padStart(2, '0')})`
    };
  }

  // Active Bidding Session (09:55 AM - 05:00 PM IST): 1-minute interval
  if (currentMinutes <= peakEndMinutes) {
    return {
      open: true,
      phase: 'LIVE_TRADING',
      intervalSec: 60, // 1 minute
      reason: 'Active Bidding Session (09:55 AM - 05:00 PM IST) [Cadence: 1 min]'
    };
  }

  // Final Tally & Closing Window (05:00 PM - 06:00 PM IST): 10-minute interval
  return {
    open: true,
    phase: 'CLOSING_TALLY',
    intervalSec: 10 * 60, // 10 minutes
    reason: 'Final Closing Tally (05:00 PM - 06:00 PM IST) [Cadence: 10 min]'
  };
}

// --- Multi-Proxy Scraper ---
async function fetchSubscriptionWithProxyRotation() {
  try {
    const companies = await fetchLiveSubscription();
    if (companies && companies.length > 0) {
      return companies;
    }
  } catch (err) {
    log(`[PROXY] ❌ Scrape error: ${err.message}`, 'WARN');
  }
  return [];
}

// --- Backend IPO List Cache ---
let cachedIpoList = null;
let lastIpoListFetchTime = 0;

async function getBackendIpoList(activeToken) {
  if (!CONFIG.IPO_LIST_URL) {
    log('[API] ⚠️ BACKEND_IPO_LIST_URL not configured. Check GitHub Secrets or .env.', 'WARN');
    return cachedIpoList || [];
  }

  const now = Date.now();
  if (cachedIpoList && (now - lastIpoListFetchTime < CONFIG.IPO_LIST_CACHE_TTL_MS)) {
    return cachedIpoList;
  }

  try {
    const headers = {
      'Accept': 'application/json',
      'ngrok-skip-browser-warning': 'true'
    };
    const token = activeToken || CONFIG.AUTH_TOKEN;
    if (token) {
      headers[CONFIG.AUTH_HEADER_NAME] = token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
    }

    const res = await fetch(CONFIG.IPO_LIST_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      log(`[API] ❌ Failed to fetch backend IPO list: HTTP ${res.status}`, 'WARN');
      return cachedIpoList || [];
    }

    const json = await res.json();
    if (json && json.data && Array.isArray(json.data)) {
      cachedIpoList = json.data;
      lastIpoListFetchTime = now;
      return cachedIpoList;
    }
  } catch (err) {
    log(`[API] ❌ Backend IPO list error: ${err.message}`, 'WARN');
  }

  return cachedIpoList || [];
}

// --- Smart, Resilient IPO Matching Engine ---
function normalizeStr(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getTokenWords(str) {
  if (!str) return [];
  const noise = new Set([
    'limited', 'ltd', 'private', 'pvt', 'india', 'solutions', 'solution',
    'services', 'service', 'technologies', 'technology', 'tech', 'enterprises',
    'enterprise', 'industries', 'industry', 'international', 'infra',
    'infrastructure', 'holdings', 'holding', 'corporation', 'corp', 'group',
    'company', 'co', 'mainboard', 'sme', 'nse', 'bse', 'ipo', 'issue', 'ventures'
  ]);

  const raw = str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);

  const filtered = raw.filter(w => !noise.has(w));
  return filtered.length > 0 ? filtered : raw;
}

function calculateSimilarity(str1, str2) {
  const norm1 = normalizeStr(str1);
  const norm2 = normalizeStr(str2);
  if (norm1 && norm2 && (norm1 === norm2)) {
    return 0.95;
  }

  const words1 = getTokenWords(str1);
  const words2 = getTokenWords(str2);
  if (words1.length === 0 || words2.length === 0) return 0;

  let common = 0;
  for (const w1 of words1) {
    if (words2.some(w2 => w1 === w2)) {
      common++;
    }
  }
  return (2 * common) / (words1.length + words2.length);
}

function findMatchingIpo(scrapedCompany, backendIpoList) {
  const scrapedName = scrapedCompany.companyName || '';
  if (!scrapedName || scrapedName.length < 3) return null;

  const scrapedWords = getTokenWords(scrapedName);
  const normScraped = normalizeStr(scrapedName);

  let bestMatch = null;
  let highestScore = 0;

  for (const ipo of backendIpoList) {
    const backendName = ipo.company_name || ipo.name || ipo.title || '';
    const backendSymbol = (ipo.symbol || '').toLowerCase().trim();
    const normBackend = normalizeStr(backendName);

    // 1. Exact normalized name match
    if (normScraped && normBackend && normScraped === normBackend) {
      return ipo;
    }

    // 2. Exact word boundary symbol match (e.g. word "anand" matches symbol "ANAND", but not "vivekanand")
    if (backendSymbol && scrapedWords.some(w => w === backendSymbol)) {
      return ipo;
    }

    // 3. Token overlap & substring similarity
    const score = calculateSimilarity(scrapedName, backendName);
    if (score > highestScore && score >= 0.55) {
      highestScore = score;
      bestMatch = ipo;
    }
  }

  return bestMatch;
}

// Map category strings for Subscription Details (No. of Shares)
function mapCategorySub(raw) {
  if (!raw) return null;
  const c = raw.trim();
  if (/^total$/i.test(c)) return null; // Exclude Total
  if (/^qib/i.test(c)) return 'QIBs';
  if (/^(hnis?\s*10\+|bhni|b-hni)/i.test(c)) return 'HNIs 10+';
  if (/^(hnis?\s*2\+|shni|s-hni)/i.test(c)) return 'HNIs 2+';
  if (/^hnis?$/i.test(c)) return 'HNIs';
  if (/^(retail|individual|rii)/i.test(c)) return 'Retail';
  if (/^employee/i.test(c)) return 'Employees';
  return null;
}

// Map category strings for Application-Wise Breakup
function mapCategoryApp(raw) {
  if (!raw) return null;
  const c = raw.trim();
  if (/^total$/i.test(c)) return null; // Exclude Total
  if (/10l\+/i.test(c)) return 'HNIs (10L+)';
  if (/(2-10l|3-10l)/i.test(c)) return 'HNIs (2-10L)';
  if (/^(retail|individual|rii)/i.test(c)) return 'Retail';
  if (/^employee/i.test(c)) return 'Employee';
  return null;
}

function formatPayloadForBackend(company) {
  const subscription = [];
  if (Array.isArray(company.sharesBreakup)) {
    for (const item of company.sharesBreakup) {
      const catName = mapCategorySub(item.category);
      if (catName) {
        subscription.push({
          Category: catName,
          Offered: parseInt(item.offered, 10) || 0,
          Applied: parseInt(item.applied, 10) || 0
        });
      }
    }
  }

  const application_wise_breakup = [];
  if (Array.isArray(company.applicationsBreakup)) {
    for (const item of company.applicationsBreakup) {
      const catName = mapCategoryApp(item.category);
      if (catName) {
        application_wise_breakup.push({
          Category: catName,
          Reserved: parseInt(item.reserved, 10) || 0,
          Applied: parseInt(item.applied, 10) || 0
        });
      }
    }
  }

  return { subscription, application_wise_breakup };
}

// --- Send PUT Update to Backend API ---
async function pushSubscriptionUpdate(symbol, payload, activeToken) {
  if (!CONFIG.UPDATE_SUB_URL) {
    return { success: false, error: 'BACKEND_UPDATE_SUB_URL not configured' };
  }
  const url = `${CONFIG.UPDATE_SUB_URL.replace(/\/+$/, '')}/${encodeURIComponent(symbol)}/`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'ngrok-skip-browser-warning': 'true'
  };

  const token = activeToken || CONFIG.AUTH_TOKEN;
  if (token) {
    headers[CONFIG.AUTH_HEADER_NAME] = token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000)
    });

    const responseText = await res.text();
    let json = null;
    try {
      json = JSON.parse(responseText);
    } catch (e) {}

    const apiAccepted = responseIndicatesSuccess(json);

    if (res.ok && apiAccepted) {
      return { success: true, status: res.status, data: json, responseText,
        message: json?.meta?.message || json?.message || responseText };
    } else {
      const apiStatus = json?.meta?.status_code ? `API ${json.meta.status_code}` : `HTTP ${res.status}`;
      const apiMessage = json?.meta?.validations?.[0]?.error?.[0] || json?.meta?.message || json?.message || responseText;
      return { success: false, status: res.status, apiStatus, data: json, responseText, error: apiMessage };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- Main Execution Cycle ---
async function runSyncCycle() {
  // 1. Fetch fresh subscription data via proxy rotation
  const companies = await fetchSubscriptionWithProxyRotation();
  if (!companies || companies.length === 0) {
    throw new Error('No valid subscription data scraped; previous snapshot preserved.');
  }

  // 2. Save the validated snapshot; the workflow owns commits and deployment.
  try {
    const result = {
      lastUpdated: new Date().toISOString(),
      count: companies.length,
      companies
    };
    fs.writeFileSync(CONFIG.SNAPSHOT_FILE, JSON.stringify(result, null, 2));

  } catch (e) {
    throw new Error(`Snapshot write failed: ${e.message}`);
  }

  // 3. Resolve active Bearer token dynamically
  let activeToken = CONFIG.AUTH_TOKEN;
  if (!activeToken || (SOURCES.AUTH_EMAIL && SOURCES.AUTH_PASSWORD)) {
    try {
      activeToken = await getBearerToken();
    } catch (err) {
      throw new Error(`Authentication failed: ${err.message}`);
    }
  }

  // 4. Get backend IPO list
  const backendIpos = await getBackendIpoList(activeToken);
  if (!backendIpos || backendIpos.length === 0) {
    throw new Error('Backend IPO list is empty or unavailable; no updates sent.');
  }

  // 5. Match companies and send PUT requests
  let pushedCount = 0;
  let failedCount = 0;

  for (const comp of companies) {
    const matchedIpo = findMatchingIpo(comp, backendIpos);
    if (!matchedIpo) {
      log(`[MATCH] No safe backend match for ${comp.companyName}`, 'WARN');
      continue;
    }

    const symbol = matchedIpo.symbol;
    const payload = formatPayloadForBackend(comp);
    if (!symbol || !payload.subscription.length) { failedCount++; continue; }

    if (IS_VERBOSE) {
      log(`[MATCH] "${comp.companyName}" -> [${symbol}]`, 'DEBUG');
      log(`[PAYLOAD] ${JSON.stringify(payload)}`, 'DEBUG');
    }

    if (!activeToken) {
      failedCount++;
      log(`[AUTH] No active token for [${symbol}]. Skipping PUT.`, 'WARN');
      continue;
    }

    let result = await pushSubscriptionUpdate(symbol, payload, activeToken);
    if (result.status === 401 && SOURCES.AUTH_EMAIL && SOURCES.AUTH_PASSWORD) {
      activeToken = await getBearerToken(true);
      result = await pushSubscriptionUpdate(symbol, payload, activeToken);
    }
    if (result.success) {
      pushedCount++;
      const subTimes = comp.summary?.totalTimes || 0;
      const retailTimes = comp.summary?.retailTimes || 0;
      const hniTimes = comp.summary?.hniTimes || 0;
      log(`[SYNC] ✅ [${symbol}] "${comp.companyName}" -> Subscribed: ${subTimes}x (Retail: ${retailTimes}x, HNIs: ${hniTimes}x) | PUT ${CONFIG.UPDATE_SUB_URL}/${symbol}/ | HTTP ${result.status}`, 'SUCCESS');
      log(`[API RESPONSE] [${symbol}] ${compactApiResponse(result.data || result.responseText || result.message || {})}`, 'INFO');
    } else {
      failedCount++;
      log(`[SYNC] ❌ [${symbol}] Update Failed: PUT ${CONFIG.UPDATE_SUB_URL}/${symbol}/ | HTTP ${result.status} ${result.apiStatus || ''} | ${compactApiResponse(result.data || result.error)}`, 'WARN');
    }

    await new Promise(r => setTimeout(r, 400));
  }

  if (pushedCount === 0) {
    throw new Error(`Scraped ${companies.length} IPOs, but no backend updates succeeded.`);
  }
  if (failedCount) throw new Error(`${failedCount} backend updates failed; ${pushedCount} succeeded.`);
  return { scraped: companies.length, updated: pushedCount };
}

// Share concurrent server requests instead of running duplicate update cycles.
let activeCycle;
function runSingleSyncCycle() {
  if (!activeCycle) activeCycle = runSyncCycle().finally(() => { activeCycle = null; });
  return activeCycle;
}

// --- Automated Scheduler Loop ---
async function startDaemon() {
  log('🤖 Starting Automated Subscription Sync Daemon (Mon-Fri IST)', 'INFO');

  async function nextLoop() {
    let nextWaitSec = 60;
    try {
      const schedule = getMarketScheduleStatus();
      nextWaitSec = schedule.intervalSec;

      if (!IS_FORCE && !schedule.open) {
        log(`[SCHEDULE] ⏸️ ${schedule.reason}. Sleeping for ${Math.round(nextWaitSec / 60)} min.`, 'INFO');
      } else {
        await runSingleSyncCycle();
      }
    } catch (err) {
      log(`[DAEMON] Error: ${err.message}`, 'ERROR');
      if (RUN_ONCE) process.exitCode = 1;
    }

    if (RUN_ONCE) {
      log('Single run complete (--once flag). Exiting.', 'INFO');
      return;
    }

    setTimeout(nextLoop, nextWaitSec * 1000);
  }

  await nextLoop();
}

if (require.main === module) {
  startDaemon();
}

module.exports = {
  runSyncCycle: runSingleSyncCycle,
  formatPayloadForBackend,
  findMatchingIpo,
  getMarketScheduleStatus
};
