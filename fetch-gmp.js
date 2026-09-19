// fetch-gmp.js - Parser and updater for Live Market GMP data
const fs = require('fs');
const path = require('path');
const SOURCES = require('./sources');

const TARGET_URL = SOURCES.GMP_SOURCE_URL;
const JINA_URL = `${SOURCES.JINA_PREFIX_URL}${TARGET_URL}`;

function parseMarkdownTable(markdown) {
  const lines = markdown.split('\n');
  let tableStarted = false;
  let headers = [];
  const ipos = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;

    const cells = line
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());

    if (!tableStarted) {
      if (cells.some(c => c.toLowerCase().includes('company name'))) {
        headers = cells.map(c => c.toLowerCase());
        tableStarted = true;
        continue;
      }
    } else {
      // Skip separator line (e.g. | --- | --- |)
      if (cells.every(c => /^[-:\s]+$/.test(c))) {
        continue;
      }

      if (cells.length < 5) continue;

      // Extract Company Name and URL
      const rawNameCell = cells[0] || '';
      const nameMatch = rawNameCell.match(/\[(.*?)\]\((.*?)\)/);
      const name = nameMatch ? nameMatch[1].trim() : rawNameCell.replace(/[\[\]]/g, '').trim();
      const url = nameMatch ? nameMatch[2].trim() : '';

      if (!name || name.toLowerCase().includes('company name')) continue;

      // Type: Mainboard or SME
      let type = 'Mainboard';
      if (/SME/i.test(name)) {
        type = 'SME';
      }

      // Clean name (strip (MAINBOARD), (NSE SME), etc. for cleaner display, but keep tag)
      let cleanName = name
        .replace(/\s*\((?:MAINBOARD|MAIN BOARD|NSE SME|BSE SME|SME)\s*\)/gi, '')
        .trim();

      // Extract GMP Rumors
      const rawGmp = cells[1] || '0';
      // Format: "189 (10.6%)" or "0" or "-10" or "--"
      let gmpValue = 0;
      let gmpPercent = '0%';

      const gmpMatch = rawGmp.match(/^(-?\d+)(?:\s*\((.*?)\))?/);
      if (gmpMatch) {
        gmpValue = parseInt(gmpMatch[1], 10) || 0;
        if (gmpMatch[2]) {
          gmpPercent = gmpMatch[2].trim();
        }
      } else {
        const numOnly = parseInt(rawGmp.replace(/[^\d-]/g, ''), 10);
        gmpValue = isNaN(numOnly) ? 0 : numOnly;
      }

      // Extract Open & Close Dates
      const openDate = cells[2] || '';
      const closeDate = cells[3] || '';

      // Extract Price Band
      const rawPrice = cells[4] || '';
      // Format: "1700-1785" or "59-59" or "84"
      let priceUpper = 0;
      const priceParts = rawPrice.split('-').map(p => parseInt(p.replace(/[^\d]/g, ''), 10)).filter(p => !isNaN(p));
      if (priceParts.length > 0) {
        priceUpper = priceParts[priceParts.length - 1];
      }

      // Lot Size
      const rawLot = cells[5] || '0';
      const lotSize = parseInt(rawLot.replace(/[^\d]/g, ''), 10) || 0;

      // Issue Size
      const issueSize = cells[6] || '';

      // Allotment & Listing Dates
      const allotmentDate = cells[8] || '';
      const listingDate = cells[9] || '';

      // Estimated Profit Per Lot
      const estimatedProfit = (gmpValue * lotSize) || 0;

      ipos.push({
        id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        fullName: name,
        displayName: cleanName || name,
        type,
        gmp: gmpValue,
        gmpPercent: gmpPercent.startsWith('+') ? gmpPercent : (gmpValue > 0 && !gmpPercent.startsWith('+') && gmpPercent !== '0%' ? `+${gmpPercent}` : gmpPercent),
        rawGmp,
        openDate,
        closeDate,
        priceBand: rawPrice,
        priceUpper,
        lotSize,
        issueSize,
        allotmentDate,
        listingDate,
        estimatedProfit,
        url: url ? url.replace(/^https?:\/\/[^\/]+/i, '') : '',
        updatedAt: new Date().toISOString()
      });
    }
  }

  return ipos;
}

const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function fetchFromWeb() {
  if (!TARGET_URL) {
    console.error('TARGET_URL is not configured.');
    return [];
  }

  // Strategy list for rotating proxies and edge IP routing
  const strategies = [
    {
      name: 'Jina Reader Primary (Edge IP Rotation & Cache-Bust)',
      url: `${SOURCES.JINA_PREFIX_URL}${TARGET_URL}?_t=${Date.now()}`,
      headers: {
        'Accept': 'text/plain',
        'x-no-cache': 'true'
      }
    },
    {
      name: 'Jina Reader Direct Clean Route',
      url: `${SOURCES.JINA_PREFIX_URL}${TARGET_URL}`,
      headers: {
        'Accept': 'text/plain',
        'x-no-cache': 'true'
      }
    },
    {
      name: 'Jina Reader Protocol Alternate Route',
      url: `${SOURCES.JINA_PREFIX_URL}${TARGET_URL.replace(/^https:\/\//, 'http://')}`,
      headers: {
        'Accept': 'text/plain',
        'x-no-cache': 'true'
      }
    },
    {
      name: 'Jina Reader Encoded Routing',
      url: `${SOURCES.JINA_PREFIX_URL}${encodeURIComponent(TARGET_URL)}?_nocache=${Date.now()}`,
      headers: {
        'Accept': 'text/plain',
        'x-no-cache': 'true'
      }
    }
  ];

  for (let i = 0; i < strategies.length; i++) {
    const strat = strategies[i];
    console.log(`[Attempt ${i + 1}/${strategies.length}] Trying proxy strategy: ${strat.name}...`);
    try {
      const response = await fetchWithTimeout(strat.url, { headers: strat.headers }, 15000);
      if (!response.ok) {
        console.warn(`⚠️ Strategy ${strat.name} responded with status: ${response.status} ${response.statusText}`);
        continue;
      }
      const text = await response.text();
      if (!text || text.length < 200) {
        console.warn(`⚠️ Strategy ${strat.name} returned insufficient content (${text ? text.length : 0} bytes)`);
        continue;
      }

      const ipos = parseMarkdownTable(text);
      if (ipos && ipos.length > 0) {
        console.log(`✅ Strategy ${strat.name} successfully parsed ${ipos.length} IPOs!`);
        return ipos;
      } else {
        console.warn(`⚠️ Strategy ${strat.name} returned content, but 0 IPOs were parsed.`);
      }
    } catch (err) {
      console.warn(`❌ Strategy ${strat.name} failed: ${err.message}`);
    }

    // Brief cooldown before trying next proxy strategy
    if (i < strategies.length - 1) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  console.error('All proxy fetch strategies exhausted.');
  return [];
}

async function main() {
  try {
    const data = await fetchFromWeb();

    if (!data || data.length === 0) {
      console.warn('⚠️ No fresh IPOs parsed from feed. Preserving existing data.json snapshot.');
      return;
    }

    console.log(`Successfully parsed ${data.length} IPOs!`);
    console.log('Sample item:', JSON.stringify(data[0], null, 2));

    const outputPath = path.join(__dirname, 'data.json');
    const result = {
      lastUpdated: new Date().toISOString(),
      source: 'Live Market Feed',
      count: data.length,
      ipos: data
    };

    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`Saved ${data.length} IPOs to ${outputPath}`);
  } catch (err) {
    console.error('Unexpected error in main():', err);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseMarkdownTable, fetchFromWeb };
