// sources.js - Dynamic source resolver with secret keys & obfuscated fallbacks
const KEY = 0x5C;

function _decode(hex) {
  if (!hex || typeof hex !== 'string') return '';
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ KEY);
  }
  return str;
}

// Obfuscated baseline tokens (never stored in plaintext)
const TOKENS = {
  GMP_SOURCE: '3428282c2f6673732b2b2b72352c332c2e3931352931723532',
  JINA_PREFIX: '3428282c2f6673732e723635323d723d3573',
  SUB_DASH: '3428282c2f667373383d2f3472352c332c2e3931352931723532732a35392b732f293e2f3f2e352c283533326335323d2c2c61282e2939',
  SUB_WEB: '3428282c2f6673732b2b2b72352c332c2e3931352931723532732a35392b732f293e2f3f2e352c28353332',
  NSE_BASE: '3428282c2f6673732b2b2b72322f39353238353d723f3331',
  NSE_ARCHIVE: '3428282c2f667373322f393d2e3f34352a392f72322f39353238353d723f3331',
  BSE_BASE: '3428282c2f6673732b2b2b723e2f39353238353d723f3331',
  BSE_API: '3428282c2f6673733d2c35723e2f39353238353d723f3331731e2f39153238353d1d0c15'
};

function getEndpoint(envVar, tokenKey) {
  if (typeof process !== 'undefined' && process.env && process.env[envVar]) {
    return process.env[envVar].replace(/\/+$/, '');
  }
  return _decode(TOKENS[tokenKey]);
}

const SOURCES = {
  GMP_SOURCE_URL: getEndpoint('GMP_SOURCE_URL', 'GMP_SOURCE'),
  JINA_PREFIX_URL: getEndpoint('JINA_PREFIX_URL', 'JINA_PREFIX'),
  SUB_DASH_URL: getEndpoint('SUB_DASH_URL', 'SUB_DASH'),
  SUB_WEB_URL: getEndpoint('SUB_WEB_URL', 'SUB_WEB'),
  NSE_BASE_URL: getEndpoint('NSE_BASE_URL', 'NSE_BASE'),
  NSE_ARCHIVE_URL: getEndpoint('NSE_ARCHIVE_URL', 'NSE_ARCHIVE'),
  BSE_BASE_URL: getEndpoint('BSE_BASE_URL', 'BSE_BASE'),
  BSE_API_URL: getEndpoint('BSE_API_URL', 'BSE_API'),
  _decode
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SOURCES;
}
if (typeof window !== 'undefined') {
  window.SOURCES = SOURCES;
}
