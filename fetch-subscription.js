// fetch-subscription.js - Fast company-wise subscription parser with IP rotation and layout resilience
const fs = require('fs');
const path = require('path');
const SOURCES = require('./sources');
const { proxyRotator } = require('./proxy-rotator');


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
  if (!html) return [];
  const companies = [];

  // Split on ipo-item regardless of surrounding class names (e.g. "sp-card ipo-item" or "card-body p-0 ipo-item")
  const ipoBlocks = html.split(/class=[\"'][^\"']*ipo-item[^\"']*[\"']/i);
  if (ipoBlocks.length <= 1) {
    return [];
  }

  // Determine market type threshold
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

    const isNewLayout = /class=[\"'][^\"']*sp-ipo-name[^\"']*[\"']/i.test(block) || /class=[\"'][^\"']*sp-card[^\"']*[\"']/i.test(block);

    if (isNewLayout) {
      // --- NEW LAYOUT PARSER ---
      const nameMatch = block.match(/class=[\"'][^\"']*sp-ipo-name[^\"']*[\"']>([\s\S]*?)<\/h\d>/i);
      const companyName = nameMatch ? cleanText(nameMatch[1]) : `IPO ${ipoId}`;

      const dateMatch = block.match(/far fa-calendar-alt[\"']><\/i>\s*([^<]+)/i);
      const dates = dateMatch ? cleanText(dateMatch[1]) : '';

      const priceMatch = block.match(/fas fa-rupee-sign[\"']><\/i>\s*([^<]+)/i);
      const priceRange = priceMatch ? cleanText(priceMatch[1]) : '';

      const updatedMatch = block.match(/Last updated on\s*([0-9a-zA-Z\s\-:]+)/i) || block.match(/class=[\"'][^\"']*sp-updated-at-text[^\"']*[\"']>([^<]+)</i);
      const lastUpdated = updatedMatch ? cleanText(updatedMatch[1]) : '';

      const totalAppsMatch = block.match(/Total Applications:\s*([0-9,]+)/i);
      const totalApplications = totalAppsMatch ? parseInt(totalAppsMatch[1].replace(/,/g, ''), 10) || 0 : 0;

      const retailQtyMatch = block.match(/Retail Qty[\s\S]*?class=[\"']sp-stat-value[\"']>(\d+)</i);
      const sHniQtyMatch = block.match(/sHNI Qty[\s\S]*?class=[\"']sp-stat-value[\"']>(\d+)</i);
      const bHniQtyMatch = block.match(/bHNI Qty[\s\S]*?class=[\"']sp-stat-value[\"']>(\d+)</i);

      const retailQty = retailQtyMatch ? parseInt(retailQtyMatch[1], 10) : 0;
      const sHniQty = sHniQtyMatch ? parseInt(sHniQtyMatch[1], 10) : 0;
      const bHniQty = bHniQtyMatch ? parseInt(bHniQtyMatch[1], 10) : 0;

      // Extract tables by section
      const sharesSection = block.match(/Subscription Details[\s\S]*?<table[\s\S]*?<\/table>/i);
      const appsSection = block.match(/Application-Wise Breakup[\s\S]*?<table[\s\S]*?<\/table>/i);
      const demandSection = block.match(/Subscription Demand[\s\S]*?<table[\s\S]*?<\/table>/i);

      const sharesBreakup = [];
      let summaryTotalTimes = 0;
      let summaryQibTimes = 0;
      let summaryHniTimes = 0;
      let summaryRetailTimes = 0;

      if (sharesSection) {
        const tableMatch = sharesSection[0].match(/<table[\s\S]*?<\/table>/i);
        if (tableMatch) {
          const rows = parseTableRows(tableMatch[0]);
          for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
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
        }
      }

      const applicationsBreakup = [];
      if (appsSection) {
        const tableMatch = appsSection[0].match(/<table[\s\S]*?<\/table>/i);
        if (tableMatch) {
          const rows = parseTableRows(tableMatch[0]);
          for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (row.length >= 4) {
              const cat = row[0];
              const reserved = parseInt(row[1].replace(/,/g, ''), 10) || 0;
              const applied = parseInt(row[2].replace(/,/g, ''), 10) || 0;
              const times = parseFloat(row[3]) || 0;
              applicationsBreakup.push({ category: cat, reserved, applied, times });
            }
          }
        }
      }

      const demandBreakupCrores = [];
      if (demandSection) {
        const tableMatch = demandSection[0].match(/<table[\s\S]*?<\/table>/i);
        if (tableMatch) {
          const rows = parseTableRows(tableMatch[0]);
          for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (row.length >= 4) {
              const cat = row[0];
              const offered = parseFloat(row[1].replace(/,/g, '')) || 0;
              const applied = parseFloat(row[2].replace(/,/g, '')) || 0;
              const times = parseFloat(row[3]) || 0;
              demandBreakupCrores.push({ category: cat, offered, applied, times });
            }
          }
        }
      }

      companies.push({
        id: ipoId,
        companyName,
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

    } else {
      // --- LEGACY LAYOUT PARSER (FALLBACK) ---
      const tables = [...block.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => m[0]);
      if (tables.length < 2) continue;

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

      let lastUpdated = '';
      const updatedMatch = block.match(/Last updated on\s*([0-9a-zA-Z\s\-:]+)/i);
      if (updatedMatch) {
        lastUpdated = updatedMatch[1].trim();
      }

      let totalApplications = 0;
      const totalAppsMatch = block.match(/Total Applications:\s*([0-9,]+)/i);
      if (totalAppsMatch) {
        totalApplications = parseInt(totalAppsMatch[1].replace(/,/g, ''), 10) || 0;
      }

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
  }

  return companies;
}

async function fetchLiveSubscription() {
  const urls = [...new Set([SOURCES.SUB_DASH_URL, SOURCES.SUB_WEB_URL].filter(Boolean))];
  if (!urls.length) throw new Error('No subscription source configured.');
  const env = typeof process !== 'undefined' ? process.env || {} : {};
  const directOnly = String(env.SOURCE_DIRECT_ONLY || '').toLowerCase() === 'true';
  for (let i = 0; i < urls.length; i++) {
    try {
      const result = await proxyRotator.fetchWithRotation(urls[i],
        { timeoutMs: 20000, directOnly, maxAttempts: Number(env.SOURCE_PROXY_ATTEMPTS || 5) }, html => {
          const parsed = parseHtmlSubscription(html);
          return parsed.length > 0 && parsed.every(company =>
            company.companyName && !/^IPO \d+$/.test(company.companyName) && company.sharesBreakup.length > 0);
        });
      const companies = parseHtmlSubscription(result.text);
      console.log(`[SUBSCRIPTION] Parsed ${companies.length} companies via ${result.strategy} from ${i === 0 ? 'primary' : 'alternate'} source.`);
      return companies;
    } catch (err) {
      console.warn(`[SUBSCRIPTION] ${i === 0 ? 'Primary' : 'Alternate'} source unavailable: ${err.message}`);
    }
  }
  throw new Error('Primary and alternate subscription sources unavailable; retaining previous data.');
}

async function main() {
  try {
    const data = await fetchLiveSubscription();
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
    console.error('Error in fetch-subscription:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseHtmlSubscription, fetchLiveSubscription };
