const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadProjectConfig } = require('./config/project_config.cjs');

const config = loadProjectConfig();
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')].find(fs.existsSync);
const blocked = text => /_sec\/verify|robot check|captcha|sorry|automated access/i.test(text || '');
const continueShopping = text => /click the button below to continue shopping|continue shopping/i.test(text || '');

async function readState(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 500),
    search: !!document.querySelector('#twotabsearchtextbox'),
    location: !!document.querySelector('#nav-global-location-popover-link'),
  }));
}

async function dismissContinueShopping(page) {
  const state = await readState(page);
  if (!continueShopping(`${state.title} ${state.bodyText}`)) return state;
  const button = page.getByRole('button', { name: /continue shopping/i }).first();
  if (await button.count()) {
    await button.click({ timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(5000);
  return readState(page);
}

(async () => {
  if (!chrome) throw new Error('CHROME_NOT_FOUND');
  const browser = await chromium.launch({ executablePath: chrome, headless: false, args: config.amazon.chromeArgs || [] });
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York' });
  const page = await context.newPage();
  const responses = [];
  page.on('response', r => { if (/amazon\.com/i.test(r.url())) responses.push({ url: r.url(), status: r.status(), type: r.request().resourceType() }); });
  try {
    await page.goto(config.amazon.siteUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(20000);
    const state = await dismissContinueShopping(page);
    const text = `${state.url} ${state.title} ${state.bodyText}`;
    const documents = responses.filter(r => r.type === 'document' && /amazon\.com/i.test(r.url));
    const finalDocument = documents.at(-1) || null;
    const blockedResponse = finalDocument?.status === 202 || /\/_sec\/verify/i.test(finalDocument?.url || '');
    const visibleControls = await page.locator('#twotabsearchtextbox').isVisible()
      && await page.locator('#nav-global-location-popover-link').isVisible();
    const ok = state.search && state.location && visibleControls && !blocked(text) && !blockedResponse;
    console.log(JSON.stringify({ ok, state, responses: responses.slice(-12), checkedAt: new Date().toISOString() }));
    process.exitCode = ok ? 0 : 2;
  } finally { await browser.close().catch(() => {}); }
})().catch(e => { console.error(JSON.stringify({ ok:false,error:e.message })); process.exitCode=1; });
