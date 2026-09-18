// fetch-subscription.js - Fast company-wise subscription parser for dash.ipopremium.in
const fs = require('fs');
const path = require('path');

const DASH_INAPP_URL = 'https://dash.ipopremium.in/view/subscription?inapp=true';
const JINA_FALLBACK_URL = 'https://r.jina.ai/https://www.ipopremium.in/view/subscription';

function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#8377;/g, '₹')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTableRows(tableHtml) {
  if (!tableHtml) return [];
  const rows = [];
  const trMatches = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)];
  
  for (const tr of trMatches) {
    const cells = [...tr[0].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(c => cleanText(c[1]));
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

function parseHtmlSubscription(html) {
  const companies = [];
  const ipoBlocks = html.split(/class=[\"']card-body p-0 ipo-item[\"']/i);
  
  // Determine if block belongs to Mainboard or SME based on location relative to headings
  const mainboardIndex = html.indexOf('Mainboard');
  const smeIndex = html.indexOf('SME');

  for (let i = 1; i < ipoBlocks.length; i++) {
    const block = ipoBlocks[i];
    const blockGlobalPos = html.indexOf(block);
    let marketType = 'Mainboard';
    if (smeIndex !== -1 && blockGlobalPos > smeIndex) {
      marketType = 'SME';
    }

    const idMatch = block.match(/data-id=[\"'](\d+)[\"']/i);
    const ipoId = idMatch ? idMatch[1] : `ipo-${i}`;

    const tables = [...block.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => m[0]);
    if (tables.length < 2) continue;

    // Table 1: Header (Company Name, Date, Price, Quantities)
    const t1Rows = parseTableRows(tables[0]);
    let companyName = '';
    let dates = '';
    let priceRange = '';
    let retailQty = 0;
    let sHniQty = 0;
    let bHniQty = 0;

    if (t1Rows.length > 0 && t1Rows[0].length > 0) {
      companyName = t1Rows[0][0];
    }
    if (t1Rows.length > 1) {
      const r1 = t1Rows[1];
      if (r1.length >= 2) {
        dates = r1[0].replace(/^Date:\s*/i, '').trim();
        priceRange = r1[1].trim();
      } else if (r1.length === 1) {
        const line = r1[0];
        const dateMatch = line.match(/Date:\s*([^₹]+)/i);
        const priceMatch = line.match(/(₹.*)/i);
        if (dateMatch) dates = dateMatch[1].trim();
        if (priceMatch) priceRange = priceMatch[1].trim();
      }
    }
    // Look for quantities row
    for (let r = 2; r < t1Rows.length; r++) {
      const rowText = t1Rows[r].join(' ');
      const nums = rowText.match(/\d+/g);
      if (nums && nums.length >= 3) {
        retailQty = parseInt(nums[0], 10) || 0;
        sHniQty = parseInt(nums[1], 10) || 0;
        bHniQty = parseInt(nums[2], 10) || 0;
        break;
      }
    }

    // Last updated footer
    let lastUpdated = '';
    const updatedMatch = block.match(/Last updated on\s*([0-9a-zA-Z\s\-:]+)/i);
    if (updatedMatch) {
      lastUpdated = updatedMatch[1].trim();
    }

    // Total applications
    let totalApplications = 0;
    const totalAppsMatch = block.match(/Total Applications:\s*([0-9,]+)/i);
    if (totalAppsMatch) {
      totalApplications = parseInt(totalAppsMatch[1].replace(/,/g, ''), 10) || 0;
    }

    // Table 2: Subscription Details (No. of Shares)
    const t2Rows = parseTableRows(tables[1]);
    const sharesBreakup = [];
    let summaryTotalTimes = 0;
    let summaryQibTimes = 0;
    let summaryHniTimes = 0;
    let summaryRetailTimes = 0;

    for (let r = 1; r < t2Rows.length; r++) {
      const row = t2Rows[r];
      if (row.length >= 4) {
        const cat = row[0];
        const offered = parseInt(row[1].replace(/,/g, ''), 10) || 0;
        const applied = parseInt(row[2].replace(/,/g, ''), 10) || 0;
        const times = parseFloat(row[3]) || 0;

        sharesBreakup.push({ category: cat, offered, applied, times });

        if (/total/i.test(cat)) summaryTotalTimes = times;
        else if (/qib/i.test(cat)) summaryQibTimes = times;
        else if (/^hnis?$/i.test(cat)) summaryHniTimes = times;
        else if (/retail/i.test(cat)) summaryRetailTimes = times;
      }
    }

    // Table 3: Application-Wise Breakup
    const applicationsBreakup = [];
    if (tables.length >= 3) {
      const t3Rows = parseTableRows(tables[2]);
      for (let r = 1; r < t3Rows.length; r++) {
        const row = t3Rows[r];
        if (row.length >= 4) {
          const cat = row[0];
          const reserved = parseInt(row[1].replace(/,/g, ''), 10) || 0;
          const applied = parseInt(row[2].replace(/,/g, ''), 10) || 0;
          const times = parseFloat(row[3]) || 0;
          applicationsBreakup.push({ category: cat, reserved, applied, times });
        }
      }
    }

    // Table 4: Demand in ₹ Crore
    const demandBreakupCrores = [];
    if (tables.length >= 4) {
      const t4Rows = parseTableRows(tables[3]);
      for (let r = 1; r < t4Rows.length; r++) {
        const row = t4Rows[r];
        if (row.length >= 4) {
          const cat = row[0];
          const offered = parseFloat(row[1].replace(/,/g, '')) || 0;
          const applied = parseFloat(row[2].replace(/,/g, '')) || 0;
          const times = parseFloat(row[3]) || 0;
          demandBreakupCrores.push({ category: cat, offered, applied, times });
        }
      }
    }

    companies.push({
      id: ipoId,
      companyName: companyName || `IPO ${ipoId}`,
      marketType,
      dates,
      priceRange,
      quantities: {
        retail: retailQty,
        sHNI: sHniQty,
        bHNI: bHniQty
      },
      lastUpdatedSource: lastUpdated,
      totalApplications,
      summary: {
        totalTimes: summaryTotalTimes,
        qibTimes: summaryQibTimes,
        hniTimes: summaryHniTimes,
        retailTimes: summaryRetailTimes
      },
      sharesBreakup,
      applicationsBreakup,
      demandBreakupCrores
    });
  }

  return companies;
}

async function fetchLiveSubscription() {
  const cacheBust = Date.now();
  const directUrl = `${DASH_INAPP_URL}&_t=${cacheBust}`;
  console.log(`[SUBSCRIPTION] Fetching from direct endpoint: ${directUrl}`);

  try {
    const res = await fetch(directUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
      }
    });

    if (res.ok) {
      const html = await res.text();
      const parsed = parseHtmlSubscription(html);
      if (parsed && parsed.length > 0) {
        console.log(`[SUBSCRIPTION] Successfully parsed ${parsed.length} companies from direct endpoint!`);
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[SUBSCRIPTION] Direct endpoint failed, trying fallback...', err.message);
  }

  // Fallback via Jina reader
  const jinaUrl = `${JINA_FALLBACK_URL}?_t=${cacheBust}`;
  console.log(`[SUBSCRIPTION] Fetching from fallback: ${jinaUrl}`);
  const fallbackRes = await fetch(jinaUrl, {
    headers: { 'Accept': 'text/plain', 'x-no-cache': 'true' }
  });
  if (!fallbackRes.ok) {
    throw new Error(`Fallback fetch failed: ${fallbackRes.status}`);
  }
  const text = await fallbackRes.text();
  // Fallback markdown parsing logic if needed
  return [];
}

async function main() {
  try {
    let data;
    if (fs.existsSync('/tmp/subscription_raw.html')) {
      console.log('Testing with saved /tmp/subscription_raw.html...');
      const html = fs.readFileSync('/tmp/subscription_raw.html', 'utf8');
      data = parseHtmlSubscription(html);
    } else {
      data = await fetchLiveSubscription();
    }

    console.log(`Successfully extracted ${data.length} companies!`);
    console.log('Sample Company:', JSON.stringify(data[0], null, 2));

    const outputPath = path.join(__dirname, 'subscription-data.json');
    const result = {
      lastUpdated: new Date().toISOString(),
      count: data.length,
      companies: data
    };

    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`Saved output to ${outputPath}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseHtmlSubscription, fetchLiveSubscription };
