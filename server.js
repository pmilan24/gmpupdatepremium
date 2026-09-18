// server.js - Unified Multi-Exchange Development Server (NSE + BSE + GMP + Subscription)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
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
  getEnrichedBSEIpoList
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

// In-memory cache for Unified IPO list (cache for 60 seconds)
let unifiedCacheData = null;
let unifiedCacheExpiry = 0;

const cacheDir = '/tmp/nse_cache';
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

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

  // --- API ROUTE: GET /api/exchange/ipo-list (Unified NSE + BSE) ---
  if (pathname === '/api/exchange/ipo-list' || pathname === '/api/nse/ipo-list') {
    const now = Date.now();
    try {
      if (!unifiedCacheData || now > unifiedCacheExpiry) {
        console.log('[SERVER] Refreshing unified exchange IPO cache (NSE + BSE)...');
        const ipos = await getUnifiedExchangeIpos();
        unifiedCacheData = {
          lastUpdated: new Date().toISOString(),
          count: ipos.length,
          anchorCount: ipos.filter(i => i.anchor && i.anchor.available).length,
          ipos
        };
        unifiedCacheExpiry = now + 60 * 1000; // 60s cache
        // Save snapshot to local file
        fs.writeFileSync(path.join(ROOT, 'nse-ipo-data.json'), JSON.stringify(unifiedCacheData, null, 2));
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
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

  // --- API ROUTE: GET /api/bse/ipo-list ---
  if (pathname === '/api/bse/ipo-list') {
    try {
      const bseList = await getEnrichedBSEIpoList();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        lastUpdated: new Date().toISOString(),
        count: bseList.length,
        anchorCount: bseList.filter(i => i.anchor && i.anchor.available).length,
        ipos: bseList
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- API ROUTE: GET /api/exchange/check-ipo?symbol=...&companyName=... (Live On-Demand Deep Cross-Check) ---
  if (pathname === '/api/exchange/check-ipo') {
    const symbol = (parsedUrl.searchParams.get('symbol') || '').toUpperCase().trim();
    const companyName = parsedUrl.searchParams.get('companyName') || '';

    const steps = [];
    steps.push({ stage: 'init', message: `Initializing live cross-exchange check for ${symbol || companyName}...` });

    try {
      let nseAnchorFound = false;
      let nseZipUrl = null;
      let bseAnchorFound = false;
      let bseNoticePdfUrl = null;
      let bseIntimationPdfUrl = null;
      let bseNoticeNo = null;

      // 1. Check NSE
      steps.push({ stage: 'nse_lookup', message: `Querying NSE issue information for ${symbol}...` });
      if (symbol) {
        try {
          const nseDetail = await fetchNSEIpoDetail(symbol, 'EQ');
          if (nseDetail && nseDetail.issueInfo && Array.isArray(nseDetail.issueInfo.dataList)) {
            const anchorItem = nseDetail.issueInfo.dataList.find(d => 
              d.title && /anchor\s*allocation\s*report/i.test(d.title)
            );
            if (anchorItem && anchorItem.value && anchorItem.value.startsWith('http')) {
              nseAnchorFound = true;
              nseZipUrl = anchorItem.value;
              steps.push({ stage: 'nse_success', message: `Found NSE Anchor Allocation ZIP file: ${anchorItem.title}` });
            } else {
              steps.push({ stage: 'nse_none', message: `NSE: No anchor allocation report posted yet.` });
            }
          }
        } catch (e) {
          steps.push({ stage: 'nse_error', message: `NSE check notice: ${e.message}` });
        }
      }

      // 2. Check BSE
      steps.push({ stage: 'bse_lookup', message: `Scanning BSE Public Issues database...` });
      const bseIssues = await fetchBSEPublicIssues();
      const matchedBse = bseIssues.find(b => matchCompany({ symbol, companyName }, { symbol: b.short_name, companyName: b.Scrip_Name }));

      if (matchedBse) {
        steps.push({ stage: 'bse_matched', message: `Matched on BSE: ${matchedBse.Scrip_Name} (IPO_NO: ${matchedBse.IPO_NO})` });
        const detail = await fetchBSEIpoDetail(matchedBse.IPO_NO);
        const notices = detail.IPONO_4 || [];
        const foundNotice = notices.find(n => /anchor/i.test(n.SUBJECT || ''));

        if (foundNotice) {
          bseNoticeNo = foundNotice.NOTICE_NO;
          bseNoticePdfUrl = foundNotice.FILENAME || `https://www.bseindia.com/downloads/UploadDocs/Notices/${foundNotice.NOTICE_NO}/${foundNotice.NOTICE_NO}.pdf`;
          steps.push({ stage: 'bse_notice_found', message: `Found BSE Anchor Notice #${bseNoticeNo}: ${foundNotice.SUBJECT.replace(/[\r\n]+/g, ' ')}` });

          steps.push({ stage: 'bse_extract_pdf', message: `Extracting Anchor Intimation Letter attachment from BSE Notice PDF...` });
          bseIntimationPdfUrl = await extractAttachmentFromNoticePdf(bseNoticePdfUrl);

          if (bseIntimationPdfUrl) {
            bseAnchorFound = true;
            steps.push({ stage: 'bse_success', message: `Extracted Intimation Letter PDF successfully!` });
          } else {
            bseAnchorFound = true;
            bseIntimationPdfUrl = bseNoticePdfUrl;
            steps.push({ stage: 'bse_success', message: `BSE Notice PDF ready.` });
          }
        } else {
          steps.push({ stage: 'bse_none', message: `BSE: No anchor investor notice posted yet.` });
        }
      } else {
        steps.push({ stage: 'bse_unmatched', message: `Issue not found on BSE Public Issue list.` });
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        symbol,
        companyName,
        checkedAt: new Date().toISOString(),
        anchorAvailable: nseAnchorFound || bseAnchorFound,
        sources: {
          nse: {
            available: nseAnchorFound,
            zipUrl: nseZipUrl,
            pdfUrl: nseAnchorFound ? `/api/nse/anchor-pdf?symbol=${encodeURIComponent(symbol)}` : null
          },
          bse: {
            available: bseAnchorFound,
            noticeNo: bseNoticeNo,
            noticePdfUrl: bseNoticePdfUrl,
            intimationPdfUrl: bseIntimationPdfUrl
          }
        },
        steps
      }));
    } catch (err) {
      steps.push({ stage: 'error', message: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
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
          'Referer': 'https://www.bseindia.com/'
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
          'Cache-Control': 'public, max-age=3600'
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
    if (fs.existsSync(cachedPdfPath)) {
      const stats = fs.statSync(cachedPdfPath);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="ANCHOR_${symbol}_REPORT.pdf"`,
        'Content-Length': stats.size,
        'Cache-Control': 'public, max-age=3600'
      });
      fs.createReadStream(cachedPdfPath).pipe(res);
      return;
    }

    try {
      console.log(`[SERVER] Processing PDF extraction for symbol: ${symbol}`);
      const zipUrl = `https://nsearchives.nseindia.com/content/ipo/ANCHOR_${symbol}.zip`;
      const zipBuffer = await downloadAnchorZip(zipUrl, symbol);
      const pdfBuffer = extractPdfFromZipBuffer(zipBuffer);

      fs.writeFileSync(cachedPdfPath, pdfBuffer);

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="ANCHOR_${symbol}_REPORT.pdf"`,
        'Content-Length': pdfBuffer.length,
        'Cache-Control': 'public, max-age=3600'
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
    if (fs.existsSync(cachedZipPath)) {
      const stats = fs.statSync(cachedZipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="ANCHOR_${symbol}.zip"`,
        'Content-Length': stats.size,
        'Cache-Control': 'public, max-age=3600'
      });
      fs.createReadStream(cachedZipPath).pipe(res);
      return;
    }

    try {
      console.log(`[SERVER] Downloading ZIP archive for symbol: ${symbol}`);
      const zipUrl = `https://nsearchives.nseindia.com/content/ipo/ANCHOR_${symbol}.zip`;
      const zipBuffer = await downloadAnchorZip(zipUrl, symbol);

      fs.writeFileSync(cachedZipPath, zipBuffer);

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="ANCHOR_${symbol}.zip"`,
        'Content-Length': zipBuffer.length,
        'Cache-Control': 'public, max-age=3600'
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
