// Read current repository contents; raw branch URLs can stay cached for minutes.
(function (root) {
  const API_URL = 'https://api.github.com/repos/pmilan24/gmpupdatepremium/contents/subscription-data.json?ref=main';
  const RAW_URL = 'https://raw.githubusercontent.com/pmilan24/gmpupdatepremium/main/subscription-data.json';
  function createFeedReader() {
    let apiRetryAt = 0;
    let lastApiResult = null;
    return async function readLatest({ fetchImpl = fetch, pages = false, manual = false,
      localUrl = './subscription-data.json' } = {}) {
      const candidates = pages ? [
        { url: API_URL, source: 'Live repository update', api: true },
        { url: RAW_URL, source: 'Repository cache' },
        { url: localUrl, source: 'Saved website snapshot' }
      ] : [{ url: localUrl, source: 'Live server update' }];
      let liveUnavailable = false;
      const results = await Promise.allSettled(candidates.map(async candidate => {
        if (candidate.api && Date.now() < apiRetryAt) {
          liveUnavailable = true;
          if (lastApiResult) return lastApiResult;
          throw new Error('Live API request limit; using saved data');
        }
        const separator = candidate.url.includes('?') ? '&' : '?';
        const response = await fetchImpl(`${candidate.url}${separator}_t=${Date.now()}${manual ? '&force=1' : ''}`, {
          cache: 'no-store', signal: AbortSignal.timeout(15000),
          ...(candidate.api ? { headers: { Accept: 'application/vnd.github.raw+json' } } : {})
        });
        if (candidate.api) {
          const remaining = response.headers?.get('x-ratelimit-remaining');
          const reset = Number(response.headers?.get('x-ratelimit-reset')) * 1000;
          if ((remaining !== undefined && remaining !== null && Number(remaining) <= 2) || response.status === 429 || response.status === 403) {
            apiRetryAt = reset > Date.now() ? reset + 1000 : Date.now() + 60000;
          }
        }
        if (!response.ok) {
          if (candidate.api) liveUnavailable = true;
          throw new Error(`Feed HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data.companies) || !data.companies.length || !Number.isFinite(Date.parse(data.lastUpdated))) {
          throw new Error('Invalid subscription snapshot');
        }
        const result = { data, source: candidate.source };
        if (candidate.api) lastApiResult = result;
        return result;
      }));
      const valid = results.filter(result => result.status === 'fulfilled').map(result => result.value);
      // Network rejection happens before an HTTP status is available.
      if (pages && results[0].status === 'rejected') liveUnavailable = true;
      if (lastApiResult && pages) valid.push(lastApiResult);
      valid.sort((a, b) => Date.parse(b.data.lastUpdated) - Date.parse(a.data.lastUpdated));
      if (!valid.length) throw new Error('Unable to retrieve subscription updates. Please retry.');
      return { ...valid[0], warning: liveUnavailable ? 'Live feed unavailable · showing saved data' : '' };
    };
  }
  const api = { createFeedReader, readLatest: createFeedReader() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubscriptionFeed = api;
})(typeof window === 'undefined' ? globalThis : window);
