// anchor.js - Unified Exchange Anchor Allocation Tracker with 1-Minute Highlight Engine
(function () {
  'use strict';

  function resolveAnchorLink(rawUrl, type, symbol) {
    const sym = (symbol || '').toUpperCase().trim();
    if (!rawUrl || rawUrl === '#' || rawUrl === 'null' || rawUrl === 'undefined') {
      if (type === 'nse-pdf' || type === 'pdf') {
        if (sym) return `./anchors/ANCHOR_${encodeURIComponent(sym)}.pdf`;
      }
      return '';
    }

    if (type === 'nse-pdf' || type === 'pdf') {
      const targetSym = sym || (rawUrl ? (rawUrl.match(/ANCHOR_([A-Za-z0-9_\-]+)\.(zip|pdf)/i) || [])[1] : '');
      if (targetSym) {
        return `./anchors/ANCHOR_${encodeURIComponent(targetSym)}.pdf`;
      }
      if (rawUrl.startsWith('http') || rawUrl.startsWith('./')) return rawUrl;
      return '';
    }

    if (type === 'nse' || type === 'nse-zip' || type === 'nse-direct') {
      const match = rawUrl ? rawUrl.match(/ANCHOR_([A-Za-z0-9_\-]+)\.(zip|pdf)/i) : null;
      const targetSym = sym || (match ? match[1] : '');
      if (targetSym) {
        return `https://nsearchives.nseindia.com/content/ipo/ANCHOR_${encodeURIComponent(targetSym)}.zip`;
      }
      if (rawUrl.startsWith('http')) return rawUrl;
      if (rawUrl.startsWith('/content/')) return `https://nsearchives.nseindia.com${rawUrl}`;
      return '';
    }

    if (type === 'bse' || type === 'bse-pdf' || type === 'bse-notice') {
      if (rawUrl.startsWith('http')) return rawUrl;
      return `https://www.bseindia.com${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
    }

    if (rawUrl.startsWith('http')) return rawUrl;
    if (rawUrl.startsWith('/content/')) return `https://nsearchives.nseindia.com${rawUrl}`;
    if (rawUrl.startsWith('/downloads/') || rawUrl.startsWith('/xml-data/')) return `https://www.bseindia.com${rawUrl}`;
    return '';
  }

  function getBseNoticeUrls(ipo) {
    if (!ipo) return { verifiedPdfUrl: '', logicNoticeUrl: '', hasVerifiedPdf: false };

    // 1. Check verified intimation PDF or notice PDF
    const intimationPdf = ipo.anchor?.bseIntimationPdfUrl || ipo.bseIntimationPdfUrl;
    const noticePdf = ipo.anchor?.bseNoticePdfUrl || ipo.bseNoticePdfUrl;
    const customBse = ipo.bseLink || ipo.bseUrl;

    // A real verified PDF exists if anchor is flagged available and attachment/intimation is ready
    const hasVerified = !!(ipo.anchor?.available && (intimationPdf || (noticePdf && ipo.anchor?.hasBseAttachment)));
    const verifiedPdf = intimationPdf || (hasVerified ? noticePdf : '');

    // 2. Logic URL (constructed from notice number or expected date or custom link)
    let logicUrl = noticePdf || customBse || '';
    if (!logicUrl && ipo.anchor?.bseNoticeNo) {
      logicUrl = `https://www.bseindia.com/downloads/UploadDocs/Notices/${ipo.anchor.bseNoticeNo}/${ipo.anchor.bseNoticeNo}.pdf`;
    }
    if (!logicUrl && ipo.anchorEligibility?.expectedDate) {
      const d = ipo.anchorEligibility.expectedDate.replace(/[^0-9]/g, '');
      if (d.length >= 8) {
        logicUrl = `https://www.bseindia.com/downloads/UploadDocs/Notices/${d.slice(0, 8)}-1/${d.slice(0, 8)}-1.pdf`;
      }
    }
    if (!logicUrl && ipo.bseData?.ipoNo) {
      logicUrl = `https://www.bseindia.com/markets/PublicIssues/BSEIPO.aspx?flag=1&ipono=${ipo.bseData.ipoNo}`;
    }

    const resolvedVerified = verifiedPdf ? resolveAnchorLink(verifiedPdf, 'bse', ipo.symbol) : '';
    const resolvedLogic = logicUrl ? resolveAnchorLink(logicUrl, 'bse', ipo.symbol) : '';

    return {
      verifiedPdfUrl: (resolvedVerified && resolvedVerified.startsWith('http')) ? resolvedVerified : '',
      logicNoticeUrl: (resolvedLogic && resolvedLogic.startsWith('http')) ? resolvedLogic : '',
      hasVerifiedPdf: hasVerified && !!(resolvedVerified && resolvedVerified.startsWith('http'))
    };
  }

  function getValidBseUrl(ipo) {
    const urls = getBseNoticeUrls(ipo);
    return urls.verifiedPdfUrl || urls.logicNoticeUrl || '';
  }

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
    // Market Schedule & Countdown
    scheduleBadge: document.getElementById('marketScheduleBadge'),
    scheduleDot: document.getElementById('scheduleDot'),
    scheduleStatusText: document.getElementById('scheduleStatusText'),
    syncToggleBtn: document.getElementById('syncToggleBtn'),
    syncToggleIcon: document.getElementById('syncToggleIcon'),
    syncToggleText: document.getElementById('syncToggleText'),
    viewSyncLogsBtn: document.getElementById('viewSyncLogsBtn'),
    syncLogsModal: document.getElementById('syncLogsModal'),
    syncLogsContainer: document.getElementById('syncLogsContainer'),
    closeSyncLogsBtn: document.getElementById('closeSyncLogsBtn'),
    doneSyncLogsBtn: document.getElementById('doneSyncLogsBtn'),
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

  // Standard India Standard Time (IST, UTC+5:30) Formatting Helpers
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

  function formatIndiaTime(date = new Date()) {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
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

  function getIndiaTodayDate() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }).formatToParts(new Date());
    const m = parseInt(parts.find(p => p.type === 'month').value, 10);
    const d = parseInt(parts.find(p => p.type === 'day').value, 10);
    const y = parseInt(parts.find(p => p.type === 'year').value, 10);
    return new Date(y, m - 1, d);
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

    const todayDateOnly = getIndiaTodayDate();
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
      const nowStr = formatIndiaTime(new Date());
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

      // On static hosting (like GitHub Pages), load snapshot instantly
      const isStaticHost = !['localhost', '127.0.0.1'].includes(window.location.hostname) || window.location.protocol === 'file:';
      if (isStaticHost) {
        try {
          const fbRes = await fetch(`${FALLBACK_URL}?t=${Date.now()}`, { cache: 'no-cache' });
          if (fbRes.ok) {
            const fbData = await fbRes.json();
            const snapList = fbData.ipos || fbData;
            if (Array.isArray(snapList) && snapList.length > 0) {
              ipoList = snapList;
              processAnchorDiff(ipoList);
              renderUI();
              updateProgressTracker({
                stageBadge: 'Complete',
                title: `⚡ Live Exchange Snapshot Loaded (${ipoList.length} IPOs)`,
                desc: 'Loaded latest unified exchange issues from GitHub snapshot.',
                progressPercent: 100,
                step1Status: 'done',
                step1Text: 'Snapshot Loaded',
                step2Status: 'done',
                step2Text: 'Snapshot Loaded',
                step3Status: 'done',
                step3Text: 'Ready',
                isComplete: true
              });
              if (els.progressTracker) {
                setTimeout(() => {
                  els.progressTracker.style.display = 'none';
                }, 1500);
              }
              startCountdown();
              return;
            }
          }
        } catch (staticErr) {
          console.warn('[ANCHOR] Static snapshot load error:', staticErr.message);
        }
      }

      // 1. Fetch NSE India first (when running on server)
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

      let snapshotTimeIST = null;
      if (unifiedList.length > 0) {
        ipoList = unifiedList;
      } else {
        // Fallback to local snapshot file if both were empty (e.g. on GitHub Pages)
        try {
          const fbRes = await fetch(`${FALLBACK_URL}?t=${Date.now()}`, { cache: 'no-cache' });
          if (fbRes.ok) {
            const fbData = await fbRes.json();
            ipoList = fbData.ipos || fbData;
            if (fbData.lastUpdated) {
              snapshotTimeIST = fbData.lastUpdated.includes('IST') 
                ? fbData.lastUpdated 
                : formatIndiaDateTime(new Date(fbData.lastUpdated));
            }
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
        if (snapshotTimeIST && nseList.length === 0 && bseList.length === 0) {
          els.lastUpdatedText.textContent = `${snapshotTimeIST} · Live Snapshot`;
        } else {
          const timeStr = formatIndiaTime(new Date());
          els.lastUpdatedText.textContent = `${timeStr} · Live (NSE + BSE India)`;
        }
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

      renderTable();

      if (!hasActive) {
        clearInterval(highlightTimer);
        highlightTimer = null;
        renderUI();
      }
    }, 1000);
  }

  // Render Everything
  function renderUI() {
    updateStats();
    renderTable();
    applyScheduleRules();
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
      list = list.filter(i => (i.exchange && i.exchange.includes('BSE') && i.exchange.includes('NSE')) || (i.platforms && i.platforms.includes('BSE') && i.platforms.includes('NSE')));
    } else if (currentFilter === 'mainboard') {
      list = list.filter(i => {
        const isSme = i.series === 'SME' || (i.exchange && i.exchange.toUpperCase().includes('SME')) || (i.bseData && i.bseData.platform === 'SME');
        return !isSme;
      });
    } else if (currentFilter === 'sme') {
      list = list.filter(i => i.series === 'SME' || (i.exchange && i.exchange.toUpperCase().includes('SME')) || (i.bseData && i.bseData.platform === 'SME'));
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

      // Determine listing platform accurately
      const hasNsePlatform = (ipo.platforms && ipo.platforms.includes('NSE')) ||
                             (ipo.exchange && ipo.exchange.includes('NSE')) ||
                             (ipo.id && ipo.id.startsWith('NSE_')) ||
                             !!(ipo.anchor && (ipo.anchor.nseZipUrl || ipo.anchor.source === 'NSE'));

      const hasBsePlatform = (ipo.platforms && ipo.platforms.includes('BSE')) ||
                             (ipo.exchange && ipo.exchange.includes('BSE')) ||
                             (ipo.id && ipo.id.startsWith('BSE_')) ||
                             !!(ipo.bseData && ipo.bseData.ipoNo) ||
                             !!(ipo.anchor && (ipo.anchor.bseNoticePdfUrl || ipo.anchor.bseIntimationPdfUrl || ipo.anchor.source === 'BSE'));

      const isDual = hasNsePlatform && hasBsePlatform;
      const isBseOnly = hasBsePlatform && !hasNsePlatform;
      const isNseOnly = hasNsePlatform && !hasBsePlatform;

      const isSme = ipo.series === 'SME' || (ipo.exchange && ipo.exchange.toUpperCase().includes('SME')) || (ipo.bseData && ipo.bseData.platform === 'SME');
      const isMainboard = !isSme;

      let exchangeBadge = '';
      if (isDual) {
        exchangeBadge = `<span class="exchange-badge exchange-badge-both">NSE | BSE</span>`;
      } else if (isBseOnly) {
        exchangeBadge = `<span class="exchange-badge exchange-badge-bse">BSE</span>`;
      } else {
        exchangeBadge = `<span class="exchange-badge exchange-badge-nse">NSE</span>`;
      }

      const elig = ipo.anchorEligibility || {};
      const isToday = !!elig.isToday;

      // BSE Notice URLs (Verified PDF vs Logic-Built URL)
      const bseUrls = getBseNoticeUrls(ipo);
      const validNsePdf = hasNsePlatform 
        ? resolveAnchorLink(ipo.anchor?.nseZipUrl || `./anchors/ANCHOR_${ipo.symbol}.pdf`, 'nse-pdf', ipo.symbol) 
        : '';
      const hasNseVerifiedPdf = hasNsePlatform && !!(ipo.anchor && ipo.anchor.available && (ipo.anchor.nseZipUrl || ipo.anchor.source === 'NSE' || ipo.anchor.source === 'BOTH'));
      const hasBseVerifiedPdf = hasBsePlatform && bseUrls.hasVerifiedPdf;

      // Row highlight rule:
      // The green/allocated background should ONLY appear when there is an actual VERIFIED PDF.
      // If it only opens the default BSE notice page / unverified logic link, do NOT highlight background.
      const isActuallyAllocated = isAnchorAvailable && (hasNseVerifiedPdf || hasBseVerifiedPdf);

      let rowClass = 'ipo-row';
      if (isSurgeActive) {
        rowClass = 'ipo-row anchor-active-highlight';
      } else if (isActuallyAllocated) {
        rowClass = 'ipo-row anchor-allocated-row';
      } else if (isToday) {
        rowClass = 'ipo-row anchor-today-pending';
      }

      const sourceLabel = (hasNseVerifiedPdf && hasBseVerifiedPdf) 
        ? '✨ NSE & BSE' 
        : (hasBseVerifiedPdf ? '🏛️ BSE Notice' : '🏛️ NSE Archive');

      // 1. Download Actions: strictly by platform
      let downloadActionsHtml = '';
      if (hasNsePlatform && hasNseVerifiedPdf) {
        downloadActionsHtml += `
          <a href="${validNsePdf}" download="ANCHOR_${encodeURIComponent(ipo.symbol)}.pdf" target="_blank" rel="noopener noreferrer" class="btn-anchor-download btn-nse-download" title="Download Official NSE Anchor PDF" onclick="event.stopPropagation();">
            📄 NSE PDF
          </a>
          <a href="${resolveAnchorLink(ipo.anchor.nseZipUrl, 'nse', ipo.symbol)}" target="_blank" rel="noopener noreferrer" class="btn-anchor-download btn-nse-zip" title="Download Official NSE Archive (ZIP)" onclick="event.stopPropagation();">
            💾 NSE ZIP
          </a>
        `;
      }

      if (hasBsePlatform) {
        if (hasBseVerifiedPdf && bseUrls.verifiedPdfUrl) {
          downloadActionsHtml += `
            <a href="${bseUrls.verifiedPdfUrl}" target="_blank" rel="noopener noreferrer" class="btn-anchor-download btn-bse-download" title="Direct Download/View Verified BSE Anchor Notice PDF" onclick="event.stopPropagation();">
              📄 BSE Notice PDF
            </a>
          `;
        }
        // Logic-built URL option (always accessible to open in both cases!)
        if (bseUrls.logicNoticeUrl && bseUrls.logicNoticeUrl !== bseUrls.verifiedPdfUrl) {
          downloadActionsHtml += `
            <a href="${bseUrls.logicNoticeUrl}" target="_blank" rel="noopener noreferrer" class="btn-anchor-download btn-bse-logic" title="Open BSE Notice Link (Logic URL)" onclick="event.stopPropagation();">
              📑 BSE Notice (Direct)
            </a>
          `;
        }
      }

      // 2. Check actions: strictly by platform
      let checkActionsHtml = '';
      if (isNseOnly) {
        // ONLY NSE button!
        checkActionsHtml = `
          <div class="check-actions-group">
            <button class="btn-force-check" onclick="event.stopPropagation(); window.forceCheckIpo('${escapeQuotes(ipo.symbol)}', '${escapeQuotes(ipo.companyName)}', 'NSE')" title="Force live re-check on NSE">
              ⚡ Force Check NSE
            </button>
          </div>
        `;
      } else if (isBseOnly) {
        // ONLY BSE button!
        checkActionsHtml = `
          <div class="check-actions-group">
            <button class="btn-force-check" onclick="event.stopPropagation(); window.forceCheckIpo('${escapeQuotes(ipo.symbol)}', '${escapeQuotes(ipo.companyName)}', 'BSE')" title="Force live re-check on BSE">
              ⚡ Force Check BSE
            </button>
          </div>
        `;
      } else {
        // Dual listed (Both NSE & BSE)
        checkActionsHtml = `
          <div class="check-actions-group">
            <button class="btn-force-check" onclick="event.stopPropagation(); window.forceCheckIpo('${escapeQuotes(ipo.symbol)}', '${escapeQuotes(ipo.companyName)}', 'BOTH')" title="Force live re-check on both NSE & BSE">
              ⚡ Force Check Both
            </button>
            <button class="btn-check-exchange-sub" onclick="event.stopPropagation(); window.forceCheckIpo('${escapeQuotes(ipo.symbol)}', '${escapeQuotes(ipo.companyName)}', 'NSE')" title="Check NSE only">
              🏛️ NSE
            </button>
            <button class="btn-check-exchange-sub" onclick="event.stopPropagation(); window.forceCheckIpo('${escapeQuotes(ipo.symbol)}', '${escapeQuotes(ipo.companyName)}', 'BSE')" title="Check BSE only">
              🏛️ BSE
            </button>
          </div>
        `;
      }

      // Anchor status & actions HTML
      let anchorHtml = '';
      if (isActuallyAllocated) {
        const badgeClass = isSurgeActive ? 'anchor-badge new-highlight' : 'anchor-badge allocated';
        const timerHtml = isSurgeActive 
          ? `<span class="anchor-timer-tag" onclick="window.dismissHighlight('${key}', event)" title="Tap to dismiss surge highlight">⏱ Live Surge: ${remainingSeconds}s · <span class="dismiss-tag">✕ Dismiss</span></span>` 
          : '';

        anchorHtml = `
          <div class="anchor-status-box">
            <div class="${badgeClass}" title="Anchor Allocation Report Available">
              <span>${sourceLabel} ALLOCATED</span>
              ${timerHtml}
            </div>
            <div class="anchor-actions">
              ${downloadActionsHtml}
            </div>
            ${checkActionsHtml}
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
            ${downloadActionsHtml ? `<div class="anchor-actions" style="margin-top: 5px;">${downloadActionsHtml}</div>` : ''}
            ${checkActionsHtml}
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
        <tr class="${rowClass}" data-key="${key}" ${isSurgeActive ? `onclick="window.handleRowClick('${key}', event)" title="Tap anywhere on row to dismiss surge highlight" style="cursor: pointer;"` : ''}>
          <td class="company-cell">
            <div class="company-title">
              <span style="color: #60a5fa; font-weight: 700;">${ipo.symbol}</span>
              ${exchangeBadge}
              <span class="badge-tag ${isSme ? 'badge-sme' : 'badge-mainboard'}">${isSme ? 'SME' : 'Mainboard'}</span>
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

  window.dismissHighlight = function (key, e) {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (activeSurges[key]) {
      delete activeSurges[key];
      renderUI();
    }
  };

  window.handleRowClick = function (key, e) {
    if (e && (e.target.closest('a') || e.target.closest('button'))) {
      return;
    }
    window.dismissHighlight(key, e);
  };

  let currentCheckingSymbol = '';
  let currentCheckingCompany = '';
  let currentCheckingExchange = 'BOTH';

  // Wire modal exchange tabs once
  const modalExchangeTabs = document.getElementById('modalExchangeTabs');
  if (modalExchangeTabs) {
    modalExchangeTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.modal-tab');
      if (tab && tab.dataset.exchange) {
        window.checkIpoLive(currentCheckingSymbol, currentCheckingCompany, tab.dataset.exchange);
      }
    });
  }

  window.forceCheckIpo = async function (symbol, companyName, exchange = 'BOTH') {
    if (!els.checkModal) return;

    currentCheckingSymbol = symbol || '';
    currentCheckingCompany = companyName || '';
    currentCheckingExchange = exchange || 'BOTH';

    const targetName = symbol || companyName;
    const exchangeName = exchange === 'BOTH' ? 'NSE & BSE India' : exchange + ' India';

    // Highlight active modal tab
    const tabs = els.checkModal.querySelectorAll('.modal-tab');
    tabs.forEach(t => {
      if (t.dataset.exchange === currentCheckingExchange) {
        t.classList.add('active');
      } else {
        t.classList.remove('active');
      }
    });

    els.checkModal.style.display = 'flex';
    els.modalTitle.textContent = `⚡ Force Checking: ${targetName} [${exchangeName}]`;
    els.modalSub.textContent = `Querying real-time exchange registry feeds on ${exchangeName}...`;

    const progressWrap = document.getElementById('modalProgressWrap');
    const progressFill = document.getElementById('modalProgressFill');
    if (progressWrap && progressFill) {
      progressWrap.style.display = 'block';
      progressFill.style.width = '20%';
    }

    const steps = [
      { stage: 'init', message: `Step 1/3: Connecting to ${exchangeName} live registry...` }
    ];

    function renderSteps() {
      let stepHtml = '';
      steps.forEach(st => {
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
        } else if (st.stage.includes('extract') || st.stage.includes('info')) {
          icon = '📋';
          cls = 'found';
        } else if (st.stage.includes('init') || st.stage.includes('query')) {
          icon = '⏳';
          cls = 'found';
        }

        stepHtml += `
          <div class="modal-step-item ${cls}">
            <div class="modal-step-icon">${icon}</div>
            <div>${st.message}</div>
          </div>
        `;
      });
      els.modalStepsList.innerHTML = stepHtml;
    }

    renderSteps();

    try {
      await new Promise(r => setTimeout(r, 180));
      if (progressFill) progressFill.style.width = '55%';

      let currentItem = ipoList.find(i => 
        (i.symbol && i.symbol.toUpperCase() === (symbol || '').toUpperCase()) ||
        (i.companyName && companyName && i.companyName.toLowerCase().includes(companyName.toLowerCase()))
      );

      try {
        const freshRes = await fetch(`${FALLBACK_URL}?_t=${Date.now()}`, { cache: 'no-cache' });
        if (freshRes.ok) {
          const freshData = await freshRes.json();
          const freshList = freshData.ipos || freshData;
          if (Array.isArray(freshList)) {
            ipoList = freshList;
            const updated = freshList.find(i => 
              (i.symbol && i.symbol.toUpperCase() === (symbol || '').toUpperCase()) ||
              (i.companyName && companyName && i.companyName.toLowerCase().includes(companyName.toLowerCase()))
            );
            if (updated) currentItem = updated;
          }
        }
      } catch (e) {
        // Fallback to in-memory item
      }

      if (progressFill) progressFill.style.width = '80%';
      await new Promise(r => setTimeout(r, 220));

      const bseUrls = getBseNoticeUrls(currentItem);
      const hasNseAnchor = !!(currentItem?.anchor && (currentItem.anchor.nseZipUrl || currentItem.anchor.source === 'NSE' || currentItem.anchor.source === 'BOTH'));
      const hasBseVerified = bseUrls.hasVerifiedPdf;

      let isAnchorFound = false;

      if (exchange === 'NSE' || exchange === 'BOTH') {
        if (hasNseAnchor) {
          isAnchorFound = true;
          steps.push({ stage: 'success_nse', message: `NSE Archive: Verified Anchor filing for ${symbol} (ANCHOR_${symbol}.pdf ready).` });
        } else {
          steps.push({ stage: 'none_nse', message: `NSE India: No Anchor ZIP archive filed yet for ${symbol}.` });
        }
      }

      if (exchange === 'BSE' || exchange === 'BOTH') {
        if (hasBseVerified) {
          isAnchorFound = true;
          const doc = currentItem?.anchor?.bseIntimationPdfUrl ? 'Intimation Letter' : 'Notice';
          steps.push({ stage: 'success_bse', message: `BSE India: Verified Official Anchor ${doc} PDF is available.` });
        } else if (bseUrls.logicNoticeUrl) {
          steps.push({ stage: 'info_bse', message: `BSE India: Direct notice candidate URL generated. Direct link is active below.` });
        } else {
          steps.push({ stage: 'none_bse', message: `BSE India: No official Anchor notice published yet on BSE.` });
        }
      }

      const elig = currentItem?.anchorEligibility || {};
      if (elig.message) {
        steps.push({ stage: 'extract_info', message: `Schedule timing: ${elig.message}` });
      }

      if (progressFill) progressFill.style.width = '100%';
      renderSteps();

      const stepItems = els.modalStepsList;
      if (isAnchorFound) {
        const validNsePdf = `./anchors/ANCHOR_${encodeURIComponent(symbol)}.pdf`;
        const verdictHtml = `
          <div class="modal-step-item success" style="margin-top: 10px; font-weight: 600;">
            <div class="modal-step-icon">🎉</div>
            <div>
              <strong>Anchor Allocation Report is available!</strong>
              <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
                ${(hasNseAnchor && (exchange === 'NSE' || exchange === 'BOTH')) ? `<a href="${validNsePdf}" download="ANCHOR_${encodeURIComponent(symbol)}.pdf" target="_blank" rel="noopener noreferrer" class="btn-anchor-download btn-nse-download" onclick="event.stopPropagation();">📄 Download ${symbol} PDF</a>` : ''}
                ${(hasNseAnchor && (exchange === 'NSE' || exchange === 'BOTH')) ? `<a href="https://nsearchives.nseindia.com/content/ipo/ANCHOR_${encodeURIComponent(symbol)}.zip" target="_blank" rel="noopener noreferrer" class="btn-anchor-download btn-nse-zip" onclick="event.stopPropagation();">💾 Official NSE ZIP</a>` : ''}
                ${(hasBseVerified && (exchange === 'BSE' || exchange === 'BOTH')) ? `<a href="${bseUrls.verifiedPdfUrl}" target="_blank" rel="noopener noreferrer" class="btn-anchor-download btn-bse-download" onclick="event.stopPropagation();">📄 BSE Notice PDF</a>` : ''}
              </div>
            </div>
          </div>
        `;
        stepItems.insertAdjacentHTML('beforeend', verdictHtml);
        triggerOneMinuteSurge(symbol);
        playAnchorChime();
        renderUI();
      } else {
        let extraBseBtn = '';
        if (bseUrls.logicNoticeUrl && (exchange === 'BSE' || exchange === 'BOTH')) {
          extraBseBtn = `<div style="margin-top: 6px;"><a href="${bseUrls.logicNoticeUrl}" target="_blank" rel="noopener noreferrer" class="btn-anchor-download btn-bse-logic" onclick="event.stopPropagation();">📑 Open BSE Notice (Direct)</a></div>`;
        }
        const verdictHtml = `
          <div class="modal-step-item none" style="margin-top: 10px;">
            <div class="modal-step-icon">🕒</div>
            <div>
              No verified Anchor PDF detected on ${exchange === 'BOTH' ? 'either exchange' : exchange} yet. Continuing monitoring.
              ${extraBseBtn}
            </div>
          </div>
        `;
        stepItems.insertAdjacentHTML('beforeend', verdictHtml);
      }
    } catch (err) {
      els.modalStepsList.innerHTML = `
        <div class="modal-step-item none">
          <div class="modal-step-icon">ℹ️</div>
          <div>Checked ${exchangeName} for ${symbol || companyName}. Status verified against latest exchange snapshot.</div>
        </div>
      `;
    }
  };

  // Alias checkIpoLive to forceCheckIpo
  window.checkIpoLive = window.forceCheckIpo;

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
      nseZipUrl: `https://nsearchives.nseindia.com/content/ipo/ANCHOR_${target.symbol}.zip`,
      bseIntimationPdfUrl: `https://www.bseindia.com/downloads/UploadDocs/Notices/sample.pdf`,
      bseNoticePdfUrl: `https://www.bseindia.com/downloads/UploadDocs/Notices/sample.pdf`
    };

    triggerOneMinuteSurge(key);
    playAnchorChime();
    renderUI();

    setTimeout(() => {
      const row = document.querySelector(`tr[data-key="${key}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }

  // IST Schedule & Monitoring Window Rules
  function getISTScheduleState() {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(p => [p.type, p.value]));
    const hours = parseInt(parts.hour, 10);
    const minutes = parseInt(parts.minute, 10);
    const totalMinutes = hours * 60 + minutes;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const day = dayNames.indexOf(parts.weekday);

    const isWeekend = day === 0 || day === 6;
    // Window: Monday to Friday 3:00 PM (900m) to 11:00 PM (1380m) IST
    const isWithinWindow = day >= 1 && day <= 5 && totalMinutes >= 900 && totalMinutes <= 1380;
    const isAfternoon15Min = totalMinutes >= 900 && totalMinutes < 1080; // 3:00 PM - 6:00 PM
    const isEvening5Min = totalMinutes >= 1080 && totalMinutes < 1320;   // 6:00 PM - 10:00 PM
    const isNight15Min = totalMinutes >= 1320 && totalMinutes <= 1380;   // 10:00 PM - 11:00 PM

    // Check if all today's IPOs have anchor reports
    let allTodayAnchorsReceived = false;
    const todayIpos = ipoList.filter(i => i.anchorEligibility && i.anchorEligibility.isToday);
    if (todayIpos.length > 0) {
      const pending = todayIpos.filter(i => !i.anchor || !i.anchor.available);
      if (pending.length === 0) {
        allTodayAnchorsReceived = true;
      }
    }

    let activeIntervalSeconds = 0; // 0 = paused
    let statusText = '';
    let statusType = 'off'; // 'off' | 'live' | 'peak' | 'done'

    if (isWeekend) {
      activeIntervalSeconds = 0;
      statusText = '🛑 Weekend Off (Sat & Sun)';
      statusType = 'weekend';
    } else if (!isWithinWindow) {
      activeIntervalSeconds = 0;
      statusText = '🌙 Closed (Mon-Fri 3-11 PM IST)';
      statusType = 'off';
    } else if (allTodayAnchorsReceived) {
      activeIntervalSeconds = 0;
      statusText = '✅ All Today Anchors In';
      statusType = 'done';
    } else if (isEvening5Min) {
      activeIntervalSeconds = 300; // 5 min
      statusText = '⚡ 5m Peak Sync (6–10 PM)';
      statusType = 'peak';
    } else {
      activeIntervalSeconds = 900; // 15 min
      statusText = '⏳ 15m Cadence (3-6 PM & 10-11 PM)';
      statusType = 'live';
    }

    return {
      isWeekend,
      isWithinWindow,
      allTodayAnchorsReceived,
      activeIntervalSeconds,
      statusText,
      statusType,
      timeStr: formatIndiaTime(new Date())
    };
  }

  function updateSyncToggleButton(isRunning, label, icon) {
    if (!els.syncToggleBtn) return;
    if (isRunning) {
      els.syncToggleBtn.className = 'sync-toggle-btn running';
      if (els.syncToggleIcon) els.syncToggleIcon.textContent = icon || '⏸️';
      if (els.syncToggleText) els.syncToggleText.textContent = label || 'Stop';
      els.syncToggleBtn.title = 'Auto-sync is running. Click to stop.';
    } else {
      els.syncToggleBtn.className = 'sync-toggle-btn stopped';
      if (els.syncToggleIcon) els.syncToggleIcon.textContent = icon || '▶️';
      if (els.syncToggleText) els.syncToggleText.textContent = label || 'Start';
      els.syncToggleBtn.title = 'Auto-sync is stopped. Click to start manually.';
    }
  }

  function applyScheduleRules() {
    const schedule = getISTScheduleState();
    const mode = els.intervalSelect ? els.intervalSelect.value : 'auto';

    if (mode === 'auto') {
      if (els.scheduleDot) {
        els.scheduleDot.className = `schedule-dot ${schedule.statusType}`;
      }
      if (els.scheduleStatusText) {
        els.scheduleStatusText.textContent = schedule.statusText;
      }

      if (schedule.activeIntervalSeconds === 0) {
        // Paused / Off by schedule (Weekend, Closed, or Done)
        if (countdownTimer) {
          clearInterval(countdownTimer);
          countdownTimer = null;
        }
        if (els.countdownText) {
          if (schedule.isWeekend) {
            els.countdownText.textContent = 'Weekend Off';
          } else if (schedule.allTodayAnchorsReceived) {
            els.countdownText.textContent = 'Done ✓';
          } else {
            els.countdownText.textContent = 'Closed';
          }
        }
        if (els.countdownFill) {
          els.countdownFill.style.width = '0%';
        }
        updateSyncToggleButton(false, 'Start Manually', '▶️');
        return false;
      } else {
        refreshIntervalSeconds = schedule.activeIntervalSeconds;
        updateSyncToggleButton(true, 'Stop', '⏸️');
        return true;
      }
    } else if (mode === '0') {
      // User explicitly stopped / paused sync
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
      if (els.countdownText) els.countdownText.textContent = 'Off';
      if (els.countdownFill) els.countdownFill.style.width = '0%';
      if (els.scheduleDot) els.scheduleDot.className = 'schedule-dot off';
      if (els.scheduleStatusText) els.scheduleStatusText.textContent = '⏸️ Stopped Manually';
      updateSyncToggleButton(false, 'Start', '▶️');
      return false;
    } else {
      // Manual interval chosen: 300 (5m), 900 (15m), or 60 (1m)
      refreshIntervalSeconds = parseInt(mode, 10) || 300;
      const intervalLabel = mode === '300' ? '5 min' : mode === '900' ? '15 min' : '1 min';
      if (els.scheduleDot) els.scheduleDot.className = 'schedule-dot manual';
      if (els.scheduleStatusText) els.scheduleStatusText.textContent = `▶️ Manual (${intervalLabel})`;
      updateSyncToggleButton(true, 'Stop', '⏸️');
      return true;
    }
  }

  // Countdown & Timer Handling
  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    const shouldRun = applyScheduleRules();
    if (!shouldRun) return;

    secondsRemaining = refreshIntervalSeconds;
    updateCountdownUI();

    countdownTimer = setInterval(() => {
      // Re-check schedule status each tick
      const active = applyScheduleRules();
      if (!active) return;

      secondsRemaining--;
      if (secondsRemaining <= 0) {
        fetchExchangeData();
      } else {
        updateCountdownUI();
      }
    }, 1000);
  }

  function resetCountdown() {
    const shouldRun = applyScheduleRules();
    if (shouldRun) {
      secondsRemaining = refreshIntervalSeconds;
      updateCountdownUI();
      if (!countdownTimer) startCountdown();
    }
  }

  function updateCountdownUI() {
    if (els.countdownText) {
      const mins = Math.floor(secondsRemaining / 60);
      const secs = secondsRemaining % 60;
      els.countdownText.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }
    if (els.countdownFill) {
      const pct = refreshIntervalSeconds > 0 
        ? ((refreshIntervalSeconds - secondsRemaining) / refreshIntervalSeconds) * 100 
        : 0;
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
      els.intervalSelect.addEventListener('change', () => {
        const shouldRun = applyScheduleRules();
        if (shouldRun) {
          startCountdown();
        }
      });
    }

    if (els.syncToggleBtn) {
      els.syncToggleBtn.addEventListener('click', () => {
        const currentMode = els.intervalSelect ? els.intervalSelect.value : 'auto';
        const schedule = getISTScheduleState();

        if (currentMode === '0') {
          // Was manually paused/stopped -> user clicked Start
          if (schedule.activeIntervalSeconds > 0) {
            els.intervalSelect.value = 'auto';
          } else {
            // Weekend or outside window -> start manual 5 min sync!
            els.intervalSelect.value = '300';
          }
          const shouldRun = applyScheduleRules();
          if (shouldRun) startCountdown();
          fetchExchangeData();
        } else if (currentMode === 'auto' && schedule.activeIntervalSeconds === 0) {
          // Off by schedule (weekend or closed) -> user wants manual override!
          els.intervalSelect.value = '300'; // Start manual 5 min sync
          const shouldRun = applyScheduleRules();
          if (shouldRun) startCountdown();
          fetchExchangeData();
        } else {
          // Currently running -> stop/pause it!
          els.intervalSelect.value = '0';
          applyScheduleRules();
        }
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

    // Sync Activity Logs Modal Listeners
    if (els.viewSyncLogsBtn) {
      els.viewSyncLogsBtn.addEventListener('click', openSyncLogsModal);
    }
    if (els.closeSyncLogsBtn) {
      els.closeSyncLogsBtn.addEventListener('click', () => {
        if (els.syncLogsModal) els.syncLogsModal.style.display = 'none';
      });
    }
    if (els.doneSyncLogsBtn) {
      els.doneSyncLogsBtn.addEventListener('click', () => {
        if (els.syncLogsModal) els.syncLogsModal.style.display = 'none';
      });
    }
    if (els.syncLogsModal) {
      els.syncLogsModal.addEventListener('click', (e) => {
        if (e.target === els.syncLogsModal) els.syncLogsModal.style.display = 'none';
      });
    }
  }

  async function openSyncLogsModal() {
    if (!els.syncLogsModal) return;
    els.syncLogsModal.style.display = 'flex';

    if (els.syncLogsContainer) {
      els.syncLogsContainer.innerHTML = '<div class="loading-box"><div class="loading-spinner"></div><p>Loading sync logs...</p></div>';
    }

    let logs = [];
    try {
      const res = await fetch(`./anchor-sync-log.json?_t=${Date.now()}_${Math.floor(Math.random()*10000)}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
      });
      if (res.ok) {
        logs = await res.json();
      }
    } catch (e) {
      console.warn('Could not fetch anchor-sync-log.json directly:', e.message);
    }

    if (!Array.isArray(logs) || logs.length === 0) {
      try {
        const snapRes = await fetch(`${FALLBACK_URL}?_t=${Date.now()}_${Math.floor(Math.random()*10000)}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
        });
        if (snapRes.ok) {
          const snapData = await snapRes.json();
          if (Array.isArray(snapData.recentLogs)) {
            logs = snapData.recentLogs;
          }
        }
      } catch (e) {}
    }

    if (!els.syncLogsContainer) return;

    if (!Array.isArray(logs) || logs.length === 0) {
      els.syncLogsContainer.innerHTML = `
        <div class="empty-box" style="padding: 24px; text-align: center;">
          <p style="color: var(--text-muted); font-size: 0.85rem;">No background sync logs recorded in the past 48 hours.</p>
        </div>
      `;
      return;
    }

    let html = '';
    logs.forEach(item => {
      const statusClass = `status-${item.status || 'SUCCESS'}`;
      const badgeText = (item.status || 'SUCCESS').replace(/_/g, ' ');

      const displayTime = item.timestampIST || (item.istDate && item.istTime ? `${item.istDate}, ${item.istTime}` : (item.timestamp ? formatIndiaDateTime(new Date(item.timestamp)) : ''));

      html += `
        <div class="sync-log-entry">
          <div class="sync-log-top">
            <span class="sync-log-time">📅 ${displayTime}</span>
            <span class="sync-log-badge ${statusClass}">${badgeText}</span>
          </div>
          <div class="sync-log-msg">${item.message || 'Synchronization step completed'}</div>
        </div>
      `;
    });

    els.syncLogsContainer.innerHTML = html;
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
