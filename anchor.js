// anchor.js - Unified NSE & BSE IPO List & Anchor Allocation Tracker with 1-Minute Highlight Engine
(function () {
  'use strict';

  const ANCHOR_STORAGE_KEY = 'unified_anchor_history_v1';
  const API_URL = '/api/exchange/ipo-list';
  const FALLBACK_URL = './nse-ipo-data.json';

  // State
  let ipoList = [];
  let storageState = loadStorage();
  let currentFilter = 'all';
  let currentSort = 'default';
  let searchQuery = '';
  let refreshIntervalSeconds = 60; // 1 min auto-refresh
  let secondsRemaining = refreshIntervalSeconds;
  let countdownTimer = null;
  let highlightTimer = null;
  let isFetching = false;
  let soundEnabled = true;

  // Active 1-minute highlights: { [id_or_symbol]: expiryTimestamp }
  let activeSurges = {};

  // DOM Elements
  const els = {
    tableBody: document.getElementById('anchorTableBody'),
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
    dismissAlertBtn: document.getElementById('dismissAlertBtn'),
    alertBanner: document.getElementById('alertBanner'),
    alertBannerCount: document.getElementById('alertBannerCount'),
    statTotal: document.getElementById('statTotal'),
    statAnchorCount: document.getElementById('statAnchorCount'),
    statDual: document.getElementById('statDual'),
    statActive: document.getElementById('statActive'),
    // Modal
    checkModal: document.getElementById('checkModal'),
    modalTitle: document.getElementById('modalTitle'),
    modalSub: document.getElementById('modalSub'),
    modalStepsList: document.getElementById('modalStepsList'),
    modalCloseBtn: document.getElementById('modalCloseBtn'),
    modalDoneBtn: document.getElementById('modalDoneBtn')
  };

  function loadStorage() {
    try {
      return JSON.parse(localStorage.getItem(ANCHOR_STORAGE_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveStorage() {
    try {
      localStorage.setItem(ANCHOR_STORAGE_KEY, JSON.stringify(storageState));
    } catch (e) {}
  }

  // Web Audio Chime Generator
  function playAnchorChime() {
    if (!soundEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const now = ctx.currentTime;

      // 3-tone celebratory chime: C5 -> E5 -> G5
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.12);

        gain.gain.setValueAtTime(0, now + idx * 0.12);
        gain.gain.linearRampToValueAtTime(0.25, now + idx * 0.12 + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.12);
        osc.stop(now + idx * 0.12 + 0.35);
      });
    } catch (e) {}
  }

  // Fetch Unified NSE + BSE IPO list and Anchor status
  async function fetchExchangeData() {
    if (isFetching) return;
    isFetching = true;
    updateRefreshButton(true);

    let rawData = null;
    let source = '';

    try {
      // 1. Try unified local API endpoint
      try {
        const res = await fetch(`${API_URL}?t=${Date.now()}`, { cache: 'no-cache' });
        if (res.ok) {
          const json = await res.json();
          if (json && Array.isArray(json.ipos)) {
            rawData = json.ipos;
            source = 'Live (NSE + BSE India)';
          }
        }
      } catch (e) {
        console.warn('Unified API fetch failed, falling back:', e.message);
      }

      // 2. Fallback to snapshot file
      if (!rawData || rawData.length === 0) {
        const resFallback = await fetch(`${FALLBACK_URL}?t=${Date.now()}`, { cache: 'no-cache' });
        if (resFallback.ok) {
          const json = await resFallback.json();
          rawData = json.ipos || json;
          source = 'Snapshot (nse-ipo-data.json)';
        }
      }

      if (!rawData || rawData.length === 0) {
        throw new Error('Unable to retrieve IPO data from any source.');
      }

      processAnchorDiff(rawData);
      renderUI();

      if (els.lastUpdatedText) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        els.lastUpdatedText.textContent = `${timeStr} · ${source}`;
      }

    } catch (err) {
      console.error('[ANCHOR] Fetch error:', err);
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

  // Process and Diff against stored anchor records
  function processAnchorDiff(items) {
    const isFirstTime = Object.keys(storageState).length === 0;
    let newAnchorDetected = false;

    items.forEach(ipo => {
      const key = ipo.symbol || ipo.id;
      const isAvailable = ipo.anchor && ipo.anchor.available;
      const stored = storageState[key];

      if (!stored) {
        storageState[key] = {
          anchorAvailable: isAvailable,
          firstSeenAt: Date.now(),
          acknowledged: true
        };
        // If first ever run, don't trigger alerts for existing data
        if (!isFirstTime && isAvailable) {
          triggerOneMinuteSurge(key);
          newAnchorDetected = true;
        }
      } else {
        // If anchor was not available before and now IS available: SURGE!
        if (!stored.anchorAvailable && isAvailable) {
          stored.anchorAvailable = true;
          stored.acknowledged = false;
          stored.firstSeenAt = Date.now();
          triggerOneMinuteSurge(key);
          newAnchorDetected = true;
        }
      }
    });

    saveStorage();
    ipoList = items;

    if (newAnchorDetected) {
      playAnchorChime();
    }
  }

  // Trigger 1-Minute Live Highlight
  function triggerOneMinuteSurge(key) {
    const ONE_MINUTE_MS = 60 * 1000;
    activeSurges[key] = Date.now() + ONE_MINUTE_MS;
    startHighlightTicker();
  }

  function startHighlightTicker() {
    if (highlightTimer) return;

    highlightTimer = setInterval(() => {
      const now = Date.now();
      let hasActive = false;

      Object.keys(activeSurges).forEach(key => {
        if (activeSurges[key] <= now) {
          delete activeSurges[key];
        } else {
          hasActive = true;
        }
      });

      renderUI();

      if (!hasActive) {
        clearInterval(highlightTimer);
        highlightTimer = null;
      }
    }, 1000);
  }

  // Render Everything
  function renderUI() {
    updateStats();
    renderTable();
  }

  function updateStats() {
    const total = ipoList.length;
    let anchorCount = 0;
    let dualCount = 0;
    let activeCount = 0;

    ipoList.forEach(i => {
      if (i.anchor && i.anchor.available) anchorCount++;
      if (i.exchange && i.exchange.includes('BSE') && i.exchange.includes('NSE')) dualCount++;
      if (i.status && i.status.toLowerCase() === 'active') activeCount++;
    });

    if (els.statTotal) els.statTotal.textContent = total;
    if (els.statAnchorCount) els.statAnchorCount.textContent = anchorCount;
    if (els.statDual) els.statDual.textContent = dualCount;
    if (els.statActive) els.statActive.textContent = activeCount;

    // Filter chip count
    const anchorChip = document.querySelector('.chip[data-filter="anchor"]');
    if (anchorChip) {
      anchorChip.textContent = `✨ Anchor Available (${anchorCount})`;
      if (Object.keys(activeSurges).length > 0) {
        anchorChip.classList.add('chip-alert');
      } else {
        anchorChip.classList.remove('chip-alert');
      }
    }

    const dualChip = document.querySelector('.chip[data-filter="dual"]');
    if (dualChip) {
      dualChip.textContent = `Dual Listed (${dualCount})`;
    }

    // Alert Banner
    const activeSurgeCount = Object.keys(activeSurges).length;
    if (els.alertBanner && els.alertBannerCount) {
      if (activeSurgeCount > 0) {
        els.alertBanner.style.display = 'flex';
        els.alertBannerCount.textContent = activeSurgeCount;
      } else {
        els.alertBanner.style.display = 'none';
      }
    }
  }

  function getFilteredIpos() {
    let list = [...ipoList];

    if (currentFilter === 'anchor') {
      list = list.filter(i => i.anchor && i.anchor.available);
    } else if (currentFilter === 'dual') {
      list = list.filter(i => i.exchange && i.exchange.includes('BSE') && i.exchange.includes('NSE'));
    } else if (currentFilter === 'mainboard') {
      list = list.filter(i => i.series === 'EQ' || (i.platforms && i.platforms.includes('MainBoard')));
    } else if (currentFilter === 'sme') {
      list = list.filter(i => i.series === 'SME' || (i.exchange && i.exchange.includes('SME')));
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(i =>
        (i.symbol && i.symbol.toLowerCase().includes(q)) ||
        (i.companyName && i.companyName.toLowerCase().includes(q)) ||
        (i.exchange && i.exchange.toLowerCase().includes(q)) ||
        (i.issuePrice && i.issuePrice.toLowerCase().includes(q))
      );
    }

    switch (currentSort) {
      case 'anchor-first':
        list.sort((a, b) => {
          const aHas = a.anchor && a.anchor.available ? 1 : 0;
          const bHas = b.anchor && b.anchor.available ? 1 : 0;
          return bHas - aHas;
        });
        break;
      case 'symbol-asc':
        list.sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
        break;
      case 'times-desc':
        list.sort((a, b) => (b.noOfTime || 0) - (a.noOfTime || 0));
        break;
      default:
        break;
    }

    return list;
  }

  function renderTable() {
    if (!els.tableBody) return;
    const items = getFilteredIpos();

    if (items.length === 0) {
      els.tableBody.innerHTML = `
        <tr>
          <td colspan="5">
            <div class="empty-box">
              <p>No IPO issues found matching your filter or search query.</p>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const now = Date.now();
    let html = '';

    items.forEach(ipo => {
      const key = ipo.symbol || ipo.id;
      const isAnchorAvailable = ipo.anchor && ipo.anchor.available;
      const surgeExpiry = activeSurges[key];
      const isSurgeActive = surgeExpiry && surgeExpiry > now;
      const remainingSeconds = isSurgeActive ? Math.ceil((surgeExpiry - now) / 1000) : 0;

      const isDual = ipo.exchange && ipo.exchange.includes('BSE') && ipo.exchange.includes('NSE');
      const isBseOnly = ipo.exchange && ipo.exchange.includes('BSE') && !ipo.exchange.includes('NSE');
      const isSme = ipo.series === 'SME' || (ipo.exchange && ipo.exchange.includes('SME'));

      let exchangeBadge = '';
      if (isDual) {
        exchangeBadge = `<span class="exchange-badge exchange-badge-both">NSE | BSE DUAL</span>`;
      } else if (isBseOnly) {
        exchangeBadge = `<span class="exchange-badge exchange-badge-bse">BSE</span>`;
      } else {
        exchangeBadge = `<span class="exchange-badge exchange-badge-nse">NSE</span>`;
      }

      // Row highlight
      const rowClass = isSurgeActive ? 'ipo-row anchor-active-highlight' : 'ipo-row';

      // Anchor status & actions HTML
      let anchorHtml = '';
      if (isAnchorAvailable) {
        const badgeClass = isSurgeActive ? 'anchor-badge new-highlight' : 'anchor-badge allocated';
        const timerHtml = isSurgeActive 
          ? `<span class="anchor-timer-tag">⏱ Live Surge: ${remainingSeconds}s</span>` 
          : '';

        const sourceLabel = ipo.anchor.source === 'BOTH' ? '✨ NSE & BSE' : (ipo.anchor.source === 'BSE' ? '🏛️ BSE Notice' : '🏛️ NSE Archive');

        anchorHtml = `
          <div class="anchor-status-box">
            <div class="${badgeClass}" title="Anchor Allocation Report Available">
              <span>${sourceLabel} ALLOCATED</span>
              ${timerHtml}
            </div>
            <div class="anchor-actions">
              ${ipo.anchor.nsePdfUrl ? `
                <a href="${ipo.anchor.nsePdfUrl}" target="_blank" rel="noopener noreferrer" class="btn-pdf" title="View NSE Anchor PDF in browser">
                  📄 NSE PDF
                </a>
              ` : ''}
              ${ipo.anchor.nseZipUrl ? `
                <a href="/api/nse/anchor-zip?symbol=${encodeURIComponent(ipo.symbol)}" class="btn-zip" title="Download original NSE ZIP file">
                  💾 NSE ZIP
                </a>
              ` : ''}
              ${ipo.anchor.bseIntimationPdfUrl ? `
                <a href="/api/bse/proxy-pdf?url=${encodeURIComponent(ipo.anchor.bseIntimationPdfUrl)}" target="_blank" rel="noopener noreferrer" class="btn-bse-notice" title="View BSE Anchor Intimation Letter PDF">
                  📑 BSE Intimation
                </a>
              ` : ''}
              ${ipo.anchor.bseNoticePdfUrl && ip.anchor.bseNoticePdfUrl !== ipo.anchor.bseIntimationPdfUrl ? `
                <a href="/api/bse/proxy-pdf?url=${encodeURIComponent(ipo.anchor.bseNoticePdfUrl)}" target="_blank" rel="noopener noreferrer" class="btn-pdf" style="font-size:0.68rem;" title="View BSE Official Notice">
                  Notice
                </a>
              ` : ''}
            </div>
            <button class="btn-check-exchange" onclick="window.checkIpoLive('${escapeQuotes(ipo.symbol)}', '${escapeQuotes(ipo.companyName)}')" title="Deep check both exchanges live">
              🔍 Re-check Exchanges
            </button>
          </div>
        `;
      } else {
        const elig = ipo.anchorEligibility || {};
        const eligClass = elig.isUpcoming ? 'upcoming' : 'due';
        anchorHtml = `
          <div class="anchor-status-box">
            <span class="anchor-badge pending">⏳ Not Released</span>
            <button class="btn-check-exchange" onclick="window.checkIpoLive('${escapeQuotes(ipo.symbol)}', '${escapeQuotes(ipo.companyName)}')" title="Trigger on-demand check on NSE and BSE">
              🔍 Check Both Exchanges
            </button>
          </div>
        `;
      }

      // Date eligibility snippet
      const elig = ipo.anchorEligibility || {};
      const eligHtml = elig.message ? `
        <div class="anchor-eligibility-tag ${elig.isUpcoming ? 'upcoming' : 'due'}">
          <span>${elig.isUpcoming ? '🕒' : '🔔'}</span>
          <span>Anchor: ${elig.message}</span>
        </div>
      ` : '';

      html += `
        <tr class="${rowClass}" data-key="${key}">
          <td class="company-cell">
            <div class="company-title">
              <span style="color: #60a5fa; font-weight: 700;">${ipo.symbol}</span>
              ${exchangeBadge}
              <span class="badge-tag ${isSme ? 'badge-sme' : 'badge-mainboard'}">${ipo.series || 'EQ'}</span>
            </div>
            <div style="font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-top: 3px;">
              ${ipo.companyName}
            </div>
            <div class="dates-meta">
              ${ipo.registrar && ipo.registrar !== '—' ? `Registrar: ${ipo.registrar}` : ''}
            </div>
          </td>

          <td>
            <div style="font-size: 0.82rem; font-weight: 600;">
              <div>📅 Start: ${ipo.issueStartDate || '—'}</div>
              <div style="color: var(--text-muted); margin-top: 2px;">🏁 End: ${ipo.issueEndDate || '—'}</div>
              ${eligHtml}
            </div>
          </td>

          <td>
            <div style="font-weight: 700; color: #34d399; font-size: 0.92rem;">
              ${ipo.issuePrice || '—'}
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted);">
              ${ipo.series === 'SME' ? 'SME Platform' : 'MainBoard Book Building'}
            </div>
          </td>

          <td>
            <div>
              <strong>${ipo.noOfTime ? `${ipo.noOfTime}x` : '—'}</strong>
            </div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">
              ${ipo.issueSize && ipo.issueSize !== '—' ? `Shares: ${Number(ipo.issueSize).toLocaleString('en-IN')}` : 'Active on Exchange'}
            </div>
          </td>

          <td class="highlight-cell" style="vertical-align: middle;">
            ${anchorHtml}
          </td>
        </tr>
      `;
    });

    els.tableBody.innerHTML = html;
  }

  function escapeQuotes(str) {
    return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  // On-demand Deep Cross-Check Modal
  window.checkIpoLive = async function (symbol, companyName) {
    if (!els.checkModal) return;
    els.checkModal.style.display = 'flex';
    els.modalTitle.textContent = `Checking: ${symbol || companyName}`;
    els.modalSub.textContent = 'Performing live real-time query across NSE & BSE India...';
    els.modalStepsList.innerHTML = `
      <div class="modal-step-item">
        <div class="modal-step-icon">⏳</div>
        <div>Contacting NSE India & BSE India API servers...</div>
      </div>
    `;

    try {
      const query = `symbol=${encodeURIComponent(symbol)}&companyName=${encodeURIComponent(companyName)}`;
      const res = await fetch(`/api/exchange/check-ipo?${query}`);
      const data = await res.json();

      if (data && Array.isArray(data.steps)) {
        let stepHtml = '';
        data.steps.forEach(st => {
          let icon = 'ℹ️';
          let cls = '';
          if (st.stage.includes('success')) {
            icon = '✅';
            cls = 'success';
          } else if (st.stage.includes('notice_found') || st.stage.includes('matched')) {
            icon = '✨';
            cls = 'found';
          } else if (st.stage.includes('none') || st.stage.includes('unmatched')) {
            icon = '⚪';
            cls = 'none';
          } else if (st.stage.includes('extract')) {
            icon = '⚙️';
            cls = 'found';
          }

          stepHtml += `
            <div class="modal-step-item ${cls}">
              <div class="modal-step-icon">${icon}</div>
              <div>${st.message}</div>
            </div>
          `;
        });

        // Add final verdict
        if (data.anchorAvailable) {
          stepHtml += `
            <div class="modal-step-item success" style="margin-top: 10px; font-weight: 700;">
              <div class="modal-step-icon">🎉</div>
              <div>Anchor Allocation Report is available! Refreshing list...</div>
            </div>
          `;
          triggerOneMinuteSurge(symbol);
          playAnchorChime();
          // Trigger refresh of main list
          setTimeout(fetchExchangeData, 1000);
        } else {
          stepHtml += `
            <div class="modal-step-item none" style="margin-top: 10px;">
              <div class="modal-step-icon">🕒</div>
              <div>No Anchor Allocation filing detected on either exchange yet.</div>
            </div>
          `;
        }

        els.modalStepsList.innerHTML = stepHtml;
      }
    } catch (err) {
      els.modalStepsList.innerHTML = `
        <div class="modal-step-item" style="border-left-color: #ef4444; color: #f87171;">
          <div class="modal-step-icon">❌</div>
          <div>Error checking exchanges: ${err.message}</div>
        </div>
      `;
    }
  };

  // Close modal
  if (els.modalCloseBtn) els.modalCloseBtn.onclick = () => { els.checkModal.style.display = 'none'; };
  if (els.modalDoneBtn) els.modalDoneBtn.onclick = () => { els.checkModal.style.display = 'none'; };
  if (els.checkModal) {
    els.checkModal.onclick = (e) => {
      if (e.target === els.checkModal) els.checkModal.style.display = 'none';
    };
  }

  // Simulation: Test 1-Minute Live Surge
  function simulateAnchorRelease() {
    if (ipoList.length === 0) return;
    const target = ipoList[Math.floor(Math.random() * ipoList.length)];
    const key = target.symbol || target.id;
    console.log(`[SIMULATE] Triggering 1-minute Anchor surge for ${key}`);

    target.anchor = {
      available: true,
      source: 'BOTH',
      nsePdfUrl: `/api/nse/anchor-pdf?symbol=${target.symbol}`,
      nseZipUrl: `https://nsearchives.nseindia.com/content/ipo/ANCHOR_${target.symbol}.zip`,
      bseIntimationPdfUrl: 'https://www.bseindia.com/downloads/UploadDocs/Notices/Attach/notice$51eae30a-bfb1-426c-b90f-e499a917e521.pdf',
      bseNoticePdfUrl: 'https://www.bseindia.com/downloads/UploadDocs/Notices/20260915-44/20260915-44.pdf'
    };

    triggerOneMinuteSurge(key);
    playAnchorChime();
    renderUI();

    setTimeout(() => {
      const row = document.querySelector(`tr[data-key="${key}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }

  // Countdown & Timer Handling
  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    secondsRemaining = refreshIntervalSeconds;
    updateCountdownUI();

    countdownTimer = setInterval(() => {
      secondsRemaining--;
      if (secondsRemaining <= 0) {
        fetchExchangeData();
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
      const pct = ((refreshIntervalSeconds - secondsRemaining) / refreshIntervalSeconds) * 100;
      els.countdownFill.style.width = `${pct}%`;
    }
  }

  function updateRefreshButton(loading) {
    if (!els.refreshBtn) return;
    if (loading) {
      els.refreshBtn.disabled = true;
      if (els.refreshIcon) els.refreshIcon.classList.add('spin-icon');
    } else {
      els.refreshBtn.disabled = false;
      if (els.refreshIcon) els.refreshIcon.classList.remove('spin-icon');
    }
  }

  // Setup Event Listeners
  function setupListeners() {
    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', () => {
        fetchExchangeData();
      });
    }

    if (els.intervalSelect) {
      els.intervalSelect.addEventListener('change', (e) => {
        refreshIntervalSeconds = parseInt(e.target.value, 10) || 60;
        resetCountdown();
      });
    }

    if (els.searchInput) {
      els.searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        renderUI();
      });
    }

    if (els.filterChips) {
      els.filterChips.forEach(chip => {
        chip.addEventListener('click', () => {
          els.filterChips.forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          currentFilter = chip.getAttribute('data-filter');
          renderUI();
        });
      });
    }

    if (els.sortSelect) {
      els.sortSelect.addEventListener('change', (e) => {
        currentSort = e.target.value;
        renderUI();
      });
    }

    if (els.soundToggleBtn) {
      els.soundToggleBtn.addEventListener('click', () => {
        soundEnabled = !soundEnabled;
        if (els.soundIcon) els.soundIcon.textContent = soundEnabled ? '🔔' : '🔕';
        els.soundToggleBtn.title = soundEnabled ? 'Sound alerts enabled' : 'Sound alerts muted';
      });
    }

    if (els.simulateBtn) {
      els.simulateBtn.addEventListener('click', simulateAnchorRelease);
    }

    if (els.dismissAlertBtn) {
      els.dismissAlertBtn.addEventListener('click', () => {
        activeSurges = {};
        if (els.alertBanner) els.alertBanner.style.display = 'none';
        renderUI();
      });
    }
  }

  // Initialization
  function init() {
    setupListeners();
    fetchExchangeData();
    startCountdown();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
