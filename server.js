// server.js - Unified Multi-Exchange Development Server (NSE + BSE + GMP + Subscription)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const SOURCES = require('./sources');
const {
  getEnrichedIpoList,
  fetchNSEIpoDetail,
  downloadAnchorZip,
  extractPdfFromZipBuffer
} = require('./fetch-nse-anchor');
const {
  fetchBSEPublicIssues,
  fetchBSEIpoDetail,
  extractAttachmentFromNoticePdf,
  checkAnchorDateEligibility,
  getEnrichedBSEIpoList,
  findBSEAnchorInNotices,
  probeSequentialBseNotices,
  checkPdfLinkValid
} = require('./fetch-bse-anchor');
const {
  getUnifiedExchangeIpos,
  matchCompany
} = require('./merge-exchanges');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// In-memory caches with in-flight Promise deduplication
let nseCacheData = null;
let nseCacheExpiry = 0;
let nseInFlightPromise = null;

let bseCacheData = null;
let bseCacheExpiry = 0;
let bseInFlightPromise = null;

let unifiedCacheData = null;
let unifiedCacheExpiry = 0;

const cacheDir = '/tmp/nse_cache';
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

function noStoreHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    ...extra
  };
}

function clearExchangeCaches() {
  nseCacheData = null;
  nseCacheExpiry = 0;
  bseCacheData = null;
  bseCacheExpiry = 0;
  unifiedCacheData = null;
  unifiedCacheExpiry = 0;
}

function getBseAttachmentOnly(url, hasAttachment = false) {
  if (!url) return null;
  return hasAttachment || /\/Notices\/Attach\//i.test(url) ? url : null;
}

async function deepCheckNSEAnchor(symbol, preferredSeries = '') {
  const normalizedSymbol = (symbol || '').toUpperCase().trim();
  if (!normalizedSymbol) return { available: false, zipUrl: null, detail: null, attempts: [] };

  const seriesCandidates = [...new Set([preferredSeries, 'EQ', 'SME', 'BE'].filter(Boolean))];
  const typeCandidates = ['Active', 'Forthcoming'];
  const attempts = [];

  for (const series of seriesCandidates) {
    for (const type of typeCandidates) {
      try {
        const detail = await fetchNSEIpoDetail(normalizedSymbol, series, type);
        attempts.push(`${series}/${type}: ${detail ? 'HTTP OK' : 'no data'}`);
        const list = detail?.issueInfo?.dataList || [];
        const anchorItem = Array.isArray(list) ? list.find(d => d.title && /anchor\s*allocation\s*report/i.test(d.title)) : null;
        if (anchorItem && anchorItem.value && anchorItem.value.startsWith('http')) {
          return { available: true, zipUrl: anchorItem.value, detail, series, type, title: anchorItem.title, attempts };
        }
      } catch (e) {
        attempts.push(`${series}/${type}: ${e.message}`);
      }
    }
  }

  // NSE archive sometimes publishes deterministic ZIP before detail API is refreshed.
  try {
    const archiveZipUrl = `${SOURCES.NSE_ARCHIVE_URL}/content/ipo/ANCHOR_${encodeURIComponent(normalizedSymbol)}.zip`;
    await downloadAnchorZip(archiveZipUrl, normalizedSymbol, true);
    attempts.push('archive-direct: ZIP available');
    return { available: true, zipUrl: archiveZipUrl, detail: null, series: preferredSeries || 'EQ', type: 'Archive', title: 'Anchor Allocation Report', attempts };
  } catch (e) {
    attempts.push(`archive-direct: ${e.message}`);
  }

  return { available: false, zipUrl: null, detail: null, attempts };
}


// Pre-warm initial caches from existing snapshot
try {
  const initialSnapshotPath = path.join(ROOT, 'nse-ipo-data.json');
  if (fs.existsSync(initialSnapshotPath)) {
    const parsed = JSON.parse(fs.readFileSync(initialSnapshotPath, 'utf8'));
    if (parsed && Array.isArray(parsed.ipos) && parsed.ipos.length > 0) {
      unifiedCacheData = parsed;
      unifiedCacheExpiry = Date.now() + 60 * 1000;

      const nseItems = parsed.ipos.filter(i => (i.platforms && i.platforms.includes('NSE')) || (i.exchange && i.exchange.includes('NSE')));
      if (nseItems.length > 0) {
        nseCacheData = {
          source: 'NSE India',
          lastUpdated: parsed.lastUpdated || new Date().toISOString(),
          count: nseItems.length,
          anchorCount: nseItems.filter(i => i.anchor && i.anchor.available).length,
          ipos: nseItems
        };
        nseCacheExpiry = Date.now() + 60 * 1000;
      }

      const bseItems = parsed.ipos.filter(i => (i.platforms && i.platforms.includes('BSE')) || (i.exchange && i.exchange.includes('BSE')));
      if (bseItems.length > 0) {
        bseCacheData = {
          source: 'BSE India',
          lastUpdated: parsed.lastUpdated || new Date().toISOString(),
          count: bseItems.length,
          anchorCount: bseItems.filter(i => i.anchor && i.anchor.available).length,
          ipos: bseItems
        };
        bseCacheExpiry = Date.now() + 60 * 1000;
      }
      console.log(`[SERVER] Pre-warmed caches from snapshot: ${nseItems.length} NSE, ${bseItems.length} BSE, ${parsed.ipos.length} Unified.`);
    }
  }
} catch (e) {
  console.warn('[SERVER] Could not load initial snapshot:', e.message);
}

async function getCachedNSEList(force = false) {
  const now = Date.now();
  if (!force && nseCacheData && now < nseCacheExpiry) {
    return nseCacheData;
  }
  if (nseInFlightPromise) {
    return await nseInFlightPromise;
  }
  nseInFlightPromise = (async () => {
    try {
      console.log('[SERVER] Fetching fresh NSE IPO list...');
      const list = await getEnrichedIpoList();
      nseCacheData = {
        source: 'NSE India',
        lastUpdated: new Date().toISOString(),
        count: list.length,
        anchorCount: list.filter(i => i.anchor && i.anchor.available).length,
        ipos: list
      };
      nseCacheExpiry = Date.now() + 120 * 1000; // 2 min cache
      return nseCacheData;
    } catch (err) {
      console.warn('[SERVER] NSE fetch error:', err.message);
      if (nseCacheData) return nseCacheData;
      throw err;
    } finally {
      nseInFlightPromise = null;
    }
  })();
  return await nseInFlightPromise;
}

async function getCachedBSEList(force = false) {
  const now = Date.now();
  if (!force && bseCacheData && now < bseCacheExpiry) {
    return bseCacheData;
  }
  if (bseInFlightPromise) {
    return await bseInFlightPromise;
  }
  bseInFlightPromise = (async () => {
    try {
      console.log('[SERVER] Fetching fresh BSE IPO list...');
      const list = await getEnrichedBSEIpoList();
      bseCacheData = {
        source: 'BSE India',
        lastUpdated: new Date().toISOString(),
        count: list.length,
        anchorCount: list.filter(i => i.anchor && i.anchor.available).length,
        ipos: list
      };
      bseCacheExpiry = Date.now() + 120 * 1000; // 2 min cache
      return bseCacheData;
    } catch (err) {
      console.warn('[SERVER] BSE fetch error:', err.message);
      if (bseCacheData) return bseCacheData;
      throw err;
    } finally {
      bseInFlightPromise = null;
    }
  })();
  return await bseInFlightPromise;
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse URL
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;
  const force = parsedUrl.searchParams.get('force') === '1';
  if (force) clearExchangeCaches();

  // --- DYNAMIC ROUTE: GET /data.json (Live GMP Feed with automatic refresh) ---
  if (pathname === '/data.json') {
    const dataPath = path.join(ROOT, 'data.json');
    let shouldRefresh = force;

    if (!shouldRefresh && fs.existsSync(dataPath)) {
      try {
        const stats = fs.statSync(dataPath);
        const ageSec = (Date.now() - stats.mtimeMs) / 1000;
        if (ageSec > 120) shouldRefresh = true; // Refresh if older than 2 minutes
      } catch (e) {
        shouldRefresh = true;
      }
    } else if (!fs.existsSync(dataPath)) {
      shouldRefresh = true;
    }

    if (shouldRefresh) {
      try {
        console.log('[SERVER] Refreshing Live GMP data from proxy feed...');
        const { fetchFromWeb } = require('./fetch-gmp');
        const items = await fetchFromWeb();
        if (items && items.length > 0) {
          const result = {
            lastUpdated: new Date().toISOString(),
            source: 'Live Market Feed',
            count: items.length,
            ipos: items
          };
          fs.writeFileSync(dataPath, JSON.stringify(result, null, 2));
        }
      } catch (err) {
        console.warn('[SERVER] GMP fetch failed, serving existing snapshot:', err.message);
      }
    }

    if (fs.existsSync(dataPath)) {
      const content = fs.readFileSync(dataPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      res.end(content);
      return;
    }
  }

  // --- DYNAMIC ROUTE: GET /subscription-data.json (Live Subscription Feed with automatic push) ---
  if (pathname === '/subscription-data.json') {
    const subPath = path.join(ROOT, 'subscription-data.json');
    let shouldRefresh = force;

    if (!shouldRefresh && fs.existsSync(subPath)) {
      try {
        const stats = fs.statSync(subPath);
        const ageSec = (Date.now() - stats.mtimeMs) / 1000;
        if (ageSec > 60) shouldRefresh = true; // Refresh if older than 1 minute
      } catch (e) {
        shouldRefresh = true;
      }
    } else if (!fs.existsSync(subPath)) {
      shouldRefresh = true;
    }

    if (shouldRefresh) {
      try {
        console.log('[SERVER] Refreshing live subscription data & syncing to backend...');
        const { runSyncCycle } = require('./sync-subscription-api');
        await runSyncCycle();
      } catch (err) {
        console.warn('[SERVER] Subscription sync failed, serving existing snapshot:', err.message);
      }
    }

    if (fs.existsSync(subPath)) {
      const content = fs.readFileSync(subPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      res.end(content);
      return;
    }
  }

  // --- API ROUTE: GET /api/nse/ipo-list (NSE India Only) ---
  if (pathname === '/api/nse/ipo-list') {
    try {
      const data = await getCachedNSEList(force);
      res.writeHead(200, noStoreHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, ipos: [] }));
    }
    return;
  }

  // --- API ROUTE: GET /api/bse/ipo-list (BSE India Only) ---
  if (pathname === '/api/bse/ipo-list') {
    try {
      const data = await getCachedBSEList(force);
      res.writeHead(200, noStoreHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, ipos: [] }));
    }
    return;
  }

  // --- API ROUTE: GET /api/exchange/ipo-list (Unified NSE + BSE) ---
  if (pathname === '/api/exchange/ipo-list') {
    const now = Date.now();
    try {
      if (force || !unifiedCacheData || now > unifiedCacheExpiry) {
        console.log('[SERVER] Refreshing unified exchange IPO cache (NSE + BSE)...');
        const ipos = await require('./merge-exchanges').getUnifiedExchangeIpos();
        const nseCount = ipos.filter(i => (i.platforms && i.platforms.includes('NSE')) || (i.exchange && i.exchange.includes('NSE'))).length;
        const bseCount = ipos.filter(i => (i.platforms && i.platforms.includes('BSE')) || (i.exchange && i.exchange.includes('BSE'))).length;
        unifiedCacheData = {
          lastUpdated: new Date().toISOString(),
          count: ipos.length,
          nseCount,
          bseCount,
          anchorCount: ipos.filter(i => i.anchor && i.anchor.available).length,
          ipos
        };
        unifiedCacheExpiry = now + 90 * 1000;
        // Save snapshot to local file
        fs.writeFileSync(path.join(ROOT, 'nse-ipo-data.json'), JSON.stringify(unifiedCacheData, null, 2));
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ...noStoreHeaders()
      });
      res.end(JSON.stringify(unifiedCacheData));
    } catch (err) {
      console.error('[SERVER] Failed to fetch unified IPOs:', err.message);
      const fallbackPath = path.join(ROOT, 'nse-ipo-data.json');
      if (fs.existsSync(fallbackPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        fs.createReadStream(fallbackPath).pipe(res);
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // --- API ROUTE: GET /api/exchange/check-ipo?symbol=...&companyName=... (Live On-Demand Deep Cross-Check) ---
  if (pathname === '/api/exchange/check-ipo') {
    const symbol = (parsedUrl.searchParams.get('symbol') || '').toUpperCase().trim();
    const companyName = parsedUrl.searchParams.get('companyName') || '';
    const exchange = (parsedUrl.searchParams.get('exchange') || 'BOTH').toUpperCase();
    const preferredSeries = (parsedUrl.searchParams.get('series') || '').toUpperCase().trim();

    clearExchangeCaches();

    const steps = [];
    steps.push({ stage: 'init', message: `Initializing cache-free live cross-exchange check for ${symbol || companyName}...` });

    try {
      let nseAnchorFound = false;
      let nseZipUrl = null;
      let nseSeries = preferredSeries || null;
      let nseType = null;
      let bseAnchorFound = false;
      let bseNoticePdfUrl = null;
      let bseIntimationPdfUrl = null;
      let bseNoticeNo = null;
      let bseIssuePageUrl = null;

      if ((exchange === 'NSE' || exchange === 'BOTH') && symbol) {
        steps.push({ stage: 'nse_lookup', message: `NSE fresh check: scanning EQ/SME and Active/Forthcoming issue detail APIs for ${symbol}...` });
        const nseCheck = await deepCheckNSEAnchor(symbol, preferredSeries);
        nseAnchorFound = nseCheck.available;
        nseZipUrl = nseCheck.zipUrl;
        nseSeries = nseCheck.series || nseSeries;
        nseType = nseCheck.type || null;
        steps.push({ stage: 'nse_attempts', message: `NSE attempts: ${nseCheck.attempts.join(' | ')}` });
        if (nseAnchorFound) {
          steps.push({ stage: 'nse_success', message: `Found NSE Anchor Allocation ZIP (${nseSeries || 'series auto'}, ${nseType || 'type auto'}): ${nseCheck.title || 'Anchor Allocation Report'}` });
        } else {
          steps.push({ stage: 'nse_none', message: `NSE: No Anchor Allocation Report found after fresh detail + direct archive check.` });
        }
      }

      if (exchange === 'BSE' || exchange === 'BOTH') {
        steps.push({ stage: 'bse_lookup', message: `BSE fresh check: scanning issue database and live notice feeds...` });
        try {
          const bseIssues = await fetchBSEPublicIssues();
          const matchedBse = bseIssues.find(b => matchCompany({ symbol, companyName }, { symbol: b.short_name, companyName: b.Scrip_Name }));

          if (matchedBse) {
            steps.push({ stage: 'bse_matched', message: `Matched on BSE: ${matchedBse.Scrip_Name} (IPO_NO: ${matchedBse.IPO_NO})` });
            const scripCode = matchedBse.Scrip_cd || '';
            const ipoNo = matchedBse.IPO_NO || '';
            bseIssuePageUrl = ipoNo ? `${SOURCES.BSE_BASE_URL}/markets/publicissues/displayipo?id=${scripCode}&type=IPO&idtype=1&status=F&IPONo=${ipoNo}` : null;

            try {
              const detail = await fetchBSEIpoDetail(matchedBse.IPO_NO);
              const notices = detail.IPONO_4 || [];
              const foundNotice = notices.find(n => /anchor/i.test(n.SUBJECT || ''));

              if (foundNotice) {
                bseNoticeNo = foundNotice.NOTICE_NO;
                bseNoticePdfUrl = foundNotice.FILENAME || `${SOURCES.BSE_BASE_URL}/downloads/UploadDocs/Notices/${foundNotice.NOTICE_NO}/${foundNotice.NOTICE_NO}.pdf`;
                steps.push({ stage: 'bse_notice_found', message: `Found BSE Anchor Notice #${bseNoticeNo}: ${(foundNotice.SUBJECT || '').replace(/[\r\n]+/g, ' ')}` });
                bseIntimationPdfUrl = await extractAttachmentFromNoticePdf(bseNoticePdfUrl);
                if (bseIntimationPdfUrl) {
                  bseAnchorFound = true;
                  steps.push({ stage: 'bse_success', message: `Extracted verified BSE inner attachment PDF.` });
                } else {
                  steps.push({ stage: 'bse_info', message: `BSE notice found but inner attachment PDF was not present yet.` });
                }
              }
            } catch (detailErr) {
              steps.push({ stage: 'bse_error', message: `BSE issue detail API notice: ${detailErr.message}` });
            }
          } else {
            steps.push({ stage: 'bse_unmatched', message: `BSE issue database did not return a company match.` });
          }
        } catch (bseErr) {
          steps.push({ stage: 'bse_error', message: `BSE public issue API notice: ${bseErr.message}` });
        }

        if (!bseAnchorFound) {
          steps.push({ stage: 'bse_live_notices', message: `Scanning BSE live notice feed for uploaded Anchor filings...` });
          const queryName = companyName || symbol;
          const liveNotice = await findBSEAnchorInNotices(queryName);
          if (liveNotice) {
            bseNoticeNo = liveNotice.noticeNo;
            bseNoticePdfUrl = liveNotice.noticePdfUrl;
            bseIntimationPdfUrl = getBseAttachmentOnly(liveNotice.intimationPdfUrl, liveNotice.hasIntimationAttachment);
            if (bseIntimationPdfUrl) {
              bseAnchorFound = true;
              steps.push({ stage: 'bse_success', message: `Discovered verified live BSE attachment from notice #${bseNoticeNo}: ${liveNotice.subject || 'Anchor Allocation'}` });
            } else {
              steps.push({ stage: 'bse_info', message: `BSE live notice found but verified inner attachment is not available yet.` });
            }
          }
        }

        if (!bseAnchorFound) {
          const queryName = companyName || symbol;
          const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          steps.push({ stage: 'bse_probe', message: `Probing BSE notice PDFs for ${todayStr} without cache...` });
          const probed = await probeSequentialBseNotices(queryName, todayStr, 70);
          if (probed) {
            bseNoticeNo = probed.noticeNo;
            bseNoticePdfUrl = probed.noticePdfUrl;
            bseIntimationPdfUrl = getBseAttachmentOnly(probed.intimationPdfUrl, probed.hasIntimationAttachment);
            if (bseIntimationPdfUrl) {
              bseAnchorFound = true;
              steps.push({ stage: 'bse_success', message: `Found verified BSE attachment via sequential probe: ${bseNoticeNo}.pdf` });
            } else {
              steps.push({ stage: 'bse_info', message: `BSE notice candidate found via probe, but no verified attachment yet.` });
            }
          } else {
            steps.push({ stage: 'bse_none', message: `BSE: No verified Anchor attachment detected in fresh scan.` });
          }
        }
      }

      res.writeHead(200, noStoreHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
      res.end(JSON.stringify({
        symbol,
        companyName,
        checkedAt: new Date().toISOString(),
        anchorAvailable: nseAnchorFound || bseAnchorFound,
        sources: {
          nse: {
            available: nseAnchorFound,
            zipUrl: nseZipUrl,
            pdfUrl: nseAnchorFound ? `/api/nse/anchor-pdf?symbol=${encodeURIComponent(symbol)}&force=1` : null,
            series: nseSeries,
            type: nseType
          },
          bse: {
            available: bseAnchorFound,
            noticeNo: bseNoticeNo,
            noticePdfUrl: bseNoticePdfUrl,
            intimationPdfUrl: bseIntimationPdfUrl,
            issuePageUrl: bseIssuePageUrl
          }
        },
        steps
      }));
    } catch (err) {
      steps.push({ stage: 'error', message: err.message });
      res.writeHead(500, noStoreHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ error: err.message, steps }));
    }
    return;
  }

  // --- API ROUTE: GET /api/bse/proxy-pdf?url=... (Stream BSE Notice or Attachment PDF) ---
  if (pathname === '/api/bse/proxy-pdf') {
    const targetUrl = parsedUrl.searchParams.get('url');
    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing or invalid url parameter');
      return;
    }

    try {
      const urlObj = new URL(targetUrl);
      const options = {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `${SOURCES.BSE_BASE_URL}/`
        },
        insecureHTTPParser: true
      };

      https.get(options, (upstream) => {
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
          res.writeHead(302, { Location: upstream.headers.location });
          res.end();
          return;
        }

        res.writeHead(upstream.statusCode, {
          'Content-Type': upstream.headers['content-type'] || 'application/pdf',
          'Content-Disposition': 'inline',
          ...noStoreHeaders()
        });
        upstream.pipe(res);
      }).on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Proxy error: ${e.message}`);
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to proxy BSE PDF: ${e.message}`);
    }
    return;
  }

  // --- API ROUTE: GET /api/nse/anchor-pdf?symbol=... ---
  if (pathname === '/api/nse/anchor-pdf') {
    const symbol = (parsedUrl.searchParams.get('symbol') || '').toUpperCase().trim();
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing symbol parameter');
      return;
    }

    const cachedPdfPath = path.join(cacheDir, `ANCHOR_${symbol}.pdf`);
    if (!force && fs.existsSync(cachedPdfPath)) {
      const stats = fs.statSync(cachedPdfPath);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="ANCHOR_${symbol}_REPORT.pdf"`,
        'Content-Length': stats.size,
        ...noStoreHeaders()
      });
      fs.createReadStream(cachedPdfPath).pipe(res);
      return;
    }

    try {
      console.log(`[SERVER] Processing PDF extraction for symbol: ${symbol}`);
      const zipUrl = `${SOURCES.NSE_ARCHIVE_URL}/content/ipo/ANCHOR_${symbol}.zip`;
      const zipBuffer = await downloadAnchorZip(zipUrl, symbol);
      const pdfBuffer = extractPdfFromZipBuffer(zipBuffer);

      fs.writeFileSync(cachedPdfPath, pdfBuffer);

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="ANCHOR_${symbol}_REPORT.pdf"`,
        'Content-Length': pdfBuffer.length,
        ...noStoreHeaders()
      });
      res.end(pdfBuffer);
    } catch (err) {
      console.error(`[SERVER] Failed to extract PDF for ${symbol}:`, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error extracting Anchor PDF for ${symbol}: ${err.message}`);
    }
    return;
  }

  // --- API ROUTE: GET /api/nse/anchor-zip?symbol=... ---
  if (pathname === '/api/nse/anchor-zip') {
    const symbol = (parsedUrl.searchParams.get('symbol') || '').toUpperCase().trim();
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing symbol parameter');
      return;
    }

    const cachedZipPath = path.join(cacheDir, `ANCHOR_${symbol}.zip`);
    if (!force && fs.existsSync(cachedZipPath)) {
      const stats = fs.statSync(cachedZipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="ANCHOR_${symbol}.zip"`,
        'Content-Length': stats.size,
        ...noStoreHeaders()
      });
      fs.createReadStream(cachedZipPath).pipe(res);
      return;
    }

    try {
      console.log(`[SERVER] Downloading ZIP archive for symbol: ${symbol}`);
      const zipUrl = `${SOURCES.NSE_ARCHIVE_URL}/content/ipo/ANCHOR_${symbol}.zip`;
      const zipBuffer = await downloadAnchorZip(zipUrl, symbol);

      fs.writeFileSync(cachedZipPath, zipBuffer);

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="ANCHOR_${symbol}.zip"`,
        'Content-Length': zipBuffer.length,
        ...noStoreHeaders()
      });
      res.end(zipBuffer);
    } catch (err) {
      console.error(`[SERVER] Failed to download ZIP for ${symbol}:`, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error downloading Anchor ZIP for ${symbol}: ${err.message}`);
    }
    return;
  }

  // --- STATIC FILE SERVER ---
  let filePath = path.join(ROOT, pathname);
  if (pathname === '/' || pathname === '') {
    filePath = path.join(ROOT, 'index.html');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Multi-Exchange Server running at:`);
  console.log(`   👉 GMP Tracker:               http://localhost:${PORT}/`);
  console.log(`   👉 Live Subscription:        http://localhost:${PORT}/subscription.html`);
  console.log(`   👉 Unified IPO & Anchor Tracker: http://localhost:${PORT}/anchor.html\n`);
});
