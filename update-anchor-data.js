// update-anchor-data.js - Standalone updater for GitHub Actions & CLI
const fs = require('fs');
const path = require('path');
const { getUnifiedExchangeIpos } = require('./merge-exchanges');
const { downloadAnchorZip, extractPdfFromZipBuffer } = require('./fetch-nse-anchor');
const { checkAndNotifyNewAnchors } = require('./notifications');

const SNAPSHOT_PATH = path.join(__dirname, 'nse-ipo-data.json');
const LOG_PATH = path.join(__dirname, 'anchor-sync-log.json');
const MAX_LOG_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days (48 hours)

async function downloadBsePdf(pdfUrl) {
  if (!pdfUrl || !pdfUrl.startsWith('http')) return null;
  const res = await fetch(pdfUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bseindia.com/'
    }
  });
  if (!res.ok) {
    throw new Error(`BSE PDF download failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || !buf.slice(0, 5).toString('latin1').startsWith('%PDF')) {
    throw new Error('BSE PDF download did not return a valid PDF');
  }
  return buf;
}

function getBseAttachmentUrl(item) {
  const anchor = item && item.anchor ? item.anchor : {};
  const candidate = anchor.bseAttachmentPdfUrl || anchor.bseIntimationPdfUrl || '';
  if (!candidate) return '';
  if (anchor.hasBseAttachment || /\/Notices\/Attach\//i.test(candidate)) {
    return candidate;
  }
  return '';
}

function formatIndiaDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(date) + ' IST';
}

function formatIndiaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

function formatIndiaTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(date) + ' IST';
}

function getISTTime() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
  const hours = parseInt(parts.hour, 10);
  const minutes = parseInt(parts.minute, 10);
  const totalMinutes = hours * 60 + minutes;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = dayNames.indexOf(parts.weekday);

  return {
    day,
    hours,
    minutes,
    totalMinutes,
    timeStr: formatIndiaTime(now),
    dateStr: formatIndiaDate(now),
    formattedDateTimeIST: formatIndiaDateTime(now),
    isWeekend: day === 0 || day === 6,
    // 3:00 PM IST (15:00 = 900) to 11:00 PM IST (23:00 = 1380)
    isWithinWindow: day >= 1 && day <= 5 && totalMinutes >= 900 && totalMinutes <= 1380,
    isAfternoon15Min: totalMinutes >= 900 && totalMinutes < 1080, // 3:00 PM - 6:00 PM
    isEvening5Min: totalMinutes >= 1080 && totalMinutes < 1320,   // 6:00 PM - 10:00 PM
    isNight15Min: totalMinutes >= 1320 && totalMinutes <= 1380    // 10:00 PM - 11:00 PM
  };
}

function checkAllTodayAnchorsReceived() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return { shouldStop: false, reason: 'No snapshot exists yet' };
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const data = JSON.parse(raw);
    const ipos = data.ipos || [];

    // Find issues where Anchor was due today
    const todayIpos = ipos.filter(i => i.anchorEligibility && i.anchorEligibility.isToday);

    if (todayIpos.length === 0) {
      return {
        shouldStop: false,
        reason: 'No IPOs specifically flagged as Due Today, proceeding with check'
      };
    }

    const pending = todayIpos.filter(i => !i.anchor || !i.anchor.available);
    if (pending.length === 0) {
      return {
        shouldStop: true,
        todayCount: todayIpos.length,
        reason: `All ${todayIpos.length} IPO(s) due today already have their Anchor Allocation reports released & verified.`
      };
    }

    return {
      shouldStop: false,
      todayCount: todayIpos.length,
      pendingCount: pending.length,
      reason: `${pending.length} of ${todayIpos.length} today's IPOs are still waiting for Anchor reports.`
    };
  } catch (e) {
    return { shouldStop: false, reason: 'Error reading snapshot' };
  }
}

/**
 * Append run log entry and prune any entries older than 2 days (48 hours)
 */
function recordSyncLog(status, message, details = {}) {
  const now = new Date();
  const timestampIST = formatIndiaDateTime(now);
  const dateStr = formatIndiaDate(now);
  const timeStr = formatIndiaTime(now);

  const entry = {
    timestampIST,
    epochMs: now.getTime(),
    istDate: dateStr,
    istTime: timeStr,
    status, // 'SUCCESS' | 'SKIPPED_WEEKEND' | 'SKIPPED_WINDOW' | 'SKIPPED_CADENCE' | 'SKIPPED_ALL_RECEIVED' | 'ERROR'
    message,
    details
  };

  let logs = [];
  if (fs.existsSync(LOG_PATH)) {
    try {
      logs = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
      if (!Array.isArray(logs)) logs = [];
    } catch (e) {
      logs = [];
    }
  }

  // Prepend latest entry (newest first)
  logs.unshift(entry);

  // Prune entries older than 2 days (48 hours)
  const cutoff = Date.now() - MAX_LOG_AGE_MS;
  const initialCount = logs.length;
  logs = logs.filter(item => {
    const ts = item.epochMs || (item.timestamp ? new Date(item.timestamp).getTime() : 0);
    return !isNaN(ts) && ts >= cutoff;
  });

  const prunedCount = initialCount - logs.length;
  if (prunedCount > 0) {
    console.log(`[LOG] Pruned ${prunedCount} old log entries older than 48 hours.`);
  }

  // Cap at 150 entries maximum
  if (logs.length > 150) {
    logs = logs.slice(0, 150);
  }

  try {
    fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2));
    console.log(`[LOG] Recorded sync log: [${status}] ${message} (Total active in 48h: ${logs.length})`);
  } catch (err) {
    console.warn('[LOG] Failed to save log:', err.message);
  }

  return logs;
}

async function main() {
  const isForce = process.argv.includes('--force') || process.env.FORCE_SYNC === 'true';
  const ist = getISTTime();

  console.log(`[SCHEDULE] Current IST: ${ist.formattedDateTimeIST} (Day ${ist.day})`);

  let activeCadence = 'Manual / Forced Run';

  if (!isForce) {
    // 1. Check Weekend (Saturday & Sunday OFF)
    if (ist.isWeekend) {
      const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][ist.day];
      const msg = `Weekend detected (${dayName}). Market is closed. Saturday & Sunday sync is OFF. Next scheduled run: Monday at 3:00 PM IST.`;
      console.log(`[SCHEDULE] 🛑 ${msg}`);
      recordSyncLog('SKIPPED_WEEKEND', msg, { day: ist.day, timeIST: ist.formattedDateTimeIST, cadence: 'OFF (Weekend)' });
      process.exit(0);
    }

    // 2. Check Time Window (Monday - Friday: 3:00 PM to 11:00 PM IST)
    if (!ist.isWithinWindow) {
      const msg = `Outside monitoring window (Mon-Fri 3:00 PM - 11:00 PM IST). Current time: ${ist.timeStr}. Sync is OFF. Window opens at 3:00 PM IST.`;
      console.log(`[SCHEDULE] 🌙 ${msg}`);
      recordSyncLog('SKIPPED_WINDOW', msg, { day: ist.day, timeIST: ist.formattedDateTimeIST, cadence: 'OFF (Outside Window)' });
      process.exit(0);
    }

    // Determine Active Cadence
    if (ist.isEvening5Min) {
      activeCadence = '5 min Peak Cadence (6:00 PM - 10:00 PM IST)';
    } else if (ist.isAfternoon15Min) {
      activeCadence = '15 min Afternoon Cadence (3:00 PM - 6:00 PM IST)';
    } else if (ist.isNight15Min) {
      activeCadence = '15 min Night Cadence (10:00 PM - 11:00 PM IST)';
    }

    const anchorCheck = checkAllTodayAnchorsReceived();
    console.log(`[SCHEDULE] 🎯 Active check: ${anchorCheck.reason}`);
  } else {
    console.log(`[SCHEDULE] ⚡ Force flag detected. Bypassing schedule checks.`);
  }

  console.log(`[SCHEDULE] 🚀 Starting sync with cadence: ${activeCadence}`);
  console.log('[CRON] Starting automated NSE & BSE IPO and Anchor synchronization...');
  try {
    const ipos = await getUnifiedExchangeIpos();
    console.log(`[CRON] Successfully fetched ${ipos.length} unified IPOs.`);
    const anchorCount = ipos.filter(i => i.anchor && i.anchor.available).length;
    console.log(`[CRON] Found ${anchorCount} IPOs with released Anchor Allocation reports.`);

    // Ensure extracted PDF exists in ./anchors for all available NSE anchors
    const anchorsDir = path.join(__dirname, 'anchors');
    if (!fs.existsSync(anchorsDir)) {
      fs.mkdirSync(anchorsDir, { recursive: true });
    }

    for (const item of ipos) {
      if (!item.anchor || !item.symbol) continue;

      const targetPdfPath = path.join(anchorsDir, `ANCHOR_${item.symbol.toUpperCase()}.pdf`);
      const bseAttachmentUrl = getBseAttachmentUrl(item);

      if (bseAttachmentUrl && (!fs.existsSync(targetPdfPath) || item.anchor.source === 'BSE')) {
        try {
          console.log(`[ANCHOR] Downloading BSE attachment PDF for ${item.symbol}...`);
          const pdfBuffer = await downloadBsePdf(bseAttachmentUrl);
          if (pdfBuffer && pdfBuffer.length > 0) {
            fs.writeFileSync(targetPdfPath, pdfBuffer);
            console.log(`[ANCHOR] ✅ Saved BSE attachment PDF: ${targetPdfPath} (${pdfBuffer.length} bytes)`);
          }
          continue;
        } catch (e) {
          console.warn(`[ANCHOR] Could not download BSE attachment for ${item.symbol}:`, e.message);
        }
      }

      if (item.anchor.nseZipUrl && !fs.existsSync(targetPdfPath)) {
        try {
          console.log(`[ANCHOR] Downloading & extracting NSE PDF for ${item.symbol}...`);
          const zipBuffer = await downloadAnchorZip(item.anchor.nseZipUrl, item.symbol);
          if (zipBuffer) {
            const pdfBuffer = extractPdfFromZipBuffer(zipBuffer);
            if (pdfBuffer && pdfBuffer.length > 0) {
              fs.writeFileSync(targetPdfPath, pdfBuffer);
              console.log(`[ANCHOR] ✅ Saved extracted NSE PDF: ${targetPdfPath} (${pdfBuffer.length} bytes)`);
            }
          }
        } catch (e) {
          console.warn(`[ANCHOR] Could not extract NSE PDF for ${item.symbol}:`, e.message);
        }
      }
    }

    // Check for newly released Anchor reports and trigger instant Telegram & NTFY alerts
    const alerts = await checkAndNotifyNewAnchors(ipos);
    const sentAlerts = alerts.filter(a => a.telegram && a.telegram.success);
    const failedAlerts = alerts.filter(a => a.retryPending || (a.telegram && !a.telegram.success));
    if (sentAlerts.length > 0) {
      console.log(`[NOTIFY] 🚀 Dispatched instant Telegram notifications for ${sentAlerts.length} new Anchor report(s)!`);
    }
    if (failedAlerts.length > 0) {
      console.warn(`[NOTIFY] ⚠️ ${failedAlerts.length} Telegram alert(s) failed and will retry on next run.`);
    }

    // Record successful sync log
    const recentLogs = recordSyncLog('SUCCESS', `Synchronized ${ipos.length} unified IPOs (${anchorCount} Anchor Reports Released) [${activeCadence}].`, {
      count: ipos.length,
      anchorCount,
      activeCadence,
      telegramSentCount: sentAlerts.length,
      telegramFailedCount: failedAlerts.length,
      timeIST: ist.formattedDateTimeIST
    });

    const output = {
      lastUpdated: formatIndiaDateTime(new Date()),
      scheduleStatus: {
        lastRunIST: formatIndiaDateTime(new Date()),
        activeCadence,
        activeWindow: 'Mon-Fri 3:00 PM - 11:00 PM IST (Saturday & Sunday OFF)',
        isWeekend: ist.isWeekend
      },
      count: ipos.length,
      anchorCount,
      recentLogs: recentLogs.slice(0, 15), // Embed latest 15 logs for fast UI inspection
      ipos
    };

    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(output, null, 2));
    console.log(`[CRON] Saved fresh data to ${SNAPSHOT_PATH}`);
  } catch (err) {
    console.error('[CRON] Error updating anchor data:', err.message);
    recordSyncLog('ERROR', `Sync error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, getISTTime, checkAllTodayAnchorsReceived, recordSyncLog };
