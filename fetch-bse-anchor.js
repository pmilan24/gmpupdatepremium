// fetch-bse-anchor.js - BSE IPO List and Anchor Allocation Scraper
const https = require('https');

const BSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.bseindia.com',
  'Referer': 'https://www.bseindia.com/',
  'Accept': 'application/json, text/plain, */*'
};

// Generic HTTPS GET returning Buffer or String with insecureHTTPParser: true
function httpsGet(url, headers = BSE_HEADERS, returnBuffer = false) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
      insecureHTTPParser: true
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, url).toString();
        }
        return httpsGet(redirectUrl, headers, returnBuffer).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(returnBuffer ? buf : buf.toString('utf-8'));
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch BSE public issues list
 * Endpoint: https://api.bseindia.com/BseIndiaAPI/api/GetPublicIssue_par_updated/w?flag=1
 */
async function fetchBSEPublicIssues() {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/GetPublicIssue_par_updated/w?flag=1&_t=${Date.now()}`;
  const raw = await httpsGet(url);
  const json = JSON.parse(raw);
  return json.Table || [];
}

/**
 * Fetch single BSE IPO issue details by IPO_NO
 * Endpoint: https://api.bseindia.com/BseIndiaAPI/api/GetMkt_ISSUE_BBS_IPO/w?IPO_NO={IPO_NO}
 */
async function fetchBSEIpoDetail(ipoNo) {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/GetMkt_ISSUE_BBS_IPO/w?IPO_NO=${encodeURIComponent(ipoNo)}&_t=${Date.now()}`;
  const raw = await httpsGet(url);
  return JSON.parse(raw);
}

/**
 * Extract clean distinctive tokens from company name, ignoring common legal suffixes
 */
function cleanCompanyTokens(companyName) {
  const stopWords = new Set([
    'LIMITED', 'LTD', 'INDIA', 'PVT', 'PRIVATE', 'CORP', 'CORPORATION',
    'THE', 'AND', '&', 'SERVICES', 'COMPANY', 'CO'
  ]);
  return (companyName || '')
    .toUpperCase()
    .split(/[\s.,\-_/()]+/)
    .filter(t => t.length >= 2 && !stopWords.has(t));
}

/**
 * Fetch latest BSE official notices from getCurrPreNextNoticesData_New API.
 * @param {string} dateFlag - 'YYYYMMDD' (e.g. '20260918') or '' for today
 */
async function fetchBSELiveNotices(dateFlag = '') {
  try {
    const url = `https://api.bseindia.com/BseIndiaAPI/api/getCurrPreNextNoticesData_New/w?flag=${dateFlag}`;
    const raw = await httpsGet(url);
    const json = JSON.parse(raw);
    return json.Table || [];
  } catch (e) {
    console.warn(`[BSE] fetchBSELiveNotices failed for flag='${dateFlag}':`, e.message);
    return [];
  }
}

/**
 * Check if a remote PDF URL is valid and reachable (returns HTTP 200)
 */
function checkPdfLinkValid(pdfUrl) {
  return new Promise((resolve) => {
    if (!pdfUrl || !pdfUrl.startsWith('http')) return resolve(false);
    try {
      const urlObj = new URL(pdfUrl);
      const req = https.request({
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: 'HEAD',
        headers: BSE_HEADERS,
        insecureHTTPParser: true
      }, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 302);
      });
      req.on('error', () => resolve(false));
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * Sequential Fallback Probe:
 * When the JSON notice API is delayed or cached, test URLs:
 * https://www.bseindia.com/downloads/UploadDocs/Notices/YYYYMMDD-{i}/YYYYMMDD-{i}.pdf
 * and inspect the content or disp page for company tokens.
 */
async function probeSequentialBseNotices(companyName, targetDateStr, maxProbe = 50) {
  if (!targetDateStr) return null;
  const dateParts = targetDateStr.replace(/[^0-9]/g, '');
  if (dateParts.length < 8) return null;
  const dateFormatted = dateParts.slice(0, 8); // YYYYMMDD
  const tokens = cleanCompanyTokens(companyName);
  if (tokens.length === 0) return null;

  console.log(`[BSE] Starting sequential notice probe for ${companyName} (${dateFormatted}-1..${maxProbe})...`);
  for (let i = maxProbe; i >= 1; i--) {
    const noticeNo = `${dateFormatted}-${i}`;
    const pdfUrl = `https://www.bseindia.com/downloads/UploadDocs/Notices/${noticeNo}/${noticeNo}.pdf`;
    const isValid = await checkPdfLinkValid(pdfUrl);
    if (!isValid) continue;

    try {
      const pdfBuf = await httpsGet(pdfUrl, BSE_HEADERS, true);
      const pdfStr = pdfBuf.toString('latin1');
      const pdfUpper = pdfStr.toUpperCase();

      if (pdfUpper.includes('ANCHOR') && tokens.every(t => pdfUpper.includes(t))) {
        console.log(`[BSE PROBE] Success! Found notice ${noticeNo} for ${companyName}!`);
        const attachUrl = await extractAttachmentFromNoticePdf(pdfUrl);
        return {
          noticeNo,
          noticeDate: targetDateStr,
          noticePdfUrl: pdfUrl,
          intimationPdfUrl: attachUrl || pdfUrl,
          hasIntimationAttachment: !!attachUrl,
          method: 'SEQUENTIAL_PROBE'
        };
      }
    } catch (e) {
      // Continue probing
    }
  }
  return null;
}

/**
 * Search the real-time BSE notice feed for Anchor Allocation notices matching company tokens
 */
async function findBSEAnchorInNotices(companyName, targetDates = []) {
  const tokens = cleanCompanyTokens(companyName);
  if (tokens.length === 0) return null;

  // Always check empty flag (current live feed) plus any target dates
  const flagsToTry = [...new Set(['', ...targetDates.filter(Boolean)])];

  for (const flag of flagsToTry) {
    const notices = await fetchBSELiveNotices(flag);
    for (const notice of notices) {
      const subject = (notice.Subject || '').toUpperCase();
      if (subject.includes('ANCHOR')) {
        const matchesAll = tokens.every(t => subject.includes(t));
        if (matchesAll) {
          const noticeNo = notice.Notice_no;
          const noticePdfUrl = notice.FileName || `https://www.bseindia.com/downloads/UploadDocs/Notices/${noticeNo}/${noticeNo}.pdf`;
          const noticeDate = notice.Notice_date || '';

          // Validate link
          const isValid = await checkPdfLinkValid(noticePdfUrl);
          if (isValid) {
            const attachUrl = await extractAttachmentFromNoticePdf(noticePdfUrl);
            return {
              noticeNo,
              noticeDate,
              noticePdfUrl,
              intimationPdfUrl: attachUrl || noticePdfUrl,
              hasIntimationAttachment: !!attachUrl,
              subject: notice.Subject,
              method: 'LIVE_NOTICE_API'
            };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract attachment PDF link (/URI or file link) from BSE Notice PDF
 * Example: notice PDF contains /URI(https://www.bseindia.com/.../Attach/Anchor_Intimation_Letter$...pdf)
 */
async function extractAttachmentFromNoticePdf(noticePdfUrl) {
  if (!noticePdfUrl) return null;
  try {
    const pdfBuf = await httpsGet(noticePdfUrl, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bseindia.com/'
    }, true);

    const pdfStr = pdfBuf.toString('latin1');
    // Look for /URI(https://www.bseindia.com/downloads/UploadDocs/Notices/Attach/...)
    const uriMatches = pdfStr.match(/\/URI\s*\(([^\)]+)\)/g);
    if (uriMatches && uriMatches.length > 0) {
      for (const m of uriMatches) {
        const cleanUrl = m.replace(/^\/URI\s*\(/, '').replace(/\)$/, '').trim();
        if (cleanUrl.startsWith('http') && cleanUrl.toLowerCase().includes('attach')) {
          return cleanUrl;
        }
      }
      const firstUrl = uriMatches[0].replace(/^\/URI\s*\(/, '').replace(/\)$/, '').trim();
      if (firstUrl.startsWith('http')) return firstUrl;
    }

    // Direct regex match for Attach url
    const directMatch = pdfStr.match(/https?:\/\/[^\s<>"'\(\)\\]+Attach[^\s<>"'\(\)\\]+/i);
    if (directMatch) {
      return directMatch[0];
    }
  } catch (err) {
    console.warn(`[BSE] Could not extract attachment from ${noticePdfUrl}:`, err.message);
  }
  return null;
}

/**
 * Anchor Date Eligibility Logic:
 * In India primary markets, Anchor investor bidding/allocation happens exactly 1 working day
 * prior to the IPO opening date (Issue Start Date).
 * E.g. If issue opens Monday, Anchor releases Friday (or Saturday).
 * If issue opens Wednesday, Anchor releases Tuesday.
 */
function parseLocalDate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const parts = str.slice(0, 10).split('-');
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const m = str.match(/(\d{1,2})[-\s]+([A-Za-z]{3})[-\s]+(\d{4})/);
  if (m) {
    const mon = months[m[2].toLowerCase()];
    if (mon !== undefined) {
      return new Date(parseInt(m[3], 10), mon, parseInt(m[1], 10));
    }
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Anchor Date Eligibility Logic:
 * In India primary markets, Anchor investor bidding/allocation happens exactly 1 working day
 * prior to the IPO opening date (Issue Start Date).
 * E.g. If issue opens Monday, Anchor releases Friday (or Saturday).
 * If issue opens Wednesday, Anchor releases Tuesday.
 */
function checkAnchorDateEligibility(startDateStr) {
  if (!startDateStr) return { eligible: false, isToday: false, message: 'Date unknown' };

  const issueDate = parseLocalDate(startDateStr);
  if (!issueDate) {
    return { eligible: true, isToday: false, message: 'Date pending' };
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Calculate expected anchor date (1 business day before)
  const expectedAnchorDate = new Date(issueDate);
  const dayOfWeek = issueDate.getDay(); // 0: Sun, 1: Mon, ... 6: Sat

  if (dayOfWeek === 1) { // Monday open -> Friday anchor
    expectedAnchorDate.setDate(issueDate.getDate() - 3);
  } else if (dayOfWeek === 0) { // Sunday open -> Friday
    expectedAnchorDate.setDate(issueDate.getDate() - 2);
  } else {
    expectedAnchorDate.setDate(issueDate.getDate() - 1);
  }

  const diffMs = today.getTime() - expectedAnchorDate.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const isToday = diffDays === 0;

  const dateFormatted = expectedAnchorDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  if (isToday) {
    return {
      eligible: true,
      isToday: true,
      isUpcoming: false,
      diffDays: 0,
      daysToGo: 0,
      expectedDate: expectedAnchorDate.toISOString().slice(0, 10),
      message: `Due Today (${dateFormatted})`
    };
  } else if (diffDays < 0) {
    const daysToGo = Math.abs(diffDays);
    return {
      eligible: false,
      isToday: false,
      isUpcoming: true,
      diffDays,
      daysToGo,
      expectedDate: expectedAnchorDate.toISOString().slice(0, 10),
      message: `Expected ${dateFormatted} (${daysToGo} day${daysToGo > 1 ? 's' : ''} to go)`
    };
  } else {
    return {
      eligible: true,
      isToday: false,
      isUpcoming: false,
      diffDays,
      daysToGo: 0,
      expectedDate: expectedAnchorDate.toISOString().slice(0, 10),
      message: `Due / Released since ${dateFormatted}`
    };
  }
}

/**
 * Fetch and enrich active/upcoming BSE IPOs with anchor status
 */
async function getEnrichedBSEIpoList() {
  // 1. Concurrently fetch BSE Public Issues list and live notice feeds for today + past few trading days
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  
  // Calculate prior business days to index
  const pastDates = [];
  for (let d = 1; d <= 4; d++) {
    const p = new Date(now);
    p.setDate(now.getDate() - d);
    pastDates.push(p.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  const dateFlagsToFetch = ['', todayStr, ...pastDates];

  const [issues, ...noticeArrays] = await Promise.all([
    fetchBSEPublicIssues().catch(() => []),
    ...dateFlagsToFetch.map(flag => fetchBSELiveNotices(flag).catch(() => []))
  ]);

  // Combine and deduplicate notices by Notice_no
  const allNoticesMap = new Map();
  noticeArrays.flat().forEach(n => {
    if (n && n.Notice_no && !allNoticesMap.has(n.Notice_no)) {
      allNoticesMap.set(n.Notice_no, n);
    }
  });

  const anchorNotices = Array.from(allNoticesMap.values()).filter(n => 
    (n.Subject || '').toUpperCase().includes('ANCHOR')
  );

  // Filter relevant issues (IPO or SME, not expired debt)
  const filtered = issues.filter(i => {
    const irFlag = (i.IR_flag || '').toUpperCase();
    const platform = (i.eXCHANGE_PLATFORM || '').toUpperCase();
    return irFlag.includes('IPO') || platform.includes('MAIN') || platform.includes('SME');
  });

  // Pre-extract attachments for matched anchor notices to keep response times fast
  const attachmentCache = new Map();

  const enriched = [];

  for (const item of filtered) {
    const ipoNo = item.IPO_NO;
    const scripName = item.Scrip_Name || '';
    const startDate = item.Start_Dt || '';
    const endDate = item.End_Dt || '';
    const priceBand = item.Price_Band || '';
    const platform = item.eXCHANGE_PLATFORM || 'MainBoard';
    const status = item.Status === 'L' ? 'Active' : (item.Status === 'F' ? 'Upcoming' : item.Status);
    let symbol = (item.short_name || '').toUpperCase().trim();

    let anchorNotice = null;

    // Fast Token Match against pre-indexed BSE live anchor notices
    const tokens = cleanCompanyTokens(scripName);
    if (tokens.length > 0) {
      const matchedNotice = anchorNotices.find(n => {
        const sub = (n.Subject || '').toUpperCase();
        return tokens.every(t => sub.includes(t));
      });

      if (matchedNotice) {
        const noticeNo = matchedNotice.Notice_no;
        const noticePdfUrl = matchedNotice.FileName || `https://www.bseindia.com/downloads/UploadDocs/Notices/${noticeNo}/${noticeNo}.pdf`;
        const noticeDate = matchedNotice.Notice_date || '';

        // Check if attachment is already parsed/cached
        let intimationPdfUrl = attachmentCache.get(noticeNo);
        let hasAttachment = false;

        if (!intimationPdfUrl) {
          intimationPdfUrl = await extractAttachmentFromNoticePdf(noticePdfUrl);
          if (intimationPdfUrl) {
            attachmentCache.set(noticeNo, intimationPdfUrl);
            hasAttachment = true;
          } else {
            intimationPdfUrl = noticePdfUrl;
          }
        } else {
          hasAttachment = true;
        }

        anchorNotice = {
          available: true,
          noticeNo,
          noticeDate,
          noticePdfUrl,
          intimationPdfUrl,
          hasIntimationAttachment: hasAttachment,
          method: 'FAST_LIVE_FEED'
        };
      }
    }

    const anchorDateCheck = checkAnchorDateEligibility(startDate);

    enriched.push({
      bseIpoNo: ipoNo,
      scripCode: item.Scrip_cd,
      symbol: symbol || scripName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase(),
      companyName: scripName,
      exchange: platform === 'SME' ? 'BSE SME' : 'BSE',
      platform,
      status,
      issueStartDate: startDate ? startDate.slice(0, 10) : '—',
      issueEndDate: endDate ? endDate.slice(0, 10) : '—',
      issuePrice: priceBand,
      anchorEligibility: anchorDateCheck,
      anchor: anchorNotice || {
        available: false,
        noticeNo: null,
        noticeDate: null,
        noticePdfUrl: null,
        intimationPdfUrl: null,
        hasIntimationAttachment: false
      },
      updatedAt: new Date().toISOString()
    });
  }

  return enriched;
}

module.exports = {
  fetchBSEPublicIssues,
  fetchBSEIpoDetail,
  extractAttachmentFromNoticePdf,
  checkAnchorDateEligibility,
  getEnrichedBSEIpoList,
  cleanCompanyTokens,
  fetchBSELiveNotices,
  checkPdfLinkValid,
  findBSEAnchorInNotices,
  probeSequentialBseNotices
};
