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
  let currentSort = 'today-timeline';
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
    // Progress Tracker (Top Side of List)
    trackerContainer: document.getElementById('exchangeProgressTracker'),
    trackerSpinner: document.getElementById('trackerSpinner'),
    trackerStatusTitle: document.getElementById('trackerStatusTitle'),
    trackerStatusDesc: document.getElementById('trackerStatusDesc'),
    trackerStageBadge: document.getElementById('trackerStageBadge'),
    trackerProgressBar: document.getElementById('trackerProgressBar'),
    trackerTimeText: document.getElementById('trackerTimeText'),
    stepNSE: document.getElementById('stepNSE'),
    badgeNSE: document.getElementById('badgeNSE'),
    stepBSE: document.getElementById('stepBSE'),
    badgeBSE: document.getElementById('badgeBSE'),
    stepUnified: document.getElementById('stepUnified'),
    badgeUnified: document.getElementById('badgeUnified'),
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

  // Helper: Calculate Anchor Date Eligibility
  function checkAnchorDateEligibility(startDateStr) {
    if (!startDateStr || startDateStr === '—') {
      return { eligible: false, isToday: false, isUpcoming: false, message: 'Date not announced' };
    }
    const cleanDate = startDateStr.split('T')[0].trim();
    const d = new Date(cleanDate);
    if (isNaN(d.getTime())) {
      return { eligible: false, isToday: false, isUpcoming: false, message: 'Date not announced' };
    }

    // Anchor bid date is 1 trading day before IPO open date
    const anchorDate = new Date(d);
    if (anchorDate.getDay() === 1) { // Monday -> Friday
      anchorDate.setDate(anchorDate.getDate() - 3);
    } else if (anchorDate.getDay() === 0) { // Sunday -> Friday
      anchorDate.setDate(anchorDate.getDate() - 2);
    } else {
      anchorDate.setDate(anchorDate.getDate() - 1);
    }

    const now = new Date();
    const todayDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const anchorDateOnly = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate());

    const diffMs = todayDateOnly - anchorDateOnly;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formattedAnchorDate = `${anchorDate.getDate()} ${months[anchorDate.getMonth()]}`;

    if (diffDays === 0) {
      return {
        eligible: true,
        isToday: true,
        isUpcoming: false,
        diffDays: 0,
        daysToGo: 0,
        expectedDate: anchorDate.toISOString().slice(0, 10),
        formattedDate: formattedAnchorDate,
        message: `Due Today (${formattedAnchorDate})`
      };
    } else if (diffDays < 0) {
      const daysToGo = Math.abs(diffDays);
      return {
        eligible: false,
        isToday: false,
        isUpcoming: true,
        diffDays,
        daysToGo,
        expectedDate: anchorDate.toISOString().slice(0, 10),
        formattedDate: formattedAnchorDate,
        message: `Expected on ${formattedAnchorDate} (${daysToGo} day${daysToGo > 1 ? 's' : ''} to go)`
      };
    } else {
      return {
        eligible: true,
        isToday: false,
        isUpcoming: false,
        diffDays,
        daysToGo: 0,
        expectedDate: anchorDate.toISOString().slice(0, 10),
        formattedDate: formattedAnchorDate,
        message: `Due / Released since ${formattedAnchorDate}`
      };
    }
  }

  // Cross-Exchange Matching Utilities
  function normalizeName(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .replace(/\b(limited|ltd|pvt|private|india|corporation|corp|technologies|tech|services|llp)\b/gi, '')
      .replace(/[^a-z0-9]/gi, '')
      .trim();
  }

  function matchCompany(a, b) {
    if (!a || !b) return false;
    if (a.symbol && b.symbol && a.symbol.toUpperCase() === b.symbol.toUpperCase()) {
      return true;
    }
    const normA = normalizeName(a.companyName || a.symbol);
    const normB = normalizeName(b.companyName || b.symbol);
    if (!normA || !normB) return false;
    if (normA === normB) return true;
    if (normA.length > 5 && normB.length > 5 && (normA.includes(normB) || normB.includes(normA))) {
      return true;
    }
    return false;
  }

  function formatNseItem(nse) {
    const symbol = nse.symbol || '';
    const startDate = nse.issueStartDate || '—';
    const anchorElig = nse.anchorEligibility || checkAnchorDateEligibility(startDate);
    const isSme = (nse.series === 'SME') || (nse.exchange && nse.exchange.includes('SME'));

    return {
      id: `NSE_${symbol}`,
      symbol,
      companyName: nse.companyName || symbol,
      exchange: isSme ? 'NSE SME' : 'NSE',
      platforms: ['NSE'],
      status: nse.status || 'Active',
      series: nse.series || 'EQ',
      issueStartDate: startDate,
      issueEndDate: nse.issueEndDate || '—',
      issuePrice: nse.issuePrice || '—',
      issueSize: nse.issueSize || '—',
      noOfTime: nse.noOfTime || 0,
      registrar: nse.registrar || '—',
      anchorEligibility: anchorElig,
      anchor: {
        available: !!(nse.anchor && nse.anchor.available),
        source: 'NSE',
        nseZipUrl: nse.anchor ? nse.anchor.zipUrl : null,
        nsePdfUrl: nse.anchor ? nse.anchor.pdfUrl : null,
        bseNoticePdfUrl: null,
        bseIntimationPdfUrl: null,
        bseNoticeNo: null,
        hasBseAttachment: false
      },
      bseData: null,
      updatedAt: new Date().toISOString()
    };
  }

  function formatBseItem(bse) {
    const symbol = bse.symbol || bse.scripCode || '';
    const startDate = bse.issueStartDate || '—';
    const anchorElig = bse.anchorEligibility || checkAnchorDateEligibility(startDate);
    const hasBseAnchor = !!(bse.anchor && bse.anchor.available);

    return {
      id: `BSE_${symbol || bse.bseIpoNo}`,
      symbol,
      companyName: bse.companyName || symbol,
      exchange: bse.exchange || 'BSE',
      platforms: ['BSE'],
      status: bse.status || 'Active',
      series: bse.platform === 'SME' ? 'SME' : 'EQ',
      issueStartDate: startDate,
      issueEndDate: bse.issueEndDate || '—',
      issuePrice: bse.issuePrice || '—',
      issueSize: '—',
      noOfTime: 0,
      registrar: '—',
      anchorEligibility: anchorElig,
      anchor: {
        available: hasBseAnchor,
        source: hasBseAnchor ? 'BSE' : 'NONE',
        nseZipUrl: null,
        nsePdfUrl: null,
        bseNoticePdfUrl: hasBseAnchor ? bse.anchor.noticePdfUrl : null,
        bseIntimationPdfUrl: hasBseAnchor ? bse.anchor.intimationPdfUrl : null,
        bseNoticeNo: hasBseAnchor ? bse.anchor.noticeNo : null,
        hasBseAttachment: hasBseAnchor ? bse.anchor.hasIntimationAttachment : false
      },
      bseData: {
        ipoNo: bse.bseIpoNo,
        scripCode: bse.scripCode,
        platform: bse.platform
      },
      updatedAt: new Date().toISOString()
    };
  }

  function mergeNseAndBse(nseList = [], bseList = []) {
    const unified = [];
    const matchedBseIndices = new Set();

    // 1. Process NSE items and match with BSE
    for (const nseItem of nseList) {
      let matchedBse = null;
      let matchedIdx = -1;

      for (let i = 0; i < bseList.length; i++) {
        if (!matchedBseIndices.has(i) && matchCompany(nseItem, bseList[i])) {
          matchedBse = bseList[i];
          matchedIdx = i;
          matchedBseIndices.add(i);
          break;
        }
      }

      const hasNseAnchor = !!(nseItem.anchor && nseItem.anchor.available);
      const hasBseAnchor = !!(matchedBse && matchedBse.anchor && matchedBse.anchor.available);
      const anchorAvailable = hasNseAnchor || hasBseAnchor;

      const startDate = nseItem.issueStartDate || (matchedBse ? matchedBse.issueStartDate : '—');
      const anchorEligibility = nseItem.anchorEligibility || checkAnchorDateEligibility(startDate);

      let exchangeBadge = 'NSE';
      if (matchedBse) {
        exchangeBadge = 'NSE | BSE';
      } else if (nseItem.exchange && nseItem.exchange.includes('SME')) {
        exchangeBadge = 'NSE SME';
      }

      unified.push({
        id: `NSE_${nseItem.symbol}`,
        symbol: nseItem.symbol,
        companyName: nseItem.companyName,
        exchange: exchangeBadge,
        platforms: matchedBse ? ['NSE', 'BSE'] : ['NSE'],
        status: nseItem.status || (matchedBse ? matchedBse.status : 'Active'),
        series: nseItem.series || 'EQ',
        issueStartDate: startDate,
        issueEndDate: nseItem.issueEndDate || (matchedBse ? matchedBse.issueEndDate : '—'),
        issuePrice: nseItem.issuePrice || (matchedBse ? matchedBse.issuePrice : '—'),
        issueSize: nseItem.issueSize || '—',
        noOfTime: nseItem.noOfTime || 0,
        registrar: nseItem.registrar || '—',
        anchorEligibility,
        anchor: {
          available: anchorAvailable,
          source: hasNseAnchor && hasBseAnchor ? 'BOTH' : (hasNseAnchor ? 'NSE' : (hasBseAnchor ? 'BSE' : 'NONE')),
          nseZipUrl: hasNseAnchor ? nseItem.anchor.zipUrl : null,
          nsePdfUrl: hasNseAnchor ? nseItem.anchor.pdfUrl : null,
          bseNoticePdfUrl: hasBseAnchor ? matchedBse.anchor.noticePdfUrl : null,
          bseIntimationPdfUrl: hasBseAnchor ? matchedBse.anchor.intimationPdfUrl : null,
          bseNoticeNo: hasBseAnchor ? matchedBse.anchor.noticeNo : null,
          hasBseAttachment: hasBseAnchor ? matchedBse.anchor.hasIntimationAttachment : false
        },
        bseData: matchedBse ? {
          ipoNo: matchedBse.bseIpoNo,
          scripCode: matchedBse.scripCode,
          platform: matchedBse.platform
        } : null,
        updatedAt: new Date().toISOString()
      });
    }

    // 2. Add remaining BSE-only items
    for (let i = 0; i < bseList.length; i++) {
      if (matchedBseIndices.has(i)) continue;
      unified.push(formatBseItem(bseList[i]));
    }

    return unified;
  }

  // Update Progress Tracker UI (Top Side of List)
  function updateProgressTracker({
    stageBadge,
    title,
    desc,
    progressPercent,
    step1Status, // 'pending' | 'loading' | 'done' | 'warning'
    step1Text,
    step2Status, // 'pending' | 'loading' | 'done' | 'warning'
    step2Text,
    step3Status, // 'pending' | 'loading' | 'done' | 'warning'
    step3Text,
    isComplete = false
  }) {
    if (els.trackerStageBadge && stageBadge) els.trackerStageBadge.textContent = stageBadge;
    if (els.trackerStatusTitle && title) els.trackerStatusTitle.textContent = title;
    if (els.trackerStatusDesc && desc) els.trackerStatusDesc.textContent = desc;
    if (els.trackerProgressBar && progressPercent !== undefined) {
      els.trackerProgressBar.style.width = `${Math.min(100, Math.max(5, progressPercent))}%`;
    }

    // Step 1: NSE
    if (els.stepNSE && step1Status) {
      els.stepNSE.className = `tracker-step ${step1Status === 'done' ? 'completed' : (step1Status === 'loading' ? 'active' : '')}`;
      if (els.badgeNSE) {
        els.badgeNSE.className = `step-badge ${step1Status === 'done' ? 'badge-success' : (step1Status === 'loading' ? 'badge-loading' : (step1Status === 'warning' ? 'badge-warning' : 'badge-pending'))}`;
        if (step1Text) els.badgeNSE.textContent = step1Text;
      }
    }

    // Step 2: BSE
    if (els.stepBSE && step2Status) {
      els.stepBSE.className = `tracker-step ${step2Status === 'done' ? 'completed' : (step2Status === 'loading' ? 'active' : '')}`;
      if (els.badgeBSE) {
        els.badgeBSE.className = `step-badge ${step2Status === 'done' ? 'badge-success' : (step2Status === 'loading' ? 'badge-loading' : (step2Status === 'warning' ? 'badge-warning' : 'badge-pending'))}`;
        if (step2Text) els.badgeBSE.textContent = step2Text;
      }
    }

    // Step 3: Unified
    if (els.stepUnified && step3Status) {
      els.stepUnified.className = `tracker-step ${step3Status === 'done' ? 'completed' : (step3Status === 'loading' ? 'active' : '')}`;
      if (els.badgeUnified) {
        els.badgeUnified.className = `step-badge ${step3Status === 'done' ? 'badge-success' : (step3Status === 'loading' ? 'badge-loading' : 'badge-pending')}`;
        if (step3Text) els.badgeUnified.textContent = step3Text;
      }
    }

    // Spinner
    if (els.trackerSpinner) {
      if (isComplete) {
        els.trackerSpinner.classList.add('done');
        els.trackerSpinner.textContent = '✅';
      } else {
        els.trackerSpinner.classList.remove('done');
        els.trackerSpinner.textContent = '🔄';
      }
    }

    // Live Sync Time Badge
    if (els.trackerTimeText) {
      const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      els.trackerTimeText.textContent = isComplete ? `Synced at ${nowStr}` : 'Live Sync Active';
    }
  }

  // Progressive Multi-Exchange Fetch: Show NSE First, Then Merge BSE with Live Top Progress
  async function fetchExchangeData() {
    if (isFetching) return;
    isFetching = true;
    updateRefreshButton(true);

    let nseList = [];
    let bseList = [];

    try {
      // Step 1: Start Progress Tracker
      updateProgressTracker({
        stageBadge: 'Step 1 of 2: NSE India',
        title: 'Fetching NSE India Issues & Anchor Reports...',
        desc: 'Requesting current issues and anchor allocation reports from NSE...',
        progressPercent: 20,
        step1Status: 'loading',
        step1Text: 'Fetching issues...',
        step2Status: 'pending',
        step2Text: 'Waiting for NSE...',
        step3Status: 'pending',
        step3Text: 'Pending',
        isComplete: false
      });

      // 1. Fetch NSE India first
      try {
        const nseRes = await fetch(`/api/nse/ipo-list?t=${Date.now()}`, { cache: 'no-cache' });
        if (nseRes.ok) {
          const nseData = await nseRes.json();
          if (nseData && Array.isArray(nseData.ipos)) {
            nseList = nseData.ipos;
          }
        }
      } catch (nseErr) {
        console.warn('[ANCHOR] NSE fetch error:', nseErr.message);
      }

      // If NSE returned items, SHOW THEM IMMEDIATELY IN THE TABLE!
      if (nseList.length > 0) {
        ipoList = nseList.map(formatNseItem);
        processAnchorDiff(ipoList);
        renderUI();

        updateProgressTracker({
          stageBadge: 'Step 2 of 2: BSE India',
          title: `✅ NSE Loaded (${nseList.length} IPOs) · Now Fetching BSE India...`,
          desc: `Displaying ${nseList.length} NSE issues. Indexing BSE live notices & public issues...`,
          progressPercent: 55,
          step1Status: 'done',
          step1Text: `✅ ${nseList.length} Loaded`,
          step2Status: 'loading',
          step2Text: 'Fetching BSE...',
          step3Status: 'pending',
          step3Text: 'Waiting for BSE...'
        });
      } else {
        updateProgressTracker({
          stageBadge: 'Step 2 of 2: BSE India',
          title: 'Fetching BSE India Issues & Anchor Notices...',
          desc: 'Connecting to BSE India feed and indexing notices...',
          progressPercent: 40,
          step1Status: 'warning',
          step1Text: 'NSE 0 Issues',
          step2Status: 'loading',
          step2Text: 'Fetching BSE...',
          step3Status: 'pending',
          step3Text: 'Pending'
        });
      }

      // 2. Fetch BSE India
      try {
        const bseRes = await fetch(`/api/bse/ipo-list?t=${Date.now()}`, { cache: 'no-cache' });
        if (bseRes.ok) {
          const bseData = await bseRes.json();
          if (bseData && Array.isArray(bseData.ipos)) {
            bseList = bseData.ipos;
          }
        }
      } catch (bseErr) {
        console.warn('[ANCHOR] BSE fetch error:', bseErr.message);
      }

      // If NSE had failed but BSE succeeded, show BSE immediately before unifying
      if (nseList.length === 0 && bseList.length > 0) {
        ipoList = bseList.map(formatBseItem);
        processAnchorDiff(ipoList);
        renderUI();
      }

      updateProgressTracker({
        stageBadge: 'Finalizing',
        title: '🔗 Unifying Cross-Exchange IPOs & Sorting Timeline...',
        desc: `Merging ${nseList.length} NSE issues and ${bseList.length} BSE issues...`,
        progressPercent: 88,
        step1Status: nseList.length > 0 ? 'done' : 'warning',
        step1Text: nseList.length > 0 ? `✅ ${nseList.length} Loaded` : 'No NSE',
        step2Status: bseList.length > 0 ? 'done' : 'warning',
        step2Text: bseList.length > 0 ? `✅ ${bseList.length} Loaded` : 'No BSE',
        step3Status: 'loading',
        step3Text: 'Merging...'
      });

      // 3. Merge Both Exchanges
      const unifiedList = mergeNseAndBse(nseList, bseList);

      if (unifiedList.length > 0) {
        ipoList = unifiedList;
      } else {
        // Fallback to local snapshot file if both were empty (e.g. on GitHub Pages)
        try {
          const fbRes = await fetch(`${FALLBACK_URL}?t=${Date.now()}`, { cache: 'no-cache' });
          if (fbRes.ok) {
            const fbData = await fbRes.json();
            ipoList = fbData.ipos || fbData;
            if (Array.isArray(ipoList)) {
              if (nseList.length === 0) {
                nseList = ipoList.filter(i => (i.platforms && i.platforms.includes('NSE')) || (i.exchange && i.exchange.includes('NSE')));
              }
              if (bseList.length === 0) {
                bseList = ipoList.filter(i => (i.platforms && i.platforms.includes('BSE')) || (i.exchange && i.exchange.includes('BSE')));
              }
            }
          }
        } catch (fbErr) {
          console.warn('[ANCHOR] Snapshot fallback error:', fbErr.message);
        }
      }

      processAnchorDiff(ipoList);
      renderUI();

      const totalAnchors = ipoList.filter(i => i.anchor && i.anchor.available).length;
      updateProgressTracker({
        stageBadge: 'Live Sync Active',
        title: `✅ All Exchanges Unified (${ipoList.length} IPOs · ${totalAnchors} Anchor Reports Released)`,
        desc: `Synchronized: NSE (${nseList.length}) + BSE (${bseList.length}) with live notice attachments cross-linked.`,
        progressPercent: 100,
        step1Status: nseList.length > 0 ? 'done' : 'warning',
        step1Text: `✅ ${nseList.length} NSE`,
        step2Status: bseList.length > 0 ? 'done' : 'warning',
        step2Text: `✅ ${bseList.length} BSE`,
        step3Status: 'done',
        step3Text: `✅ ${ipoList.length} Unified`,
        isComplete: true
      });

      if (els.lastUpdatedText) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        els.lastUpdatedText.textContent = `${timeStr} · Live (NSE + BSE India)`;
        els.lastUpdatedText.style.color = '';
      }

    } catch (err) {
      console.error('[ANCHOR] Progressive fetch error:', err);
      updateProgressTracker({
        stageBadge: 'Error',
        title: '⚠️ Failed to synchronize all exchanges',
        desc: err.message,
        progressPercent: 100,
        step1Status: 'warning',
        step1Text: 'Error',
        step2Status: 'warning',
        step2Text: 'Error',
        step3Status: 'warning',
        step3Text: 'Failed'
      });
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
    let todayCount = 0;
    let dualCount = 0;
    let activeCount = 0;

    ipoList.forEach(i => {
      if (i.anchor && i.anchor.available) anchorCount++;
      if (i.anchorEligibility && i.anchorEligibility.isToday) todayCount++;
      if (i.exchange && i.exchange.includes('BSE') && i.exchange.includes('NSE')) dualCount++;
      if (i.status && i.status.toLowerCase() === 'active') activeCount++;
    });

    if (els.statTotal) els.statTotal.textContent = total;
    if (els.statAnchorCount) els.statAnchorCount.textContent = anchorCount;
    if (els.statDual) els.statDual.textContent = dualCount;
    if (els.statActive) els.statActive.textContent = activeCount;

    // Due today filter chip
    const todayChip = document.querySelector('.chip[data-filter="today"]');
    if (todayChip) {
      todayChip.textContent = `🔔 Due Today (${todayCount})`;
      if (todayCount > 0) todayChip.classList.add('chip-alert');
      else todayChip.classList.remove('chip-alert');
    }

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

    if (currentFilter === 'today') {
      list = list.filter(i => i.anchorEligibility && i.anchorEligibility.isToday);
    } else if (currentFilter === 'anchor') {
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

    function getSortTier(item) {
      const elig = item.anchorEligibility || {};
      if (elig.isToday) return 1; // 1. Today list first
      if (elig.isUpcoming) return 2; // 2. Next coming after
      return 3; // 3. Live IPO list (active bidding / open)
    }

    switch (currentSort) {
      case 'today-timeline':
      default:
        list.sort((a, b) => {
          const tierA = getSortTier(a);
          const tierB = getSortTier(b);
          if (tierA !== tierB) return tierA - tierB;

          // Inside upcoming tier, sort by daysToGo ascending (soonest first)
          if (tierA === 2) {
            const aDays = (a.anchorEligibility && a.anchorEligibility.daysToGo) || 99;
            const bDays = (b.anchorEligibility && b.anchorEligibility.daysToGo) || 99;
            if (aDays !== bDays) return aDays - bDays;
          }

          // Inside live tier, anchor available first
          if (tierA === 3) {
            const aHas = a.anchor && a.anchor.available ? 1 : 0;
            const bHas = b.anchor && b.anchor.available ? 1 : 0;
            if (aHas !== bHas) return bHas - aHas;
          }

          return (a.symbol || '').localeCompare(b.symbol || '');
        });
        break;
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

      const elig = ipo.anchorEligibility || {};
      const isToday = !!elig.isToday;

      // Row highlight:
      // 1. Live surge (if newly released or simulating) -> anchor-active-highlight (bright pulsing green/amber)
      // 2. Already allocated -> allocated row
      // 3. Due today but not yet released -> anchor-today-pending (amber glow reminder)
      let rowClass = 'ipo-row';
      if (isSurgeActive) {
        rowClass = 'ipo-row anchor-active-highlight';
      } else if (isAnchorAvailable) {
        rowClass = 'ipo-row anchor-allocated-row';
      } else if (isToday) {
        rowClass = 'ipo-row anchor-today-pending';
      }

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
              ${ipo.anchor.bseNoticePdfUrl && ipo.anchor.bseNoticePdfUrl !== ipo.anchor.bseIntimationPdfUrl ? `
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
        let badgeClass = 'anchor-badge pending';
        let label = '⏳ Not Released';
        if (isToday) {
          badgeClass = 'anchor-badge today-pending';
          label = '🔔 Due Today (Watch!)';
        } else if (elig.isUpcoming) {
          badgeClass = 'anchor-badge upcoming-notice';
          label = `🕒 Upcoming (${elig.daysToGo || ''}d to go)`;
        }

        anchorHtml = `
          <div class="anchor-status-box">
            <span class="${badgeClass}">${label}</span>
            <button class="btn-check-exchange" onclick="window.checkIpoLive('${escapeQuotes(ipo.symbol)}', '${escapeQuotes(ipo.companyName)}')" title="Trigger on-demand check on NSE and BSE">
              🔍 Check Both Exchanges
            </button>
          </div>
        `;
      }

      // Date eligibility snippet
      let tagClass = 'anchor-eligibility-tag';
      if (isToday) tagClass += ' today';
      else if (elig.isUpcoming) tagClass += ' upcoming';
      else tagClass += ' due';

      const eligHtml = elig.message ? `
        <div class="${tagClass}">
          <span>${isToday ? '🔔' : (elig.isUpcoming ? '🕒' : '📋')}</span>
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
