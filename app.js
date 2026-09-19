// app.js - Live GMP Financial Terminal
(function () {
  'use strict';

  function _decode(hex, k = 0x5C) {
    let s = '';
    for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ k);
    return s;
  }
  const _EP_JINA = '3428282c2f6673732e723635323d723d3573';
  const _EP_GMP = '3428282c2f6673732b2b2b72352c332c2e3931352931723532';

  const STORAGE_KEY = 'gmp_tracker_storage_v2';
  const CONFIG_KEY = 'gmp_tracker_config_v1';
  const PRIMARY_URL = `${_decode(_EP_JINA)}${_decode(_EP_GMP)}`;
  const FALLBACK_URL = './data.json';

  // State
  let ipoList = [];
  let storageState = loadStorage();
  let currentFilter = 'all';
  let currentSort = 'default';
  let searchQuery = '';
  let refreshIntervalSeconds = 180; // 3 minutes default
  let secondsRemaining = refreshIntervalSeconds;
  let countdownTimer = null;
  let isFetching = false;
  let soundEnabled = true;

  // DOM Elements
  const els = {
    tableBody: document.getElementById('ipoTableBody'),
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
    markAllReadBtn: document.getElementById('markAllReadBtn'),
    alertBanner: document.getElementById('alertBanner'),
    alertBannerCount: document.getElementById('alertBannerCount'),
    statTotal: document.getElementById('statTotal'),
    statChanged: document.getElementById('statChanged'),
    statActive: document.getElementById('statActive'),
    statTopGmp: document.getElementById('statTopGmp'),
    cardChangedStat: document.getElementById('cardChangedStat')
  };

  // Load config
  try {
    const savedConfig = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    if (savedConfig.interval) {
      refreshIntervalSeconds = savedConfig.interval;
      if (els.intervalSelect) els.intervalSelect.value = refreshIntervalSeconds;
    }
    if (typeof savedConfig.sound === 'boolean') {
      soundEnabled = savedConfig.sound;
      updateSoundUI();
    }
  } catch (e) {
    console.warn('Config load error:', e);
  }

  // Web Audio Chime Generator
  function playNotificationChime() {
    if (!soundEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();

      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(880, now + 0.15); // A5
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.35); // D6

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.2, now + 0.05);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now + 0.15);
      osc1.stop(now + 0.25);
      osc2.stop(now + 0.5);
    } catch (err) {
      console.warn('Audio chime failed:', err);
    }
  }

  function updateSoundUI() {
    if (els.soundToggleBtn && els.soundIcon) {
      if (soundEnabled) {
        els.soundIcon.textContent = '🔔';
        els.soundToggleBtn.title = 'Sound Alerts: Enabled (Click to Mute)';
      } else {
        els.soundIcon.textContent = '🔕';
        els.soundToggleBtn.title = 'Sound Alerts: Muted (Click to Enable)';
      }
    }
  }

  // LocalStorage Helper
  function loadStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : { isInitialized: false, items: {} };
    } catch (e) {
      return { isInitialized: false, items: {} };
    }
  }

  function saveStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storageState));
    } catch (e) {
      console.warn('Storage save failed:', e);
    }
  }

  // Parse Markdown Table from primary source via reader
  function parseMarkdown(markdown) {
    const lines = markdown.split('\n');
    let tableStarted = false;
    const ipos = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('|')) continue;

      const cells = line.split('|').slice(1, -1).map(c => c.trim());

      if (!tableStarted) {
        if (cells.some(c => c.toLowerCase().includes('company name'))) {
          tableStarted = true;
          continue;
        }
      } else {
        if (cells.every(c => /^[-:\s]+$/.test(c))) continue;
        if (cells.length < 5) continue;

        const rawNameCell = cells[0] || '';
        const nameMatch = rawNameCell.match(/\[(.*?)\]\((.*?)\)/);
        const name = nameMatch ? nameMatch[1].trim() : rawNameCell.replace(/[\[\]]/g, '').trim();
        const url = nameMatch ? nameMatch[2].trim() : '';

        if (!name || name.toLowerCase().includes('company name')) continue;

        let type = 'Mainboard';
        if (/SME/i.test(name)) type = 'SME';

        let cleanName = name
          .replace(/\s*\((?:MAINBOARD|MAIN BOARD|NSE SME|BSE SME|SME)\s*\)/gi, '')
          .trim();

        const rawGmp = cells[1] || '0';
        let gmpValue = 0;
        let gmpPercent = '0%';

        const gmpMatch = rawGmp.match(/^(-?\d+)(?:\s*\((.*?)\))?/);
        if (gmpMatch) {
          gmpValue = parseInt(gmpMatch[1], 10) || 0;
          if (gmpMatch[2]) gmpPercent = gmpMatch[2].trim();
        } else {
          const numOnly = parseInt(rawGmp.replace(/[^\d-]/g, ''), 10);
          gmpValue = isNaN(numOnly) ? 0 : numOnly;
        }

        const openDate = cells[2] || '';
        const closeDate = cells[3] || '';
        const rawPrice = cells[4] || '';

        let priceUpper = 0;
        const priceParts = rawPrice.split('-').map(p => parseInt(p.replace(/[^\d]/g, ''), 10)).filter(p => !isNaN(p));
        if (priceParts.length > 0) priceUpper = priceParts[priceParts.length - 1];

        const rawLot = cells[5] || '0';
        const lotSize = parseInt(rawLot.replace(/[^\d]/g, ''), 10) || 0;
        const issueSize = cells[6] || '';
        const allotmentDate = cells[8] || '';
        const listingDate = cells[9] || '';
        const estimatedProfit = gmpValue * lotSize;

        ipos.push({
          id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          fullName: name,
          displayName: cleanName || name,
          type,
          gmp: gmpValue,
          gmpPercent: gmpPercent.startsWith('+') ? gmpPercent : (gmpValue > 0 && !gmpPercent.startsWith('+') && gmpPercent !== '0%' ? `+${gmpPercent}` : gmpPercent),
          rawGmp,
          openDate,
          closeDate,
          priceBand: rawPrice,
          priceUpper,
          lotSize,
          issueSize,
          allotmentDate,
          listingDate,
          estimatedProfit,
          url: url ? (url.startsWith('http') ? url : `${_decode(_EP_GMP)}${url}`) : ''
        });
      }
    }
    return ipos;
  }

  // Fetch Data (tries live proxy, falls back to ./data.json)
  async function fetchData() {
    if (isFetching) return;
    isFetching = true;
    updateRefreshButton(true);

    let rawData = null;
    let fetchSource = '';

    try {
      // 1. Try Live Proxy with cache-busting
      try {
        const liveUrl = `${PRIMARY_URL}?t=${Date.now()}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(liveUrl, {
          cache: 'no-cache',
          signal: controller.signal,
          headers: {
            'Accept': 'text/plain',
            'x-no-cache': 'true'
          }
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const text = await response.text();
          const parsed = parseMarkdown(text);
          if (parsed && parsed.length > 0) {
            rawData = parsed;
            fetchSource = 'Live Market Feed';
          }
        }
      } catch (err) {
        console.warn('Live proxy fetch failed, falling back to data.json:', err);
      }

      // 2. Fallback to data.json
      if (!rawData || rawData.length === 0) {
        const fallbackRes = await fetch(FALLBACK_URL + '?t=' + Date.now(), { cache: 'no-cache' });
        if (fallbackRes.ok) {
          const json = await fallbackRes.json();
          rawData = json.ipos || json;
          fetchSource = 'Cached snapshot (data.json)';
        }
      }

      if (!rawData || rawData.length === 0) {
        throw new Error('Unable to retrieve IPO data from any source.');
      }

      processNewIpoData(rawData);
      renderUI();

      if (els.lastUpdatedText) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        els.lastUpdatedText.textContent = `${timeStr} (${fetchSource})`;
      }

    } catch (error) {
      console.error('Fetch error:', error);
      showErrorState(error.message);
    } finally {
      isFetching = false;
      updateRefreshButton(false);
      resetCountdown();
    }
  }

  // Process and Diff against stored values
  function processNewIpoData(newIpos) {
    let anyChanges = false;
    const isFirstTime = !storageState.isInitialized;

    newIpos.forEach(ipo => {
      const stored = storageState.items[ipo.id];

      if (!stored) {
        // New IPO entry
        storageState.items[ipo.id] = {
          lastGmp: ipo.gmp,
          previousGmp: null,
          changeDiff: 0,
          changedAt: Date.now(),
          isRead: isFirstTime ? true : false,
          isNew: !isFirstTime
        };
        if (!isFirstTime) anyChanges = true;
      } else {
        // Existing IPO entry - check if GMP value changed!
        if (stored.lastGmp !== ipo.gmp) {
          const diff = ipo.gmp - stored.lastGmp;
          stored.previousGmp = stored.lastGmp;
          stored.lastGmp = ipo.gmp;
          stored.changeDiff = diff;
          stored.changedAt = Date.now();
          stored.isRead = false; // Unread alert!
          stored.isNew = false;
          anyChanges = true;
        }
      }

      // Attach state to ipo object for rendering
      const currentItemState = storageState.items[ipo.id];
      ipo.state = currentItemState;
    });

    storageState.isInitialized = true;
    saveStorage();
    ipoList = newIpos;

    if (anyChanges) {
      playNotificationChime();
    }
  }

  // Render Everything
  function renderUI() {
    updateStats();
    renderTable();
  }

  // Update Top Stats and Alert Banner
  function updateStats() {
    const total = ipoList.length;
    let unreadChanges = 0;
    let maxGmp = -Infinity;
    let maxGmpIpo = '-';

    ipoList.forEach(item => {
      if (item.state && !item.state.isRead && (item.state.changeDiff !== 0 || item.state.isNew)) {
        unreadChanges++;
      }
      if (item.gmp > maxGmp) {
        maxGmp = item.gmp;
        maxGmpIpo = item.displayName;
      }
    });

    if (els.statTotal) els.statTotal.textContent = total;
    if (els.statChanged) els.statChanged.textContent = unreadChanges;
    if (els.statActive) els.statActive.textContent = ipoList.filter(i => i.gmp > 0).length;
    if (els.statTopGmp) {
      els.statTopGmp.textContent = maxGmp > -Infinity && maxGmp > 0 ? `₹${maxGmp}` : '₹0';
    }

    // Alert Banner
    if (els.alertBanner && els.alertBannerCount) {
      if (unreadChanges > 0) {
        els.alertBanner.style.display = 'flex';
        els.alertBannerCount.textContent = unreadChanges;
      } else {
        els.alertBanner.style.display = 'none';
      }
    }

    // Update filter chip count for changed
    const changedChip = document.querySelector('.chip[data-filter="changed"]');
    if (changedChip) {
      changedChip.textContent = `🔥 Changed GMP (${unreadChanges})`;
      if (unreadChanges > 0) {
        changedChip.classList.add('chip-alert');
      } else {
        changedChip.classList.remove('chip-alert');
      }
    }
  }

  // Filter & Sort
  function getFilteredAndSortedIpos() {
    let result = [...ipoList];

    // Filter by type or changed
    if (currentFilter === 'changed') {
      result = result.filter(i => i.state && !i.state.isRead && (i.state.changeDiff !== 0 || i.state.isNew));
    } else if (currentFilter === 'mainboard') {
      result = result.filter(i => i.type.toLowerCase() === 'mainboard');
    } else if (currentFilter === 'sme') {
      result = result.filter(i => i.type.toLowerCase() === 'sme');
    } else if (currentFilter === 'active') {
      result = result.filter(i => i.gmp > 0);
    }

    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(i =>
        i.displayName.toLowerCase().includes(q) ||
        i.fullName.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q) ||
        i.priceBand.includes(q)
      );
    }

    // Sort
    switch (currentSort) {
      case 'gmp-desc':
        result.sort((a, b) => b.gmp - a.gmp);
        break;
      case 'gmp-asc':
        result.sort((a, b) => a.gmp - b.gmp);
        break;
      case 'profit-desc':
        result.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
        break;
      case 'name-asc':
        result.sort((a, b) => a.displayName.localeCompare(b.displayName));
        break;
      case 'default':
      default:
        // Default order as received from feed
        break;
    }

    return result;
  }

  // Render Table
  function renderTable() {
    if (!els.tableBody) return;

    const filtered = getFilteredAndSortedIpos();

    if (filtered.length === 0) {
      els.tableBody.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="empty-box">
              <p>No IPOs found matching your filter or search query.</p>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    let html = '';
    filtered.forEach(ipo => {
      const state = ipo.state || {};
      const hasChanged = state.changeDiff !== 0 && state.changeDiff !== undefined;
      const isUnread = !state.isRead && (hasChanged || state.isNew);
      const isUp = state.changeDiff > 0;
      const isDown = state.changeDiff < 0;

      // Row Highlight styling
      let rowClass = 'ipo-row';
      if (isUnread) {
        if (isUp) rowClass += ' changed-unread changed-up-unread';
        else if (isDown) rowClass += ' changed-unread changed-down-unread';
        else rowClass += ' changed-unread';
      }

      // Right-side Highlight Badge
      let highlightHtml = '';
      if (isUnread) {
        if (state.isNew) {
          highlightHtml = `
            <div class="change-badge unread-new" data-id="${ipo.id}" title="Click to mark as seen">
              <span class="change-badge-title">★ NEW IPO</span>
              <span class="change-badge-details">Added recently</span>
              <span class="change-badge-action">Click to Dismiss ✓</span>
            </div>
          `;
        } else if (isUp) {
          highlightHtml = `
            <div class="change-badge unread-up" data-id="${ipo.id}" title="Click to acknowledge changed GMP">
              <span class="change-badge-title">▲ +₹${state.changeDiff}</span>
              <span class="change-badge-details">₹${state.previousGmp} → ₹${ipo.gmp}</span>
              <span class="change-badge-action">Click to Dismiss ✓</span>
            </div>
          `;
        } else if (isDown) {
          highlightHtml = `
            <div class="change-badge unread-down" data-id="${ipo.id}" title="Click to acknowledge changed GMP">
              <span class="change-badge-title">▼ ₹${state.changeDiff}</span>
              <span class="change-badge-details">₹${state.previousGmp} → ₹${ipo.gmp}</span>
              <span class="change-badge-action">Click to Dismiss ✓</span>
            </div>
          `;
        }
      } else if (hasChanged && state.isRead) {
        // Read / Acknowledged state (persisted)
        highlightHtml = `
          <div class="change-badge read" data-id="${ipo.id}" title="Previously updated">
            <span class="change-badge-title">${isUp ? '▲' : '▼'} ₹${state.previousGmp} → ₹${ipo.gmp}</span>
            <span class="change-badge-action">✓ Seen</span>
          </div>
        `;
      } else {
        highlightHtml = `<span class="no-change">—</span>`;
      }

      // GMP Color formatting
      let gmpColorClass = 'gmp-zero';
      if (ipo.gmp > 0) gmpColorClass = 'gmp-positive';
      else if (ipo.gmp < 0) gmpColorClass = 'gmp-negative';

      html += `
        <tr class="${rowClass}" data-id="${ipo.id}">
          <td class="company-cell">
            <div class="company-title">
              <a href="${ipo.url}" target="_blank" rel="noopener noreferrer">${ipo.displayName}</a>
              <span class="badge-tag ${ipo.type === 'Mainboard' ? 'badge-mainboard' : 'badge-sme'}">${ipo.type}</span>
            </div>
            <div class="dates-meta">
              ${ipo.openDate ? `Open: ${ipo.openDate}` : ''} 
              ${ipo.closeDate ? `· Close: ${ipo.closeDate}` : ''}
            </div>
          </td>

          <td class="gmp-cell">
            <span class="gmp-value ${gmpColorClass}">₹${ipo.gmp}</span>
            <span class="gmp-percent">(${ipo.gmpPercent})</span>
          </td>

          <td>
            <strong>₹${ipo.priceBand || '—'}</strong>
          </td>

          <td>
            ${ipo.lotSize ? `${ipo.lotSize} shares` : '—'}
          </td>

          <td>
            ${ipo.estimatedProfit > 0 ? `<strong style="color: #34d399;">+₹${ipo.estimatedProfit.toLocaleString('en-IN')}</strong>` : (ipo.estimatedProfit < 0 ? `<strong style="color: #f87171;">-₹${Math.abs(ipo.estimatedProfit).toLocaleString('en-IN')}</strong>` : '₹0')}
          </td>

          <td class="highlight-cell">
            ${highlightHtml}
          </td>
        </tr>
      `;
    });

    els.tableBody.innerHTML = html;

    // Attach click listeners to change badges for acknowledgment
    const badges = els.tableBody.querySelectorAll('.change-badge');
    badges.forEach(badge => {
      badge.addEventListener('click', function (e) {
        e.stopPropagation();
        const id = this.getAttribute('data-id');
        markAsRead(id);
      });
    });
  }

  // Mark single IPO change as read / acknowledged
  function markAsRead(id) {
    if (!id || !storageState.items[id]) return;

    storageState.items[id].isRead = true;
    saveStorage();

    // Update state on in-memory object
    const ipo = ipoList.find(i => i.id === id);
    if (ipo && ipo.state) {
      ipo.state.isRead = true;
    }

    renderUI();
  }

  // Mark all unread changes as read
  function markAllAsRead() {
    let count = 0;
    Object.keys(storageState.items).forEach(id => {
      if (!storageState.items[id].isRead) {
        storageState.items[id].isRead = true;
        count++;
      }
    });

    if (count > 0) {
      saveStorage();
      ipoList.forEach(ipo => {
        if (ipo.state) ipo.state.isRead = true;
      });
      renderUI();
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
        fetchData();
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
    if (loading) {
      els.refreshBtn.disabled = true;
      if (els.refreshIcon) els.refreshIcon.classList.add('icon-spin');
    } else {
      els.refreshBtn.disabled = false;
      if (els.refreshIcon) els.refreshIcon.classList.remove('icon-spin');
    }
  }

  function showErrorState(msg) {
    if (els.lastUpdatedText) {
      els.lastUpdatedText.textContent = `Error: ${msg}. Retrying in countdown...`;
      els.lastUpdatedText.style.color = '#f87171';
    }
  }

  // Simulator: lets user test GMP change detection immediately
  function simulateChange() {
    if (ipoList.length === 0) return;

    // Pick 1st or 2nd active IPO
    const target = ipoList[Math.floor(Math.random() * Math.min(3, ipoList.length))];
    const delta = (Math.floor(Math.random() * 5) + 1) * 5; // +₹5, +₹10, +₹15...
    const isIncrease = Math.random() > 0.3;
    const newGmp = isIncrease ? target.gmp + delta : Math.max(0, target.gmp - delta);

    console.log(`[SIMULATE] Changing GMP for ${target.displayName}: ${target.gmp} -> ${newGmp}`);

    // Update in stored items as an unread change
    const stored = storageState.items[target.id] || {};
    stored.previousGmp = target.gmp;
    stored.lastGmp = newGmp;
    stored.changeDiff = newGmp - target.gmp;
    stored.changedAt = Date.now();
    stored.isRead = false;
    stored.isNew = false;
    storageState.items[target.id] = stored;

    target.gmp = newGmp;
    target.state = stored;
    target.estimatedProfit = target.gmp * target.lotSize;

    saveStorage();
    playNotificationChime();
    renderUI();

    // Scroll to the modified item
    setTimeout(() => {
      const row = document.querySelector(`tr[data-id="${target.id}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }

  // Event Listeners
  function setupEventListeners() {
    // Refresh Button
    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', () => {
        fetchData();
      });
    }

    // Interval Select
    if (els.intervalSelect) {
      els.intervalSelect.addEventListener('change', (e) => {
        refreshIntervalSeconds = parseInt(e.target.value, 10);
        resetCountdown();
        try {
          const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
          cfg.interval = refreshIntervalSeconds;
          localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
        } catch (err) {}
      });
    }

    // Search Input
    if (els.searchInput) {
      els.searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        renderTable();
      });
    }

    // Filter Chips
    els.filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        els.filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentFilter = chip.getAttribute('data-filter');
        renderTable();
      });
    });

    // Sort Select
    if (els.sortSelect) {
      els.sortSelect.addEventListener('change', (e) => {
        currentSort = e.target.value;
        renderTable();
      });
    }

    // Sound Toggle
    if (els.soundToggleBtn) {
      els.soundToggleBtn.addEventListener('click', () => {
        soundEnabled = !soundEnabled;
        updateSoundUI();
        if (soundEnabled) playNotificationChime();
        try {
          const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
          cfg.sound = soundEnabled;
          localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
        } catch (err) {}
      });
    }

    // Simulate Button
    if (els.simulateBtn) {
      els.simulateBtn.addEventListener('click', simulateChange);
    }

    // Mark All Read Button
    if (els.markAllReadBtn) {
      els.markAllReadBtn.addEventListener('click', markAllAsRead);
    }

    // Click on stat changed card filters to changed
    if (els.cardChangedStat) {
      els.cardChangedStat.addEventListener('click', () => {
        const changedChip = document.querySelector('.chip[data-filter="changed"]');
        if (changedChip) changedChip.click();
      });
    }

    // Tab visibility handling (catch up timer when user returns)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (secondsRemaining <= 10) {
          fetchData();
        }
      }
    });
  }

  // Initialize
  setupEventListeners();
  updateSoundUI();
  fetchData();
  startCountdown();

})();
