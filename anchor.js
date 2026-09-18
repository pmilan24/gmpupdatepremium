// anchor.js - NSE IPO List & Anchor Allocation Tracker with 1-Minute Highlight Engine
(function () {
  'use strict';

  const ANCHOR_STORAGE_KEY = 'nse_anchor_history_v2';
  const API_URL = '/api/nse/ipo-list';
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

  // Active 1-minute highlights: { [symbol]: expiryTimestamp }
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
    statActive: document.getElementById('statActive'),
    statSme: document.getElementById('statSme')
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

  // Fetch NSE IPO list and Anchor status
  async function fetchNSEData() {
    if (isFetching) return;
    isFetching = true;
    updateRefreshButton(true);

    let rawData = null;
    let source = '';

    try {
      // 1. Try local server API route
      try {
        const res = await fetch(`${API_URL}?t=${Date.now()}`, { cache: 'no-cache' });
        if (res.ok) {
          const json = await res.json();
          if (json && Array.isArray(json.ipos)) {
            rawData = json.ipos;
            source = 'Live (NSE India)';
          }
        }
      } catch (e) {
        console.warn('Local API failed, falling back to nse-ipo-data.json:', e.message);
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
        throw new Error('Unable to retrieve NSE IPO data from any source.');
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
      const symbol = ipo.symbol;
      const isAvailable = ipo.anchor && ipo.anchor.available;
      const stored = storageState[symbol];

      if (!stored) {
        storageState[symbol] = {
          anchorAvailable: isAvailable,
          firstSeenAt: Date.now(),
          acknowledged: true
        };
        // If first ever run, don't trigger alerts for existing data
        if (!isFirstTime && isAvailable) {
          triggerOneMinuteSurge(symbol);
          newAnchorDetected = true;
        }
      } else {
        // If anchor wasn't available before and now IS available: SURGE!
        if (!stored.anchorAvailable && isAvailable) {
          stored.anchorAvailable = true;
          stored.acknowledged = false;
          stored.firstSeenAt = Date.now();
          triggerOneMinuteSurge(symbol);
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
  function triggerOneMinuteSurge(symbol) {
    const ONE_MINUTE_MS = 60 * 1000;
    activeSurges[symbol] = Date.now() + ONE_MINUTE_MS;
    startHighlightTicker();
  }

  function startHighlightTicker() {
    if (highlightTimer) return;

    highlightTimer = setInterval(() => {
      const now = Date.now();
      let hasActive = false;

      Object.keys(activeSurges).forEach(sym => {
        if (activeSurges[sym] <= now) {
          delete activeSurges[sym];
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
    let activeCount = 0;
    let smeCount = 0;

    ipoList.forEach(i => {
      if (i.anchor && i.anchor.available) anchorCount++;
      if (i.status && i.status.toLowerCase() === 'active') activeCount++;
      if (i.series === 'SME' || (i.exchange && i.exchange.includes('SME'))) smeCount++;
    });

    if (els.statTotal) els.statTotal.textContent = total;
    if (els.statAnchorCount) els.statAnchorCount.textContent = anchorCount;
    if (els.statActive) els.statActive.textContent = activeCount;
    if (els.statSme) els.statSme.textContent = smeCount;

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
    } else if (currentFilter === 'mainboard') {
      list = list.filter(i => i.series === 'EQ');
    } else if (currentFilter === 'sme') {
      list = list.filter(i => i.series === 'SME' || (i.exchange && i.exchange.includes('SME')));
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(i =>
        i.symbol.toLowerCase().includes(q) ||
        i.companyName.toLowerCase().includes(q) ||
        i.series.toLowerCase().includes(q) ||
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
        list.sort((a, b) => a.symbol.localeCompare(b.symbol));
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
      const symbol = ipo.symbol;
      const isAnchorAvailable = ipo.anchor && ipo.anchor.available;
      const surgeExpiry = activeSurges[symbol];
      const isSurgeActive = surgeExpiry && surgeExpiry > now;
      const remainingSeconds = isSurgeActive ? Math.ceil((surgeExpiry - now) / 1000) : 0;

      const isSme = ipo.series === 'SME' || (ipo.exchange && ipo.exchange.includes('SME'));
      const exchangeBadge = isSme 
        ? `<span class="exchange-badge exchange-badge-both">NSE SME / BSE</span>` 
        : `<span class="exchange-badge exchange-badge-nse">NSE</span>`;

      // Row highlight
      const rowClass = isSurgeActive ? 'ipo-row anchor-active-highlight' : 'ipo-row';

      // Anchor status & actions HTML
      let anchorHtml = '';
      if (isAnchorAvailable) {
        const badgeClass = isSurgeActive ? 'anchor-badge new-highlight' : 'anchor-badge allocated';
        const timerHtml = isSurgeActive 
          ? `<span class="anchor-timer-tag">⏱ Live Surge: ${remainingSeconds}s</span>` 
          : '';

        anchorHtml = `
          <div class="anchor-status-box">
            <div class="${badgeClass}" title="Anchor Allocation Report Available">
              <span>✨ ANCHOR ALLOCATED</span>
              ${timerHtml}
            </div>
            <div class="anchor-actions">
              <a href="/api/nse/anchor-pdf?symbol=${encodeURIComponent(symbol)}" target="_blank" rel="noopener noreferrer" class="btn-pdf" title="View Anchor PDF directly in browser">
                📄 View PDF
              </a>
              <a href="/api/nse/anchor-zip?symbol=${encodeURIComponent(symbol)}" class="btn-zip" title="Download original NSE ZIP file">
                💾 Download ZIP
              </a>
            </div>
          </div>
        `;
      } else {
        anchorHtml = `
          <div class="anchor-status-box">
            <span class="anchor-badge pending">⏳ Not Released</span>
          </div>
        `;
      }

      html += `
        <tr class="${rowClass}" data-symbol="${symbol}">
          <td class="company-cell">
            <div class="company-title">
              <span style="color: #60a5fa; font-weight: 700;">${symbol}</span>
              ${exchangeBadge}
              <span class="badge-tag ${isSme ? 'badge-sme' : 'badge-mainboard'}">${ipo.series}</span>
            </div>
            <div style="font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-top: 3px;">
              ${ipo.companyName}
            </div>
            <div class="dates-meta">
              ${ipo.registrar ? `Registrar: ${ipo.registrar}` : ''}
            </div>
          </td>

          <td>
            <div style="font-size: 0.82rem; font-weight: 600;">
              <div>📅 Start: ${ipo.issueStartDate || '—'}</div>
              <div style="color: var(--text-muted); margin-top: 2px;">🏁 End: ${ipo.issueEndDate || '—'}</div>
            </div>
          </td>

          <td>
            <div style="font-weight: 700; color: #34d399; font-size: 0.92rem;">
              ${ipo.issuePrice || '—'}
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted);">
              ${ipo.issueType || 'Book Building'}
            </div>
          </td>

          <td>
            <div>
              <strong>${ipo.noOfTime ? `${ipo.noOfTime}x` : '—'}</strong>
            </div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">
              Bids: ${ipo.noOfsharesBid ? parseInt(ipo.noOfsharesBid, 10).toLocaleString('en-IN') : '—'}
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

  // Simulation: Test 1-Minute Live Surge
  function simulateAnchorRelease() {
    if (ipoList.length === 0) return;
    // Pick first or random IPO
    const target = ipoList[Math.floor(Math.random() * ipoList.length)];
    console.log(`[SIMULATE] Triggering 1-minute Anchor surge for ${target.symbol}`);

    target.anchor = {
      available: true,
      title: 'Anchor Allocation Report',
      zipUrl: `https://nsearchives.nseindia.com/content/ipo/ANCHOR_${target.symbol}.zip`,
      pdfUrl: `/api/nse/anchor-pdf?symbol=${target.symbol}`,
      detectedAt: Date.now()
    };

    triggerOneMinuteSurge(target.symbol);
    playAnchorChime();
    renderUI();

    // Scroll to row
    setTimeout(() => {
      const row = document.querySelector(`tr[data-symbol="${target.symbol}"]`);
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
        fetchNSEData();
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

  // Event Listeners
  function setupEventListeners() {
    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', () => fetchNSEData());
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
        renderTable();
      });
    }

    els.filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        els.filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentFilter = chip.getAttribute('data-filter');
        renderTable();
      });
    });

    if (els.sortSelect) {
      els.sortSelect.addEventListener('change', (e) => {
        currentSort = e.target.value;
        renderTable();
      });
    }

    if (els.soundToggleBtn) {
      els.soundToggleBtn.addEventListener('click', () => {
        soundEnabled = !soundEnabled;
        if (els.soundIcon) els.soundIcon.textContent = soundEnabled ? '🔔' : '🔕';
        if (soundEnabled) playAnchorChime();
      });
    }

    if (els.simulateBtn) {
      els.simulateBtn.addEventListener('click', simulateAnchorRelease);
    }

    if (els.dismissAlertBtn) {
      els.dismissAlertBtn.addEventListener('click', () => {
        activeSurges = {};
        if (highlightTimer) {
          clearInterval(highlightTimer);
          highlightTimer = null;
        }
        renderUI();
      });
    }
  }

  // Init
  setupEventListeners();
  fetchNSEData();
  startCountdown();

})();
