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
function checkAnchorDateEligibility(startDateStr) {
  if (!startDateStr) return { eligible: false, message: 'Date unknown' };

  let startDate = null;
  // Parse standard formats: "2026-09-16T00:00:00", "2026-09-16", "16-Sep-2026", "16 Sep 2026"
  if (startDateStr.includes('T') || (startDateStr.includes('-') && startDateStr.length === 10)) {
    startDate = new Date(startDateStr.split('T')[0] + 'T00:00:00');
  } else {
    const cleaned = startDateStr.replace(/-/g, ' ');
    startDate = new Date(cleaned);
  }

  if (isNaN(startDate.getTime())) {
    return { eligible: true, message: 'Date pending' };
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const issueDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());

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

  if (diffDays < 0) {
    const daysToGo = Math.abs(diffDays);
    return {
      eligible: false,
      isUpcoming: true,
      expectedDate: expectedAnchorDate.toISOString().slice(0, 10),
      message: `Expected ${expectedAnchorDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (${daysToGo} day${daysToGo > 1 ? 's' : ''} to go)`
    };
  } else {
    return {
      eligible: true,
      isUpcoming: false,
      expectedDate: expectedAnchorDate.toISOString().slice(0, 10),
      message: `Due / Released since ${expectedAnchorDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
    };
  }
}

/**
 * Fetch and enrich active/upcoming BSE IPOs with anchor status
 */
async function getEnrichedBSEIpoList() {
  const issues = await fetchBSEPublicIssues();
  // Filter relevant issues (IPO or SME, not expired debt)
  const filtered = issues.filter(i => {
    const irFlag = (i.IR_flag || '').toUpperCase();
    const platform = (i.eXCHANGE_PLATFORM || '').toUpperCase();
    return irFlag.includes('IPO') || platform.includes('MAIN') || platform.includes('SME');
  });

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
    let anchorIntimationUrl = null;
    let noticePdfUrl = null;
    let noticeDate = null;
    let noticeNo = null;

    if (ipoNo) {
      try {
        const detail = await fetchBSEIpoDetail(ipoNo);
        const meta = (detail.IPONO_0 && detail.IPONO_0[0]) || {};
        if (!symbol && meta.Symbol) symbol = meta.Symbol.toUpperCase().trim();

        const notices = detail.IPONO_4 || [];
        const foundNotice = notices.find(n => /anchor/i.test(n.SUBJECT || ''));

        if (foundNotice) {
          noticePdfUrl = foundNotice.FILENAME || `https://www.bseindia.com/downloads/UploadDocs/Notices/${foundNotice.NOTICE_NO}/${foundNotice.NOTICE_NO}.pdf`;
          noticeDate = foundNotice.NOTICE_DATE || '';
          noticeNo = foundNotice.NOTICE_NO || '';

          // Extract the actual anchor intimation letter inside the notice PDF
          anchorIntimationUrl = await extractAttachmentFromNoticePdf(noticePdfUrl);
          anchorNotice = {
            available: true,
            noticeNo,
            noticeDate,
            noticePdfUrl,
            intimationPdfUrl: anchorIntimationUrl || noticePdfUrl,
            hasIntimationAttachment: !!anchorIntimationUrl
          };
        }
      } catch (err) {
        console.warn(`[BSE] Error getting detail for IPO_NO ${ipoNo} (${scripName}):`, err.message);
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
  getEnrichedBSEIpoList
};
