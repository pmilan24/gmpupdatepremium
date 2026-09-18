// server.js - Local development server for GMP, Subscription & NSE Anchor Tracker
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  getEnrichedIpoList,
  downloadAnchorZip,
  extractPdfFromZipBuffer
} = require('./fetch-nse-anchor');

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

// In-memory cache for NSE IPO list (cache for 60 seconds)
let nseCacheData = null;
let nseCacheExpiry = 0;

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

  // --- API ROUTE 1: GET /api/nse/ipo-list ---
  if (pathname === '/api/nse/ipo-list') {
    const now = Date.now();
    try {
      if (!nseCacheData || now > nseCacheExpiry) {
        console.log('[SERVER] Refreshing NSE IPO cache...');
        const ipos = await getEnrichedIpoList();
        nseCacheData = {
          lastUpdated: new Date().toISOString(),
          count: ipos.length,
          anchorCount: ipos.filter(i => i.anchor && i.anchor.available).length,
          ipos
        };
        nseCacheExpiry = now + 60 * 1000; // 60s cache
        // Save to file as snapshot
        fs.writeFileSync(path.join(ROOT, 'nse-ipo-data.json'), JSON.stringify(nseCacheData, null, 2));
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(JSON.stringify(nseCacheData));
    } catch (err) {
      console.error('[SERVER] Failed to fetch live NSE IPOs:', err.message);
      // Fallback to local snapshot file if live fetch fails
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

  // Cache directory for downloaded & extracted anchor files
  const cacheDir = '/tmp/nse_cache';
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  // --- API ROUTE 2: GET /api/nse/anchor-pdf?symbol=... ---
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

      // Cache on disk
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

  // --- API ROUTE 3: GET /api/nse/anchor-zip?symbol=... ---
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

      // Cache on disk
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
  console.log(`\n🚀 Local Server running at:`);
  console.log(`   👉 GMP Tracker:            http://localhost:${PORT}/`);
  console.log(`   👉 Live Subscription:     http://localhost:${PORT}/subscription.html`);
  console.log(`   👉 NSE & Anchor Tracker:   http://localhost:${PORT}/anchor.html\n`);
});
