// Local Mac runner: scrape, update backend, commit the snapshot, and push main.
const { execFileSync } = require('child_process');
const { runSyncCycle, getMarketScheduleStatus } = require('./sync-subscription-api');
const { refreshProxyCache } = require('./manage-source-proxies');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(args) {
  return execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', timeout: 60000 });
}

function hasStagedChanges() {
  return git(['diff', '--cached', '--name-only']).trim().length > 0;
}

async function publishSnapshot() {
  git(['add', 'subscription-data.json']);
  if (!hasStagedChanges()) {
    console.log('[LOCAL] Snapshot unchanged; nothing to push.');
    return false;
  }
  git(['commit', '-m', 'chore(subscription): publish local snapshot']);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      git(['pull', '--rebase', 'origin', 'main']);
      git(['push', 'origin', 'HEAD:main']);
      console.log('[LOCAL] Snapshot pushed to GitHub main.');
      return true;
    } catch (err) {
      console.warn(`[LOCAL] Git push attempt ${attempt} failed.`);
      if (attempt === 3) throw err;
      await sleep(3000);
    }
  }
  return false;
}

async function maybeRefreshProxyCache(lastRefreshAt) {
  const intervalMs = Number(process.env.SOURCE_PROXY_REFRESH_MINUTES || 30) * 60 * 1000;
  if (process.env.SOURCE_DIRECT_ONLY === 'true') return lastRefreshAt;
  if (Date.now() - lastRefreshAt < intervalMs) return lastRefreshAt;
  try {
    await refreshProxyCache();
    return Date.now();
  } catch (err) {
    console.warn(`[LOCAL] Proxy refresh failed: ${err.message}`);
    return lastRefreshAt || Date.now();
  }
}

async function runLocalDaemon({ once = false, force = false } = {}) {
  let lastProxyRefreshAt = 0;
  console.log('[LOCAL] Starting Mac subscription runner.');
  while (true) {
    const cycleStarted = Date.now();
    const state = getMarketScheduleStatus(new Date(cycleStarted));
    if (!force && !state.open) {
      console.log(`[LOCAL] ${state.reason}`);
      if (once) return;
      await sleep(state.intervalSec * 1000);
      continue;
    }

    lastProxyRefreshAt = await maybeRefreshProxyCache(lastProxyRefreshAt);
    try {
      await runSyncCycle();
      await publishSnapshot();
      console.log('[LOCAL] Cycle complete.');
    } catch (err) {
      console.error(`[LOCAL] Cycle failed: ${err.message}`);
      if (once) throw err;
    }

    if (once) return;
    const elapsed = Date.now() - cycleStarted;
    await sleep(Math.max(1000, state.intervalSec * 1000 - elapsed));
  }
}

if (require.main === module) {
  runLocalDaemon({
    once: process.argv.includes('--once'),
    force: process.argv.includes('--force')
  }).catch(err => {
    console.error(`[LOCAL] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runLocalDaemon, publishSnapshot };
