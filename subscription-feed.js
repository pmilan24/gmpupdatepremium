// GitHub Pages reads committed snapshots without waiting for a Pages deployment.
(function (root) {
  const RAW_URL = 'https://raw.githubusercontent.com/pmilan24/gmpupdatepremium/main/subscription-data.json';
  async function readLatest({ fetchImpl = fetch, pages = false, manual = false,
    localUrl = './subscription-data.json' } = {}) {
    const urls = pages ? [RAW_URL, localUrl] : [localUrl];
    const results = await Promise.allSettled(urls.map(async (url, index) => {
      const response = await fetchImpl(`${url}?_t=${Date.now()}${manual ? '&force=1' : ''}`, {
        cache: 'no-store', signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.companies) || !data.companies.length || !Number.isFinite(Date.parse(data.lastUpdated))) {
        throw new Error('Invalid subscription snapshot');
      }
      return { data, source: pages && index === 0 ? 'Latest published update' : 'Saved website snapshot' };
    }));
    const valid = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    valid.sort((a, b) => Date.parse(b.data.lastUpdated) - Date.parse(a.data.lastUpdated));
    if (!valid.length) throw new Error('Unable to retrieve subscription updates. Please retry.');
    return valid[0];
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { readLatest };
  else root.SubscriptionFeed = { readLatest };
})(typeof window === 'undefined' ? globalThis : window);
