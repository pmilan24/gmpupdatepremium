// merge-exchanges.js - Unify NSE and BSE IPO data with cross-exchange fallback
const { getEnrichedIpoList: getNSEList, fetchNSEIpoDetail } = require('./fetch-nse-anchor');
const { getEnrichedBSEIpoList, fetchBSEIpoDetail, extractAttachmentFromNoticePdf, checkAnchorDateEligibility } = require('./fetch-bse-anchor');

function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b(limited|ltd|pvt|private|india|corporation|corp|technologies|tech|services|llp)\b/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .trim();
}

function stripDomain(url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/^https?:\/\/[^\/]+/i, '');
}

function matchCompany(a, b) {
  if (!a || !b) return false;
  // Exact symbol match
  if (a.symbol && b.symbol && a.symbol.toUpperCase() === b.symbol.toUpperCase()) {
    return true;
  }
  // Normalized name match
  const normA = normalizeName(a.companyName || a.symbol);
  const normB = normalizeName(b.companyName || b.symbol);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.length > 5 && normB.length > 5 && (normA.includes(normB) || normB.includes(normA))) {
    return true;
  }
  return false;
}

/**
 * Pure function to merge NSE and BSE IPO data
 */
function mergeNseAndBse(nseList = [], bseList = []) {
  const unified = [];
  const matchedBseIndices = new Set();

  // 1. Process NSE items and look for matching BSE items
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
    const anchorEligibility = checkAnchorDateEligibility(startDate);

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
      series: nseItem.series,
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
        // NSE sources
        nseZipUrl: hasNseAnchor ? stripDomain(nseItem.anchor.zipUrl) : null,
        nsePdfUrl: hasNseAnchor ? stripDomain(nseItem.anchor.pdfUrl) : null,
        // BSE sources
        bseNoticePdfUrl: hasBseAnchor ? stripDomain(matchedBse.anchor.noticePdfUrl) : null,
        bseIntimationPdfUrl: hasBseAnchor ? stripDomain(matchedBse.anchor.intimationPdfUrl) : null,
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

  // 2. Add remaining BSE-only items (e.g. BSE SME or BSE-exclusive listings)
  for (let i = 0; i < bseList.length; i++) {
    if (matchedBseIndices.has(i)) continue;
    const bseItem = bseList[i];
    const hasBseAnchor = !!(bseItem.anchor && bseItem.anchor.available);
    const anchorEligibility = bseItem.anchorEligibility || checkAnchorDateEligibility(bseItem.issueStartDate);

    unified.push({
      id: `BSE_${bseItem.symbol || bseItem.bseIpoNo}`,
      symbol: bseItem.symbol,
      companyName: bseItem.companyName,
      exchange: bseItem.exchange,
      platforms: ['BSE'],
      status: bseItem.status,
      series: bseItem.platform === 'SME' ? 'SME' : 'EQ',
      issueStartDate: bseItem.issueStartDate,
      issueEndDate: bseItem.issueEndDate,
      issuePrice: bseItem.issuePrice,
      issueSize: '—',
      noOfTime: 0,
      registrar: '—',
      anchorEligibility,
      anchor: {
        available: hasBseAnchor,
        source: hasBseAnchor ? 'BSE' : 'NONE',
        nseZipUrl: null,
        nsePdfUrl: null,
        bseNoticePdfUrl: hasBseAnchor ? stripDomain(bseItem.anchor.noticePdfUrl) : null,
        bseIntimationPdfUrl: hasBseAnchor ? stripDomain(bseItem.anchor.intimationPdfUrl) : null,
        bseNoticeNo: hasBseAnchor ? bseItem.anchor.noticeNo : null,
        hasBseAttachment: hasBseAnchor ? bseItem.anchor.hasIntimationAttachment : false
      },
      bseData: {
        ipoNo: bseItem.bseIpoNo,
        scripCode: bseItem.scripCode,
        platform: bseItem.platform
      },
      updatedAt: new Date().toISOString()
    });
  }

  return unified;
}

/**
 * Fetch and merge data from both NSE and BSE concurrently
 */
async function getUnifiedExchangeIpos() {
  const [nseList, bseList] = await Promise.all([
    getNSEList().catch(err => {
      console.warn('[MERGE] NSE fetch failed:', err.message);
      return [];
    }),
    getEnrichedBSEIpoList().catch(err => {
      console.warn('[MERGE] BSE fetch failed:', err.message);
      return [];
    })
  ]);

  return mergeNseAndBse(nseList, bseList);
}

module.exports = {
  normalizeName,
  matchCompany,
  mergeNseAndBse,
  getUnifiedExchangeIpos
};

