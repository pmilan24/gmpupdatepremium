// update-anchor-data.js - Standalone updater for GitHub Actions & CLI
const fs = require('fs');
const path = require('path');
const { getUnifiedExchangeIpos } = require('./merge-exchanges');

async function main() {
  console.log('[CRON] Starting automated NSE & BSE IPO and Anchor synchronization...');
  try {
    const ipos = await getUnifiedExchangeIpos();
    console.log(`[CRON] Successfully fetched ${ipos.length} unified IPOs.`);
    const anchorCount = ipos.filter(i => i.anchor && i.anchor.available).length;
    console.log(`[CRON] Found ${anchorCount} IPOs with released Anchor Allocation reports.`);

    const output = {
      lastUpdated: new Date().toISOString(),
      count: ipos.length,
      anchorCount,
      ipos
    };

    const filePath = path.join(__dirname, 'nse-ipo-data.json');
    fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
    console.log(`[CRON] Saved fresh data to ${filePath}`);
  } catch (err) {
    console.error('[CRON] Error updating anchor data:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
