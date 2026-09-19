// sources.js - Dynamic configuration loaded strictly from environment secrets
const fs = require('fs');
const path = require('path');

// Auto-load local .env if present (gitignored, for local development)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  } catch (e) {}
}

function getSecret(name, fallback = '') {
  if (typeof process !== 'undefined' && process.env && process.env[name]) {
    return process.env[name].replace(/\/+$/, '');
  }
  return fallback;
}

const SOURCES = {
  GMP_SOURCE_URL: getSecret('GMP_SOURCE_URL'),
  JINA_PREFIX_URL: (getSecret('JINA_PREFIX_URL', 'https://r.jina.ai') || 'https://r.jina.ai') + '/',
  SUB_DASH_URL: getSecret('SUB_DASH_URL'),
  SUB_WEB_URL: getSecret('SUB_WEB_URL'),
  NSE_BASE_URL: getSecret('NSE_BASE_URL'),
  NSE_ARCHIVE_URL: getSecret('NSE_ARCHIVE_URL', getSecret('NSE_BASE_URL') ? getSecret('NSE_BASE_URL').replace('//www.', '//nsearchives.') : ''),
  BSE_BASE_URL: getSecret('BSE_BASE_URL'),
  BSE_API_URL: getSecret('BSE_API_URL', getSecret('BSE_BASE_URL') ? getSecret('BSE_BASE_URL').replace('//www.', '//api.') + '/BseIndiaAPI' : '')
};

module.exports = SOURCES;
