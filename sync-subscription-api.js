// sync-subscription-api.js - Automated Subscription Data Sync to Backend API
// Runs Monday - Friday between 9:55 AM and 6:00 PM IST every 1-2 minutes.
// Supports multi-proxy scraping, symbol matching, and verbose test logging.

const fs = require('fs');
const path = require('path');
const SOURCES = require('./sources');
const { parseHtmlSubscription, fetchLiveSubscription } = require('./fetch-subscription');
const { proxyRotator } = require('./proxy-rotator');
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

// --- Configuration ---
const rawIpoListUrl = (SOURCES.BACKEND_IPO_LIST_URL || process.env.BACKEND_IPO_LIST_URL || '').trim();
const rawUpdateSubUrl = (SOURCES.BACKEND_UPDATE_SUB_URL || process.env.BACKEND_UPDATE_SUB_URL || '').trim();

const CONFIG = {
  // Backend endpoints - strictly from SOURCES / env
  IPO_LIST_URL: rawIpoListUrl ? (rawIpoListUrl.endsWith('/') || rawIpoListUrl.includes('?') ? rawIpoListUrl : `${rawIpoListUrl}/`) : '',
  UPDATE_SUB_URL: rawUpdateSubUrl.replace(/\/+$/, ''),
  
  // Auth Token (override via .env BACKEND_API_TOKEN or CLI --token, otherwise dynamically fetched)
  AUTH_TOKEN: SOURCES.BACKEND_API_TOKEN || process.env.BACKEND_API_TOKEN || '',
  AUTH_HEADER_NAME: process.env.BACKEND_AUTH_HEADER || 'Authorization',
  
  // Schedule (IST = UTC + 5:30)
  START_HOUR: 9,
  START_MINUTE: 55,
  END_HOUR: 18,
  END_MINUTE: 0,
  POLL_INTERVAL_SEC: parseInt(process.env.POLL_INTERVAL_SEC, 10) || 60, // 1 minute default
  IPO_LIST_CACHE_TTL_MS: 15 * 60 * 1000, // Refresh backend IPO list every 15 mins
  
  // Logging
  LOG_FILE: path.join(__dirname, 'subscription-sync.log'),
  SNAPSHOT_FILE: path.join(__dirname, 'subscription-data.json')
};

// Parse CLI flags
const args = process.argv.slice(2);
const IS_FORCE = args.includes('--force');
const RUN_ONCE = args.includes('--once');
const tokenArgIndex = args.indexOf('--token');
if (tokenArgIndex !== -1 && args[tokenArgIndex + 1]) {
  CONFIG.AUTH_TOKEN = args[tokenArgIndex + 1].trim();
}

// User-Agent Pool for proxy rotation
const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// --- Logging Utilities ---
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

  const prefix = `[${istStr} IST] [${level}]`;
  const consoleMsg = `${prefix} ${msg}`;
  console.log(consoleMsg);

  try {
    fs.appendFileSync(CONFIG.LOG_FILE, consoleMsg + '\n', 'utf8');
  } catch (e) {}
}

// --- IST Schedule Checker ---
function isMarketOpenNow() {
  const now = new Date();
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

  // Monday to Friday only
  if (['Sat', 'Sun'].includes(day)) {
    return { open: false, reason: `Weekend (${day})` };
  }

  const currentMinutes = hour * 60 + minute;
  const startMinutes = CONFIG.START_HOUR * 60 + CONFIG.START_MINUTE; // 9:55 AM = 595
  const endMinutes = CONFIG.END_HOUR * 60 + CONFIG.END_MINUTE;       // 6:00 PM = 1080

  if (currentMinutes < startMinutes) {
    return { open: false, reason: `Before market start (Opens at 09:55 AM IST, currently ${hour}:${String(minute).padStart(2, '0')})` };
  }
  if (currentMinutes > endMinutes) {
    return { open: false, reason: `After market close (Closed at 06:00 PM IST, currently ${hour}:${String(minute).padStart(2, '0')})` };
  }

  return { open: true, reason: 'Market hours active (09:55 AM - 06:00 PM IST)' };
}

// --- Multi-Proxy Scraper for Subscription Data ---
async function fetchSubscriptionWithProxyRotation() {
  log('[PROXY] Fetching live subscription data with IP rotation & blacklist check...', 'INFO');
  try {
    const companies = await fetchLiveSubscription();
    if (companies && companies.length > 0) {
      log(`[PROXY] ✅ Successfully retrieved ${companies.length} companies with active proxy.`, 'SUCCESS');
      return companies;
    }
  } catch (err) {
    log(`[PROXY] ❌ Error during proxy fetch: ${err.message}`, 'ERROR');
  }
  return [];
}

// --- Backend IPO List Cache ---
let cachedIpoList = null;
let lastIpoListFetchTime = 0;

async function getBackendIpoList(activeToken) {
  if (!CONFIG.IPO_LIST_URL) {
    log('[API] ⚠️ BACKEND_IPO_LIST_URL is not configured. Please set in GitHub Secrets or .env.', 'WARN');
    return cachedIpoList || [];
  }

  const now = Date.now();
  if (cachedIpoList && (now - lastIpoListFetchTime < CONFIG.IPO_LIST_CACHE_TTL_MS)) {
    log(`[CACHE] Using cached backend IPO list (${cachedIpoList.length} items)`, 'DEBUG');
    return cachedIpoList;
  }

  log('[API] Fetching live & upcoming IPO list from backend...', 'INFO');
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
      log(`[API] ❌ Failed to fetch IPO list: HTTP ${res.status} ${res.statusText}`, 'ERROR');
      return cachedIpoList || [];
    }

    const json = await res.json();
    if (json && json.data && Array.isArray(json.data)) {
      cachedIpoList = json.data;
      lastIpoListFetchTime = now;
      log(`[API] ✅ Successfully fetched ${cachedIpoList.length} IPOs from backend!`, 'SUCCESS');
      return cachedIpoList;
    }
  } catch (err) {
    log(`[API] ❌ Error fetching IPO list: ${err.message}`, 'ERROR');
  }

  return cachedIpoList || [];
}

// --- Company Name to Symbol Normalizer & Matcher ---
function normalizeName(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/\s*\((?:mainboard|main board|nse sme|bse sme|sme)\s*\)/gi, '')
    .replace(/\b(limited|ltd|india|healthcare|hospital|seeds|services|ayurveda|agritech)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function findMatchingIpo(scrapedCompany, backendIpoList) {
  const scrapedRaw = scrapedCompany.companyName || '';
  const scrapedNorm = normalizeName(scrapedRaw);
  if (!scrapedNorm || scrapedNorm.length < 3) return null;

  for (const ipo of backendIpoList) {
    const backendRaw = ipo.company_name || '';
    const backendSymbol = (ipo.symbol || '').toLowerCase().trim();
    const backendNorm = normalizeName(backendRaw);

    // 1. Direct symbol match (only if symbol length >= 3 and not generic)
    if (backendSymbol && backendSymbol.length >= 3 && scrapedNorm.includes(backendSymbol)) {
      return ipo;
    }

    // 2. Normalized name match (require at least 4 characters to prevent false positives)
    if (backendNorm && backendNorm.length >= 4) {
      if (scrapedNorm.includes(backendNorm) || backendNorm.includes(scrapedNorm)) {
        return ipo;
      }
    }
  }

  return null;
}

// Map category strings for Subscription Details (No. of Shares)
function mapCategorySub(raw) {
  if (!raw) return null;
  const c = raw.trim();
  if (/^total$/i.test(c)) return null; // Never pass Total
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
  if (/^total$/i.test(c)) return null; // Never pass Total
  if (/10l\+/i.test(c)) return 'HNIs (10L+)';
  if (/(2-10l|3-10l)/i.test(c)) return 'HNIs (2-10L)';
  if (/^(retail|individual|rii)/i.test(c)) return 'Retail';
  if (/^employee/i.test(c)) return 'Employee';
  return null;
}

// --- Format Scraped Data to User's Exact Backend Payload ---
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

  return {
    subscription,
    application_wise_breakup
  };
}

// --- Send PUT Update to Backend API ---
async function pushSubscriptionUpdate(symbol, payload, activeToken) {
  if (!CONFIG.UPDATE_SUB_URL) {
    return { success: false, error: 'BACKEND_UPDATE_SUB_URL is not configured.' };
  }
  const url = `${CONFIG.UPDATE_SUB_URL.replace(/\/+$/, '')}/${encodeURIComponent(symbol)}/`;
  
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'ngrok-skip-browser-warning': 'true'
  };

  const token = activeToken || CONFIG.AUTH_TOKEN;
  if (token) {
    if (token.toLowerCase().startsWith('bearer ') || token.toLowerCase().startsWith('token ')) {
      headers[CONFIG.AUTH_HEADER_NAME] = token;
    } else {
      headers[CONFIG.AUTH_HEADER_NAME] = `Bearer ${token}`;
    }
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

    if (res.ok) {
      return { success: true, status: res.status, data: json, message: json?.meta?.message || responseText };
    } else {
      return { success: false, status: res.status, error: responseText };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- Main Execution Cycle ---
async function runSyncCycle() {
  log('====================================================', 'INFO');
  log('🚀 Starting Subscription Sync & API Push Cycle...', 'INFO');

  // 1. Schedule check
  if (!IS_FORCE) {
    const schedule = isMarketOpenNow();
    if (!schedule.open) {
      log(`[SCHEDULE] ⏸️ ${schedule.reason}. Sleeping until next active window.`, 'INFO');
      log('Use --force flag to bypass schedule and run immediately for testing.', 'INFO');
      return;
    }
  } else {
    log('[SCHEDULE] ⚡ Force flag active: Bypassing market hour checks.', 'INFO');
  }

  // 2. Fetch fresh subscription data via proxy rotation
  const companies = await fetchSubscriptionWithProxyRotation();
  if (!companies || companies.length === 0) {
    log('⚠️ No subscription data could be retrieved this cycle. Preserving previous state.', 'WARN');
    return;
  }

  // Save local JSON snapshot for the website UI
  try {
    const result = {
      lastUpdated: new Date().toISOString(),
      count: companies.length,
      companies
    };
    fs.writeFileSync(CONFIG.SNAPSHOT_FILE, JSON.stringify(result, null, 2));
    log(`[SNAPSHOT] Saved ${companies.length} companies to ${CONFIG.SNAPSHOT_FILE}`, 'INFO');
  } catch (e) {}

  // 3. Resolve active Bearer token dynamically
  let activeToken = CONFIG.AUTH_TOKEN;
  if (!activeToken) {
    try {
      activeToken = await getBearerToken();
    } catch (err) {
      log(`[AUTH] ⚠️ Dynamic authentication warning: ${err.message}`, 'WARN');
    }
  }

  // 4. Get backend IPO list
  const backendIpos = await getBackendIpoList(activeToken);
  if (!backendIpos || backendIpos.length === 0) {
    log('⚠️ Backend IPO list is empty. Cannot match symbols to send updates.', 'WARN');
    return;
  }

  // 5. Match companies and send PUT requests
  let matchedCount = 0;
  let pushedCount = 0;

  for (const comp of companies) {
    const matchedIpo = findMatchingIpo(comp, backendIpos);
    if (!matchedIpo) {
      log(`[MATCH] No backend match found for: "${comp.companyName}"`, 'DEBUG');
      continue;
    }

    matchedCount++;
    const symbol = matchedIpo.symbol;
    const payload = formatPayloadForBackend(comp);

    log('----------------------------------------------------', 'INFO');
    log(`🏢 [IPO MATCH] "${comp.companyName}" -> Symbol: [${symbol}] (Backend ID: ${matchedIpo.id})`, 'INFO');
    
    // Log RAW GET DATA from source
    log(`📥 [RAW GET DATA - SHARES BREAKUP ARRAY]:\n${JSON.stringify(comp.sharesBreakup, null, 2)}`, 'INFO');
    log(`📥 [RAW GET DATA - APPLICATION BREAKUP ARRAY]:\n${JSON.stringify(comp.applicationsBreakup, null, 2)}`, 'INFO');

    // Log PASS DATA to Backend API
    log(`📤 [PASS DATA - TO BACKEND API (PUT /ipo/update-subscription-data/${symbol}/)]:\n${JSON.stringify(payload, null, 2)}`, 'INFO');

    // Check if auth token is available
    if (!activeToken) {
      log(`[AUTH] ⚠️ No active auth token available. Skipping actual PUT request.`, 'WARN');
      log('----------------------------------------------------', 'INFO');
      continue;
    }

    // Push PUT request
    const result = await pushSubscriptionUpdate(symbol, payload, activeToken);
    if (result.success) {
      pushedCount++;
      log(`✅ [API RESULT] [${symbol}] Successfully Updated! Status: ${result.status} | Response: ${result.message}`, 'SUCCESS');
    } else {
      log(`❌ [API RESULT] [${symbol}] Update Failed! Status: ${result.status} | Error: ${result.error}`, 'WARN');
    }
    log('----------------------------------------------------', 'INFO');

    // Delay 500ms between PUT calls to be gentle on server
    await new Promise(r => setTimeout(r, 500));
  }

  log(`[SUMMARY] Finished cycle: ${companies.length} scraped, ${matchedCount} matched, ${pushedCount} successfully pushed.`, 'INFO');
  log('====================================================', 'INFO');
}

// --- Continuous Scheduler / Daemon Loop ---
async function startDaemon() {
  log(`Starting Subscription Sync Daemon (Interval: ${CONFIG.POLL_INTERVAL_SEC}s, Hours: 09:55 AM - 06:00 PM IST Mon-Fri)`, 'INFO');
  log(`Log file: ${CONFIG.LOG_FILE}`, 'INFO');

  // Initial immediate run
  await runSyncCycle();

  if (RUN_ONCE) {
    log('Single run complete (--once flag). Exiting.', 'INFO');
    process.exit(0);
  }

  // Recurring loop every POLL_INTERVAL_SEC
  setInterval(async () => {
    try {
      await runSyncCycle();
    } catch (err) {
      log(`Unexpected error in sync cycle: ${err.message}`, 'ERROR');
    }
  }, CONFIG.POLL_INTERVAL_SEC * 1000);
}

if (require.main === module) {
  startDaemon();
}

module.exports = {
  runSyncCycle,
  formatPayloadForBackend,
  findMatchingIpo,
  isMarketOpenNow
};
