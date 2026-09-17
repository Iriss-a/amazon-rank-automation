const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'tencent-doc-config.json');

function parseTencentSheetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('TENCENT_DOC_URL_MISSING');
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new Error('TENCENT_DOC_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.qq.com') throw new Error('TENCENT_DOC_URL_MUST_USE_DOCS_QQ_COM');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts[0] !== 'sheet' || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error('TENCENT_DOC_URL_MUST_BE_A_SHEET_URL');
  return { url: `https://docs.qq.com/sheet/${parts[1]}`, fileId: parts[1] };
}

function loadTencentDocConfig() {
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('TENCENT_DOC_CONFIG_MISSING:RUN_SETUP_DOC_PS1');
    throw new Error(`TENCENT_DOC_CONFIG_READ_FAILED:${error.message}`);
  }
  const resolved = parseTencentSheetUrl(config?.tencent_doc?.url);
  return { ...resolved, configPath };
}

module.exports = { configPath, parseTencentSheetUrl, loadTencentDocConfig };
