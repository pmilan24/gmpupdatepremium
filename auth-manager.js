// auth-manager.js - Secure Dynamic JWT Authentication & Token Lifecycle Manager
const SOURCES = require('./sources');

// In-memory token cache
let cachedToken = null;
let tokenExpiresAt = 0; // Epoch milliseconds

/**
 * Decode JWT payload without external dependencies
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

/**
 * Safely mask sensitive strings for log output
 */
function maskEmail(email) {
  if (!email) return '***';
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const maskedUser = user.length > 2 ? `${user[0]}***${user[user.length - 1]}` : '***';
  return `${maskedUser}@${domain}`;
}

/**
 * Fetch a fresh JWT token by authenticating with the API
 */
async function fetchFreshToken() {
  const email = SOURCES.AUTH_EMAIL;
  const password = SOURCES.AUTH_PASSWORD;
  const configuredLoginUrl = SOURCES.AUTH_LOGIN_URL || 'https://api.ipo-trend.com/authentication/admin-login/?platform=Android';

  if (!email || !password) {
    // If credentials are not configured, check if a static BACKEND_API_TOKEN is provided
    if (SOURCES.BACKEND_API_TOKEN) {
      return SOURCES.BACKEND_API_TOKEN;
    }
    throw new Error('AUTH_EMAIL or AUTH_PASSWORD is not configured in environment.');
  }

  // Define candidate login URLs: configured URL first, then fallback
  const candidates = [configuredLoginUrl];
  if (!configuredLoginUrl.includes('/authentication/login/')) {
    candidates.push('https://api.ipo-trend.com/authentication/login/?platform=Android');
  }

  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
        },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10000)
      });

      const data = await res.json();

      // Check if response has valid access token
      const token = data?.data?.access || data?.access || data?.token;
      if (token && typeof token === 'string') {
        const payload = decodeJwtPayload(token);
        const expSeconds = payload?.exp;
        const nowMs = Date.now();

        if (expSeconds) {
          // Refresh 5 minutes before actual expiry
          tokenExpiresAt = (expSeconds * 1000) - (5 * 60 * 1000);
          const hoursLeft = Math.round((tokenExpiresAt - nowMs) / (1000 * 60 * 60));
          console.log(`[AUTH] ✅ Successfully authenticated user (${maskEmail(email)}). Token valid for ~${hoursLeft}h.`);
        } else {
          // Default to 1 hour cache if no exp claim
          tokenExpiresAt = nowMs + (60 * 60 * 1000);
          console.log(`[AUTH] ✅ Successfully authenticated user (${maskEmail(email)}).`);
        }

        cachedToken = token;
        return cachedToken;
      }

      // Check validation error message
      const errMsg = data?.meta?.validations?.[0]?.error?.[0] || data?.meta?.message || data?.message || 'Login failed';
      lastError = new Error(`Endpoint ${url} returned: ${errMsg}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Authentication failed on all candidate endpoints: ${lastError ? lastError.message : 'Unknown'}`);
}

/**
 * Get active Bearer token (returns cached token or fetches fresh one)
 */
async function getBearerToken(forceRefresh = false) {
  // If static override token configured, use it
  if (SOURCES.BACKEND_API_TOKEN && !SOURCES.AUTH_EMAIL) {
    return SOURCES.BACKEND_API_TOKEN;
  }

  const now = Date.now();
  if (!forceRefresh && cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  return await fetchFreshToken();
}

module.exports = {
  getBearerToken,
  fetchFreshToken,
  decodeJwtPayload,
  maskEmail
};
