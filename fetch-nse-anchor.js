// fetch-nse-anchor.js - NSE IPO List and Anchor Allocation Report Scraper
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let nseCookies = '';
let nseCookieExpiry = 0;

async function getNSESession() {
  const now = Date.now();
  if (nseCookies && now < nseCookieExpiry) {
    return nseCookies;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  console.log('[NSE] Fetching fresh session cookies from nseindia.com...');
  const res = await fetch('https://www.nseindia.com/', { headers });
  const rawCookie = res.headers.get('set-cookie') || '';
  nseCookies = rawCookie
    .split(/,\s*(?=[a-zA-Z0-9_]+=)/)
    .map(c => c.split(';')[0])
    .join('; ');

  // Cookies valid for 45 minutes
  nseCookieExpiry = now + 45 * 60 * 1000;
  return nseCookies;
}

async function fetchNSEIpoList() {
  const cookies = await getNSESession();
  const apiHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.nseindia.com/market-data/all-upcoming-issues-ipo',
    'Cookie': cookies
  };

  const url = `https://www.nseindia.com/api/ipo-current-issue?_t=${Date.now()}`;
  const res = await fetch(url, { headers: apiHeaders });
  if (!res.ok) {
    throw new Error(`Failed to fetch NSE IPO list: HTTP ${res.status}`);
  }
  return await res.json();
}

async function fetchNSEIpoDetail(symbol, series = 'EQ') {
  const cookies = await getNSESession();
  const apiHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': `https://www.nseindia.com/market-data/issue-information?symbol=${symbol}&series=${series}&type=Active`,
    'Cookie': cookies
  };

  const url = `https://www.nseindia.com/api/ipo-detail?symbol=${encodeURIComponent(symbol)}&series=${encodeURIComponent(series)}&_t=${Date.now()}`;
  const res = await fetch(url, { headers: apiHeaders });
  if (!res.ok) {
    return null;
  }
  return await res.json();
}

async function downloadAnchorZip(zipUrl, symbol, isRetry = false) {
  try {
    const cookies = await getNSESession();
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': `https://www.nseindia.com/market-data/issue-information?symbol=${symbol}&series=EQ&type=Active`,
      'Cookie': cookies
    };

    const res = await fetch(zipUrl, { headers });
    if (!res.ok) {
      if (!isRetry && (res.status === 401 || res.status === 403 || res.status === 503)) {
        console.log(`[NSE] Zip download got HTTP ${res.status}, refreshing session cookies and retrying...`);
        nseCookies = '';
        nseCookieExpiry = 0;
        return downloadAnchorZip(zipUrl, symbol, true);
      }
      throw new Error(`Failed to download zip from ${zipUrl}: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (!isRetry) {
      console.log(`[NSE] Zip download failed (${err.message}), retrying once with fresh cookies...`);
      nseCookies = '';
      nseCookieExpiry = 0;
      return downloadAnchorZip(zipUrl, symbol, true);
    }
    throw err;
  }
}

function extractPdfFromZipBuffer(zipBuffer) {
  const tmpZip = path.join('/tmp', `temp_anchor_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`);
  try {
    fs.writeFileSync(tmpZip, zipBuffer);
    // Use unzip -p to extract any .pdf file directly to stdout buffer
    const pdfBuffer = execSync(`unzip -p "${tmpZip}" "*.pdf"`, { maxBuffer: 50 * 1024 * 1024 });
    return pdfBuffer;
  } finally {
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
  }
}

async function getEnrichedIpoList() {
  const rawList = await fetchNSEIpoList();
  const enriched = [];

  for (const item of rawList) {
    const symbol = item.symbol || '';
    const series = item.series || (item.isBse === '1' ? 'SME' : 'EQ');
    let anchorAvailable = false;
    let anchorTitle = '';
    let anchorZipUrl = '';
    let registrar = '';
    let priceBand = item.issuePrice || '';
    let issueType = '';

    if (symbol) {
      try {
        const detail = await fetchNSEIpoDetail(symbol, series);
        if (detail && detail.issueInfo && Array.isArray(detail.issueInfo.dataList)) {
          // Look for Anchor Allocation Report specifically
          const anchorItem = detail.issueInfo.dataList.find(d => 
            d.title && /anchor\s*allocation\s*report/i.test(d.title)
          );

          if (anchorItem && anchorItem.value && anchorItem.value.startsWith('http')) {
            anchorAvailable = true;
            anchorTitle = anchorItem.title;
            anchorZipUrl = anchorItem.value;
          }

          const regItem = detail.issueInfo.dataList.find(d => d.title && /registrar/i.test(d.title));
          if (regItem) registrar = regItem.value || '';

          const typeItem = detail.issueInfo.dataList.find(d => d.title && /issue type/i.test(d.title));
          if (typeItem) issueType = typeItem.value || '';
        }
      } catch (e) {
        console.warn(`[NSE] Could not fetch detail for ${symbol}:`, e.message);
      }
    }

    const noOfTimes = parseFloat(item.noOfTime) || 0;
    const isSme = series === 'SME' || item.isBse === '1';

    enriched.push({
      symbol,
      companyName: item.companyName || symbol,
      series,
      exchange: isSme ? 'NSE SME / BSE' : 'NSE',
      status: item.status || 'Active',
      issueStartDate: item.issueStartDate || '—',
      issueEndDate: item.issueEndDate || '—',
      issuePrice: priceBand,
      issueSize: item.issueSize || '—',
      noOfTime: noOfTimes,
      noOfsharesBid: item.noOfsharesBid || '0',
      noOfSharesOffered: item.noOfSharesOffered || '0',
      registrar,
      issueType,
      anchor: {
        available: anchorAvailable,
        title: anchorTitle || 'Anchor Allocation Report',
        zipUrl: anchorZipUrl,
        pdfUrl: anchorAvailable ? `/api/nse/anchor-pdf?symbol=${encodeURIComponent(symbol)}` : null,
        detectedAt: anchorAvailable ? Date.now() : null
      },
      updatedAt: new Date().toISOString()
    });
  }

  return enriched;
}

async function main() {
  try {
    console.log('[NSE] Fetching live enriched NSE IPOs with Anchor status...');
    const data = await getEnrichedIpoList();
    console.log(`[NSE] Successfully processed ${data.length} IPOs!`);

    const anchorCount = data.filter(d => d.anchor.available).length;
    console.log(`[NSE] Anchor reports available for: ${anchorCount} IPO(s)`);

    const outputPath = path.join(__dirname, 'nse-ipo-data.json');
    const result = {
      lastUpdated: new Date().toISOString(),
      source: 'https://www.nseindia.com/api/ipo-current-issue',
      count: data.length,
      anchorCount,
      ipos: data
    };

    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`[NSE] Saved output to ${outputPath}`);
  } catch (err) {
    console.error('[NSE] Error in fetch-nse-anchor:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getNSESession,
  fetchNSEIpoList,
  fetchNSEIpoDetail,
  downloadAnchorZip,
  extractPdfFromZipBuffer,
  getEnrichedIpoList
};
