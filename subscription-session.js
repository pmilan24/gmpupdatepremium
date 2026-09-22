// A bounded Actions session maintains cadence between delayed cron starts.
const { execFileSync } = require('child_process');
const { runSyncCycle, getMarketScheduleStatus } = require('./sync-subscription-api');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(args) {
  return execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', timeout: 30000 });
}
async function publishSnapshot() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Snapshot publishing requires GitHub Actions.');
  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
  git(['add', 'subscription-data.json']);
  if (git(['diff', '--cached', '--name-only']).trim()) {
    git(['commit', '-m', 'chore(subscription): publish minute snapshot']);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    git(['pull', '--rebase', 'origin', 'main']);
    try {
      git(['push', 'origin', 'HEAD:main']);
      console.log('[PUBLISH] Latest snapshot available in main.');
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(2000);
    }
  }
}

async function runSession({ durationMs = 300 * 60 * 1000, now = Date.now,
  wait = sleep, sync = runSyncCycle, publish = publishSnapshot,
  schedule = getMarketScheduleStatus, forceFirst = false } = {}) {
  const deadline = now() + durationMs;
  let cycles = 0, lastError = null;
  while (now() < deadline) {
    const cycleStarted = now();
    const state = schedule(new Date(cycleStarted));
    if (!state.open && !(forceFirst && cycles === 0)) break;
    lastError = null;
    try { await sync(); } catch (err) {
      lastError = err;
      console.error(`[SESSION] Sync failed: ${err.message}`);
    }
    // A valid source snapshot can still be published if backend sync failed.
    try { await publish(); } catch (err) {
      lastError = err;
      console.error(`[SESSION] Publish failed: ${err.message}`);
    }
    cycles++;
    console.log(`[SESSION] Cycle ${cycles} ${lastError ? 'failed' : 'complete'}.`);
    if (!state.open) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(remaining, Math.max(1000, state.intervalSec * 1000 - (now() - cycleStarted))));
  }
  if (lastError) throw lastError;
  return { cycles };
}
if (require.main === module) {
  runSession({ forceFirst: process.argv.includes('--force-first') }).catch(err => {
    console.error(`[SESSION] ${err.message}`);
    process.exitCode = 1;
  });
}
module.exports = { runSession };
