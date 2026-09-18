// update-anchor-data.js - Standalone updater for GitHub Actions & CLI
const fs = require('fs');
const path = require('path');
const { getUnifiedExchangeIpos } = require('./merge-exchanges');

const SNAPSHOT_PATH = path.join(__dirname, 'nse-ipo-data.json');
const LOG_PATH = path.join(__dirname, 'anchor-sync-log.json');
const MAX_LOG_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days (48 hours)

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

  if (!isForce) {
    // 1. Check Weekend (Saturday & Sunday OFF)
    if (ist.isWeekend) {
      const msg = `Weekend detected (Saturday/Sunday). Market is closed. Sync is OFF. Next scheduled run: Monday at 3:00 PM IST.`;
      console.log(`[SCHEDULE] ⏸️ ${msg}`);
      recordSyncLog('SKIPPED_WEEKEND', msg, { day: ist.day, timeIST: ist.formattedDateTimeIST });
      process.exit(0);
    }

    // 2. Check Time Window (Monday - Friday: 3:00 PM to 11:00 PM IST)
    if (!ist.isWithinWindow) {
      const msg = `Outside monitoring window (Mon-Fri 3:00 PM - 11:00 PM IST). Current time: ${ist.timeStr}.`;
      console.log(`[SCHEDULE] 🌙 ${msg}`);
      recordSyncLog('SKIPPED_WINDOW', msg, { day: ist.day, timeIST: ist.formattedDateTimeIST });
      process.exit(0);
    }

    // 3. Cadence check for 15-minute windows (3pm-6pm and 10pm-11pm)
    if ((ist.isAfternoon15Min || ist.isNight15Min) && !ist.isEvening5Min) {
      const minMod15 = ist.minutes % 15;
      if (minMod15 > 3 && minMod15 < 12) {
        const msg = `15-minute cadence active for this hour (${ist.timeStr}). Skipping off-cadence trigger.`;
        console.log(`[SCHEDULE] ⏳ ${msg}`);
        recordSyncLog('SKIPPED_CADENCE', msg, { timeIST: ist.formattedDateTimeIST });
        process.exit(0);
      }
    }

    // 4. Check if all today's anchors are already received
    const anchorCheck = checkAllTodayAnchorsReceived();
    if (anchorCheck.shouldStop) {
      console.log(`[SCHEDULE] ✨ ${anchorCheck.reason}`);
      console.log(`[SCHEDULE] All required anchor files for today have arrived. Stopping further refreshes for today.`);
      recordSyncLog('SKIPPED_ALL_RECEIVED', anchorCheck.reason, { todayCount: anchorCheck.todayCount, timeIST: ist.formattedDateTimeIST });
      process.exit(0);
    } else {
      console.log(`[SCHEDULE] 🎯 Active check: ${anchorCheck.reason}`);
    }
  } else {
    console.log(`[SCHEDULE] ⚡ Force flag detected. Bypassing schedule checks.`);
  }

  console.log('[CRON] Starting automated NSE & BSE IPO and Anchor synchronization...');
  try {
    const ipos = await getUnifiedExchangeIpos();
    console.log(`[CRON] Successfully fetched ${ipos.length} unified IPOs.`);
    const anchorCount = ipos.filter(i => i.anchor && i.anchor.available).length;
    console.log(`[CRON] Found ${anchorCount} IPOs with released Anchor Allocation reports.`);

    // Record successful sync log
    const recentLogs = recordSyncLog('SUCCESS', `Synchronized ${ipos.length} unified IPOs (${anchorCount} Anchor Reports Released).`, {
      count: ipos.length,
      anchorCount,
      timeIST: ist.formattedDateTimeIST
    });

    const output = {
      lastUpdated: formatIndiaDateTime(new Date()),
      scheduleStatus: {
        lastRunIST: formatIndiaDateTime(new Date()),
        activeWindow: 'Mon-Fri 3:00 PM - 11:00 PM IST'
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
