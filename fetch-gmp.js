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

async function fetchFromWeb() {
  const cacheBustUrl = `${SOURCES.JINA_PREFIX_URL}${TARGET_URL}?t=${Date.now()}`;
  console.log('Fetching live data from feed...');
  const response = await fetch(cacheBustUrl, {
    headers: {
      'Accept': 'text/plain',
      'x-no-cache': 'true'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch from endpoint: ${response.status} ${response.statusText}`);
  }

  const markdown = await response.text();
  return parseMarkdownTable(markdown);
}

async function main() {
  try {
    const data = await fetchFromWeb();

    if (!data || data.length === 0) {
      console.warn('⚠️ No IPOs parsed from feed. Preserving existing data.json snapshot.');
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
    console.error('Error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseMarkdownTable, fetchFromWeb };
