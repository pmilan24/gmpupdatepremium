// subscription.js - Live Company-Wise Subscription Tracker & Instant Change Webhook Dispatcher
(function () {
  'use strict';

  const SUBS_STORAGE_KEY = 'ipo_subscription_history_v1';
  const WEBHOOK_CONFIG_KEY = 'ipo_subscription_webhook_config_v1';
  const SUBSCRIPTION_URL = './subscription-data.json';

  // State
  let companiesList = [];
  let storageHistory = loadStorage();
  let webhookConfig = loadWebhookConfig();
  let currentFilter = 'all';
  let searchQuery = '';
  let refreshIntervalSeconds = 60; // 1 min default for live market subscription
  let secondsRemaining = refreshIntervalSeconds;
  let countdownTimer = null;
  let isFetching = false;
  let soundEnabled = true;

  // DOM Elements
  const els = {
    subsGrid: document.getElementById('subsGrid'),
    lastUpdatedText: document.getElementById('lastUpdatedText'),
    countdownText: document.getElementById('countdownText'),
    countdownFill: document.getElementById('countdownFill'),
    refreshBtn: document.getElementById('refreshBtn'),
    refreshIcon: document.getElementById('refreshIcon'),
    intervalSelect: document.getElementById('intervalSelect'),
    searchInput: document.getElementById('searchInput'),
    filterChips: document.querySelectorAll('.chip[data-filter]'),
    sortSelect: document.getElementById('sortSelect'),
    soundToggleBtn: document.getElementById('soundToggleBtn'),
    soundIcon: document.getElementById('soundIcon'),
    simulateBtn: document.getElementById('simulateBtn'),
    apiSettingsBtn: document.getElementById('apiSettingsBtn'),
    apiModal: document.getElementById('apiModal'),
    closeModalBtn: document.getElementById('closeModalBtn'),
    apiForm: document.getElementById('apiForm'),
    apiUrlInput: document.getElementById('apiUrlInput'),
    apiHeadersInput: document.getElementById('apiHeadersInput'),
    apiAutoSendCheckbox: document.getElementById('apiAutoSendCheckbox'),
    testApiBtn: document.getElementById('testApiBtn'),
    apiStatusMsg: document.getElementById('apiStatusMsg'),
    payloadPreview: document.getElementById('payloadPreview'),
    statTotal: document.getElementById('statTotal'),
    statChanged: document.getElementById('statChanged'),
    statHighest: document.getElementById('statHighest'),
    statTotalApps: document.getElementById('statTotalApps'),
    alertBanner: document.getElementById('alertBanner'),
    alertBannerCount: document.getElementById('alertBannerCount')
  };

  function loadStorage() {
    try {
      return JSON.parse(localStorage.getItem(SUBS_STORAGE_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveStorage() {
    try {
      localStorage.setItem(SUBS_STORAGE_KEY, JSON.stringify(storageHistory));
    } catch (e) {}
  }

  function loadWebhookConfig() {
    try {
      return JSON.parse(localStorage.getItem(WEBHOOK_CONFIG_KEY) || JSON.stringify({
        url: '',
        headers: '{\n  "Content-Type": "application/json"\n}',
        autoSendOnChange: true
      }));
    } catch (e) {
      return { url: '', headers: '{\n  "Content-Type": "application/json"\n}', autoSendOnChange: true };
    }
  }

  function saveWebhookConfig() {
    try {
      localStorage.setItem(WEBHOOK_CONFIG_KEY, JSON.stringify(webhookConfig));
    } catch (e) {}
  }

  function playChime() {
    if (!soundEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, now); // E5
      osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.2); // C6

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } catch (e) {}
  }

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
      if (cells.length > 0) rows.push(cells);
    }
    return rows;
  }

  // Parse HTML string from live subscription feed
  function parseSubscriptionHtml(html) {
    const companies = [];
    const ipoBlocks = html.split(/class=[\"']card-body p-0 ipo-item[\"']/i);
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

      // Table 1: Header details
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
      if (updatedMatch) lastUpdated = updatedMatch[1].trim();

      let totalApplications = 0;
      const totalAppsMatch = block.match(/Total Applications:\s*([0-9,]+)/i);
      if (totalAppsMatch) totalApplications = parseInt(totalAppsMatch[1].replace(/,/g, ''), 10) || 0;

      // Table 2: Shares breakup
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

      // Table 3: Applications breakup
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

      // Table 4: Demand (Cr)
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
        quantities: { retail: retailQty, sHNI: sHniQty, bHNI: bHniQty },
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

  // Fetch Live Subscription Data
  async function fetchSubscriptionData() {
    if (isFetching) return;
    isFetching = true;
    updateRefreshButton(true);

    let parsedCompanies = null;
    let source = '';

    try {
      const cacheBust = Date.now() + '_' + Math.floor(Math.random() * 10000);
      const localRes = await fetch(`${SUBSCRIPTION_URL}?_t=${cacheBust}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      if (localRes.ok) {
        const json = await localRes.json();
        parsedCompanies = json.companies || json;
        source = 'Live Exchange Feed';
      }

      if (!parsedCompanies || parsedCompanies.length === 0) {
        if (storageState && storageState.items && Object.keys(storageState.items).length > 0) {
          parsedCompanies = Object.values(storageState.items);
          source = 'Offline Cache';
        } else {
          throw new Error('Unable to retrieve subscription data.');
        }
      }

      processSubscriptionDiff(parsedCompanies);
      renderUI();

      if (els.lastUpdatedText) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        els.lastUpdatedText.textContent = `${timeStr} · ${source}`;
      }

    } catch (err) {
      console.error('Subscription fetch error:', err);
      if (els.lastUpdatedText) {
        els.lastUpdatedText.textContent = `Error: ${err.message}. Retrying...`;
        els.lastUpdatedText.style.color = '#f87171';
      }
    } finally {
      isFetching = false;
      updateRefreshButton(false);
      resetCountdown();
    }
  }

  // Diffing against stored history & Instant Webhook Trigger
  function processSubscriptionDiff(newCompanies) {
    const changedCompanies = [];
    const isFirstRun = Object.keys(storageHistory).length === 0;

    newCompanies.forEach(comp => {
      const stored = storageHistory[comp.id];
      const currentTimes = comp.summary.totalTimes;
      const currentRetail = comp.summary.retailTimes;
      const currentApps = comp.totalApplications;

      if (!stored) {
        storageHistory[comp.id] = {
          totalTimes: currentTimes,
          retailTimes: currentRetail,
          totalApplications: currentApps,
          lastChangedAt: Date.now(),
          previousTimes: currentTimes,
          isRead: true
        };
        comp.state = { isChanged: false, diffTimes: 0, isRead: true };
      } else {
        const diff = +(currentTimes - stored.totalTimes).toFixed(2);
        const appsDiff = currentApps - stored.totalApplications;

        if (diff !== 0 || appsDiff !== 0) {
          comp.state = {
            isChanged: true,
            diffTimes: diff,
            previousTimes: stored.totalTimes,
            previousApps: stored.totalApplications,
            isRead: false
          };
          // Update stored
          stored.previousTimes = stored.totalTimes;
          stored.totalTimes = currentTimes;
          stored.retailTimes = currentRetail;
          stored.totalApplications = currentApps;
          stored.lastChangedAt = Date.now();
          stored.isRead = false;

          changedCompanies.push(comp);
        } else {
          comp.state = {
            isChanged: !stored.isRead,
            diffTimes: +(currentTimes - (stored.previousTimes || currentTimes)).toFixed(2),
            previousTimes: stored.previousTimes || currentTimes,
            isRead: stored.isRead !== false
          };
        }
      }
    });

    saveStorage();
    companiesList = newCompanies;

    if (changedCompanies.length > 0) {
      playChime();
      // Trigger Instant Webhook if configured!
      if (webhookConfig.autoSendOnChange && webhookConfig.url) {
        dispatchWebhook(changedCompanies, 'live_subscription_change');
      }
    }
  }

  // Webhook Dispatcher
  async function dispatchWebhook(companiesToSend, eventType) {
    if (!webhookConfig.url) return;

    const payload = {
      event: eventType || 'subscription_update',
      timestamp: new Date().toISOString(),
      source: 'Live Exchange Feed',
      count: companiesToSend.length,
      companies: companiesToSend
    };

    let parsedHeaders = { 'Content-Type': 'application/json' };
    try {
      if (webhookConfig.headers) {
        parsedHeaders = JSON.parse(webhookConfig.headers);
      }
    } catch (e) {}

    console.log(`[WEBHOOK] Dispatching ${companiesToSend.length} updated company subscriptions to:`, webhookConfig.url);

    try {
      const response = await fetch(webhookConfig.url, {
        method: 'POST',
        headers: parsedHeaders,
        body: JSON.stringify(payload)
      });
      console.log('[WEBHOOK] Response status:', response.status);
      return { success: true, status: response.status };
    } catch (err) {
      console.warn('[WEBHOOK] Failed to dispatch payload:', err.message);
      return { success: false, error: err.message };
    }
  }

  // Render UI
  function renderUI() {
    updateStats();
    renderCards();
    updatePayloadPreview();
  }

  function updateStats() {
    if (els.statTotal) els.statTotal.textContent = companiesList.length;

    let changedCount = 0;
    let highestTimes = 0;
    let highestName = '—';
    let totalApps = 0;

    companiesList.forEach(c => {
      if (c.state && c.state.isChanged && !c.state.isRead) {
        changedCount++;
      }
      if (c.summary.totalTimes > highestTimes) {
        highestTimes = c.summary.totalTimes;
        highestName = c.companyName;
      }
      totalApps += c.totalApplications || 0;
    });

    if (els.statChanged) els.statChanged.textContent = changedCount;
    if (els.statHighest) {
      els.statHighest.textContent = highestTimes > 0 ? `${highestTimes.toFixed(2)}x` : '—';
    }
    if (els.statTotalApps) {
      els.statTotalApps.textContent = totalApps > 0 ? totalApps.toLocaleString('en-IN') : '—';
    }

    if (els.alertBanner && els.alertBannerCount) {
      if (changedCount > 0) {
        els.alertBanner.style.display = 'flex';
        els.alertBannerCount.textContent = changedCount;
      } else {
        els.alertBanner.style.display = 'none';
      }
    }

    const changedChip = document.querySelector('.chip[data-filter="changed"]');
    if (changedChip) {
      changedChip.textContent = `🔥 Changed (${changedCount})`;
      if (changedCount > 0) changedChip.classList.add('chip-alert');
      else changedChip.classList.remove('chip-alert');
    }
  }

  function getFilteredCompanies() {
    let list = [...companiesList];

    if (currentFilter === 'changed') {
      list = list.filter(c => c.state && c.state.isChanged && !c.state.isRead);
    } else if (currentFilter === 'mainboard') {
      list = list.filter(c => c.marketType.toLowerCase() === 'mainboard');
    } else if (currentFilter === 'sme') {
      list = list.filter(c => c.marketType.toLowerCase() === 'sme');
    } else if (currentFilter === 'oversubscribed') {
      list = list.filter(c => c.summary.totalTimes >= 1);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c =>
        c.companyName.toLowerCase().includes(q) ||
        c.dates.toLowerCase().includes(q) ||
        c.priceRange.toLowerCase().includes(q)
      );
    }

    const sortVal = els.sortSelect ? els.sortSelect.value : 'default';
    switch (sortVal) {
      case 'times-desc':
        list.sort((a, b) => b.summary.totalTimes - a.summary.totalTimes);
        break;
      case 'times-asc':
        list.sort((a, b) => a.summary.totalTimes - b.summary.totalTimes);
        break;
      case 'apps-desc':
        list.sort((a, b) => b.totalApplications - a.totalApplications);
        break;
      case 'name-asc':
        list.sort((a, b) => a.companyName.localeCompare(b.companyName));
        break;
      default:
        break;
    }

    return list;
  }

  function renderCards() {
    if (!els.subsGrid) return;
    const items = getFilteredCompanies();

    if (items.length === 0) {
      els.subsGrid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 60px 20px; text-align: center; color: var(--text-muted);">
          <p>No companies found matching your search or filter.</p>
        </div>
      `;
      return;
    }

    let html = '';
    items.forEach(c => {
      const isUnread = c.state && c.state.isChanged && !c.state.isRead;
      const cardClass = isUnread ? 'subs-card changed' : 'subs-card';
      const badgeClass = isUnread ? 'subs-times-badge changed' : 'subs-times-badge';

      // Meter percentages (cap at 100% for progress visual, but display exact times)
      const qibW = Math.min(100, Math.max(0, c.summary.qibTimes * 10));
      const hniW = Math.min(100, Math.max(0, c.summary.hniTimes * 10));
      const retailW = Math.min(100, Math.max(0, c.summary.retailTimes * 10));

      // Table 1: Shares rows
      let sharesHtml = '';
      (c.sharesBreakup || []).forEach(s => {
        sharesHtml += `
          <tr>
            <td><strong>${s.category}</strong></td>
            <td>${s.offered ? s.offered.toLocaleString('en-IN') : '—'}</td>
            <td>${s.applied ? s.applied.toLocaleString('en-IN') : '—'}</td>
            <td><strong style="color: #34d399;">${s.times}x</strong></td>
          </tr>
        `;
      });

      // Table 2: Applications rows
      let appsHtml = '';
      (c.applicationsBreakup || []).forEach(a => {
        appsHtml += `
          <tr>
            <td><strong>${a.category}</strong></td>
            <td>${a.reserved ? a.reserved.toLocaleString('en-IN') : '—'}</td>
            <td>${a.applied ? a.applied.toLocaleString('en-IN') : '—'}</td>
            <td><strong style="color: #60a5fa;">${a.times}x</strong></td>
          </tr>
        `;
      });

      // Table 3: Demand rows
      let demandHtml = '';
      (c.demandBreakupCrores || []).forEach(d => {
        demandHtml += `
          <tr>
            <td><strong>${d.category}</strong></td>
            <td>${d.offered ? `₹${d.offered} Cr` : '—'}</td>
            <td>${d.applied ? `₹${d.applied} Cr` : '—'}</td>
            <td><strong>${d.times ? `${d.times}x` : '—'}</strong></td>
          </tr>
        `;
      });

      html += `
        <div class="${cardClass}" data-id="${c.id}">
          <div class="subs-card-header">
            <div>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <h3 class="subs-card-title">${c.companyName}</h3>
                <span class="badge-tag ${c.marketType === 'Mainboard' ? 'badge-mainboard' : 'badge-sme'}">${c.marketType}</span>
              </div>
              <div class="subs-card-meta">
                ${c.dates ? `📅 ${c.dates}` : ''} ${c.priceRange ? `· 💰 ${c.priceRange}` : ''}
              </div>
              <div class="subs-card-meta" style="font-size: 0.7rem; color: #9ca3af; margin-top: 2px;">
                ${c.lastUpdatedSource ? `⏱ Source: ${c.lastUpdatedSource}` : ''}
              </div>
            </div>

            <div class="${badgeClass}" title="Total subscription multiple">
              <span class="subs-times-label">Total Subscribed</span>
              ${c.summary.totalTimes.toFixed(2)}x
              ${isUnread ? `<div style="font-size: 0.65rem; color: #fbbf24; cursor: pointer;" onclick="window.markSubsRead('${c.id}')">✓ Click to dismiss</div>` : ''}
            </div>
          </div>

          <!-- Meters -->
          <div class="subs-meters">
            <div class="meter-item">
              <span class="meter-label">QIB</span>
              <span class="meter-val">${c.summary.qibTimes.toFixed(2)}x</span>
              <div class="meter-bar"><div class="meter-fill qib" style="width: ${qibW}%;"></div></div>
            </div>
            <div class="meter-item">
              <span class="meter-label">HNI / NII</span>
              <span class="meter-val">${c.summary.hniTimes.toFixed(2)}x</span>
              <div class="meter-bar"><div class="meter-fill hni" style="width: ${hniW}%;"></div></div>
            </div>
            <div class="meter-item">
              <span class="meter-label">Retail</span>
              <span class="meter-val">${c.summary.retailTimes.toFixed(2)}x</span>
              <div class="meter-bar"><div class="meter-fill retail" style="width: ${retailW}%;"></div></div>
            </div>
          </div>

          <!-- Lots and Applications Row -->
          <div class="subs-lots-row">
            <div>
              Retail Qty: <strong>${c.quantities.retail || '—'}</strong> · 
              sHNI: <strong>${c.quantities.sHNI || '—'}</strong> · 
              bHNI: <strong>${c.quantities.bHNI || '—'}</strong>
            </div>
            <div>
              Total Apps: <strong>${c.totalApplications ? c.totalApplications.toLocaleString('en-IN') : '—'}</strong>
            </div>
          </div>

          <!-- Collapsible Breakdown Accordion -->
          <button class="subs-details-toggle" onclick="window.toggleSubsDetails('${c.id}')">
            <span>📋 View Full Breakdown (Shares, Applications & Demand)</span>
            <span id="toggleIcon-${c.id}">▼</span>
          </button>

          <div id="details-${c.id}" class="subs-details-body">
            <h4 style="font-size: 0.75rem; color: #9ca3af; margin-top: 8px;">Subscription Details (No. of Shares)</h4>
            <table class="subs-mini-table">
              <thead><tr><th>Category</th><th>Offered</th><th>Applied</th><th>Times</th></tr></thead>
              <tbody>${sharesHtml}</tbody>
            </table>

            ${appsHtml ? `
              <h4 style="font-size: 0.75rem; color: #9ca3af; margin-top: 14px;">Application-Wise Breakup</h4>
              <table class="subs-mini-table">
                <thead><tr><th>Category</th><th>Reserved</th><th>Applied</th><th>Times</th></tr></thead>
                <tbody>${appsHtml}</tbody>
              </table>
            ` : ''}

            ${demandHtml ? `
              <h4 style="font-size: 0.75rem; color: #9ca3af; margin-top: 14px;">Subscription Demand (₹ Crore)</h4>
              <table class="subs-mini-table">
                <thead><tr><th>Category</th><th>Offered (Cr)</th><th>Applied (Cr)</th><th>Times</th></tr></thead>
                <tbody>${demandHtml}</tbody>
              </table>
            ` : ''}
          </div>
        </div>
      `;
    });

    els.subsGrid.innerHTML = html;
  }

  // Global Helpers for inline handlers
  window.toggleSubsDetails = function (id) {
    const el = document.getElementById(`details-${id}`);
    const icon = document.getElementById(`toggleIcon-${id}`);
    if (el) {
      el.classList.toggle('open');
      if (icon) icon.textContent = el.classList.contains('open') ? '▲' : '▼';
    }
  };

  window.markSubsRead = function (id) {
    if (storageHistory[id]) {
      storageHistory[id].isRead = true;
      saveStorage();
      const comp = companiesList.find(c => c.id === id);
      if (comp && comp.state) comp.state.isRead = true;
      renderUI();
    }
  };

  function markAllSubsRead() {
    Object.keys(storageHistory).forEach(k => {
      storageHistory[k].isRead = true;
    });
    saveStorage();
    companiesList.forEach(c => {
      if (c.state) c.state.isRead = true;
    });
    renderUI();
  }

  function updatePayloadPreview() {
    if (els.payloadPreview) {
      const sample = companiesList.length > 0 ? companiesList[0] : { sample: 'loading data...' };
      els.payloadPreview.textContent = JSON.stringify({
        event: 'subscription_update',
        timestamp: new Date().toISOString(),
        total_companies: companiesList.length,
        company_data: sample
      }, null, 2);
    }
  }

  // Countdown & Timer Handling
  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    secondsRemaining = refreshIntervalSeconds;
    updateCountdownUI();

    countdownTimer = setInterval(() => {
      secondsRemaining--;
      if (secondsRemaining <= 0) {
        fetchSubscriptionData();
      } else {
        updateCountdownUI();
      }
    }, 1000);
  }

  function resetCountdown() {
    secondsRemaining = refreshIntervalSeconds;
    updateCountdownUI();
  }

  function updateCountdownUI() {
    if (els.countdownText) {
      const mins = Math.floor(secondsRemaining / 60);
      const secs = secondsRemaining % 60;
      els.countdownText.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }
    if (els.countdownFill) {
      const percent = (secondsRemaining / refreshIntervalSeconds) * 100;
      els.countdownFill.style.width = `${percent}%`;
    }
  }

  function updateRefreshButton(loading) {
    if (!els.refreshBtn) return;
    els.refreshBtn.disabled = loading;
    if (els.refreshIcon) {
      if (loading) els.refreshIcon.classList.add('icon-spin');
      else els.refreshIcon.classList.remove('icon-spin');
    }
  }

  // Simulate Instant Subscription Change for Testing
  function simulateSubscriptionChange() {
    if (companiesList.length === 0) return;
    const target = companiesList[Math.floor(Math.random() * Math.min(3, companiesList.length))];
    const addTimes = +(Math.random() * 2 + 0.5).toFixed(2);
    const newTotal = +(target.summary.totalTimes + addTimes).toFixed(2);
    const newRetail = +(target.summary.retailTimes + addTimes * 0.8).toFixed(2);
    const newApps = target.totalApplications + Math.floor(Math.random() * 5000 + 1000);

    console.log(`[SIMULATE] ${target.companyName} subscription changed: ${target.summary.totalTimes}x -> ${newTotal}x`);

    target.summary.totalTimes = newTotal;
    target.summary.retailTimes = newRetail;
    target.totalApplications = newApps;

    if (storageHistory[target.id]) {
      storageHistory[target.id].previousTimes = storageHistory[target.id].totalTimes;
      storageHistory[target.id].totalTimes = newTotal;
      storageHistory[target.id].totalApplications = newApps;
      storageHistory[target.id].isRead = false;
      storageHistory[target.id].lastChangedAt = Date.now();
    }

    target.state = {
      isChanged: true,
      diffTimes: addTimes,
      isRead: false
    };

    saveStorage();
    playChime();
    renderUI();

    // Trigger webhook if enabled
    if (webhookConfig.autoSendOnChange && webhookConfig.url) {
      dispatchWebhook([target], 'simulated_subscription_change');
    }
  }

  // Setup Event Listeners
  function setupEventListeners() {
    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', () => fetchSubscriptionData());
    }

    if (els.intervalSelect) {
      els.intervalSelect.addEventListener('change', (e) => {
        refreshIntervalSeconds = parseInt(e.target.value, 10);
        resetCountdown();
      });
    }

    if (els.searchInput) {
      els.searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        renderCards();
      });
    }

    els.filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        els.filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentFilter = chip.getAttribute('data-filter');
        renderCards();
      });
    });

    if (els.sortSelect) {
      els.sortSelect.addEventListener('change', () => renderCards());
    }

    if (els.soundToggleBtn) {
      els.soundToggleBtn.addEventListener('click', () => {
        soundEnabled = !soundEnabled;
        if (els.soundIcon) els.soundIcon.textContent = soundEnabled ? '🔔' : '🔕';
        if (soundEnabled) playChime();
      });
    }

    if (els.simulateBtn) {
      els.simulateBtn.addEventListener('click', simulateSubscriptionChange);
    }

    // Webhook Modal & Form
    if (els.apiSettingsBtn && els.apiModal) {
      els.apiSettingsBtn.addEventListener('click', () => {
        if (els.apiUrlInput) els.apiUrlInput.value = webhookConfig.url || '';
        if (els.apiHeadersInput) els.apiHeadersInput.value = webhookConfig.headers || '';
        if (els.apiAutoSendCheckbox) els.apiAutoSendCheckbox.checked = !!webhookConfig.autoSendOnChange;
        updatePayloadPreview();
        els.apiModal.style.display = 'flex';
      });
    }

    if (els.closeModalBtn && els.apiModal) {
      els.closeModalBtn.addEventListener('click', () => {
        els.apiModal.style.display = 'none';
      });
    }

    if (els.apiForm) {
      els.apiForm.addEventListener('submit', (e) => {
        e.preventDefault();
        webhookConfig.url = els.apiUrlInput ? els.apiUrlInput.value.trim() : '';
        webhookConfig.headers = els.apiHeadersInput ? els.apiHeadersInput.value.trim() : '';
        webhookConfig.autoSendOnChange = els.apiAutoSendCheckbox ? els.apiAutoSendCheckbox.checked : true;
        saveWebhookConfig();
        if (els.apiStatusMsg) {
          els.apiStatusMsg.textContent = 'Settings saved successfully! ✓';
          els.apiStatusMsg.style.color = '#34d399';
          setTimeout(() => {
            if (els.apiModal) els.apiModal.style.display = 'none';
            els.apiStatusMsg.textContent = '';
          }, 1200);
        }
      });
    }

    if (els.testApiBtn) {
      els.testApiBtn.addEventListener('click', async () => {
        const testUrl = els.apiUrlInput ? els.apiUrlInput.value.trim() : '';
        if (!testUrl) {
          if (els.apiStatusMsg) {
            els.apiStatusMsg.textContent = 'Please enter your API URL first.';
            els.apiStatusMsg.style.color = '#f87171';
          }
          return;
        }

        if (els.apiStatusMsg) {
          els.apiStatusMsg.textContent = 'Sending test payload...';
          els.apiStatusMsg.style.color = '#60a5fa';
        }

        webhookConfig.url = testUrl;
        if (els.apiHeadersInput) webhookConfig.headers = els.apiHeadersInput.value.trim();
        saveWebhookConfig();

        const sample = companiesList.length > 0 ? [companiesList[0]] : [];
        const res = await dispatchWebhook(sample, 'test_api_event');
        if (res && res.success) {
          if (els.apiStatusMsg) {
            els.apiStatusMsg.textContent = `Success! Response HTTP ${res.status} ✓`;
            els.apiStatusMsg.style.color = '#34d399';
          }
        } else {
          if (els.apiStatusMsg) {
            els.apiStatusMsg.textContent = `Call attempted: ${res ? res.error : 'Network error'}`;
            els.apiStatusMsg.style.color = '#fbbf24';
          }
        }
      });
    }
  }

  // Init
  setupEventListeners();
  fetchSubscriptionData();
  startCountdown();

})();
