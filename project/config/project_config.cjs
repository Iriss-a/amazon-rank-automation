const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'project-config.json');
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function loadProjectConfig() {
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`PROJECT_CONFIG_READ_FAILED:${error.message}`); }
  const amazon = config.amazon || {};
  const business = config.business || {};
  const writeback = config.writeback || {};
  if (!/^https:\/\//i.test(clean(amazon.siteUrl)) || !/^\d{5}$/.test(clean(amazon.zip)) || !Number.isInteger(Number(amazon.maxPages))) {
    throw new Error('PROJECT_CONFIG_INVALID: amazon.siteUrl / amazon.zip / amazon.maxPages');
  }
  return {
    ...config,
    amazon: { ...amazon, maxPages: Number(amazon.maxPages), brand: clean(amazon.brand), chromeArgs: Array.isArray(amazon.chromeArgs) ? amazon.chromeArgs : [] },
    business: { ...business, timeZone: clean(business.timeZone), staleSheetDays: Number(business.staleSheetDays) },
    writeback: { ...writeback, notFoundText: clean(writeback.notFoundText), defaultStyle: clean(writeback.defaultStyle) },
  };
}

function colorToChinese(value, config = loadProjectConfig()) {
  return config.colors?.[clean(value)] || 'UNKNOWN';
}

module.exports = { configPath, loadProjectConfig, colorToChinese };
