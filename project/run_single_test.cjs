const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { chromium } = require('playwright');
const { loadProjectConfig, colorToChinese } = require('./config/project_config.cjs');
const { classifySearchCards } = require('./core/rank_parser.cjs');
const { productMatch, collectVariationEvidence } = require('./core/product_match.cjs');

const root = path.resolve(__dirname, '..');
const projectConfig = loadProjectConfig();
const zip = projectConfig.amazon.zip;
const defaultMaxPages = Number(process.env.MAX_PAGES || projectConfig.amazon.maxPages);
// Keep actions visible, while avoiding a fixed 650 ms delay on every browser
// protocol command.  An explicit SLOW_MO environment value still overrides it.
const slowMo = Number(process.env.SLOW_MO || 150);
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];
const chromePath = chromeCandidates.find(fs.existsSync);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// In batch mode each keyword re-stamps screenshots so tasks cannot overwrite
// each other's evidence files in work/testoutput.
let fileStamp = stamp;
const outputDir = path.join(root, 'work', 'testoutput');
// The local runner intentionally accepts only its fixed action.  This file is
// the narrowly-scoped handoff for a queued keyword; it changes task input only
// and leaves the Amazon operation sequence unchanged.
const activeTaskPath = process.env.AMAZON_TASK_FILE || path.join(__dirname, 'bridge', 'active-keyword-task.json');
// Batch mode: one shared visible Incognito Chrome session loops over every
// pending keyword of the same Sheet. This removes the per-keyword Chrome relaunch
// and Amazon-home/ZIP overhead while keeping every other Amazon rule frozen.
// The single-task bridge contract (AMAZON_TASK_FILE) stays the default path.
const batchTasksPath = process.env.AMAZON_TASKS_FILE || null;
const batchPauseFile = process.env.AMAZON_BATCH_PAUSE_FILE || null;
const batchDelayRange = [
  Math.max(0, Number(process.env.AMAZON_BATCH_DELAY_MIN_MS || 20000)),
  Math.max(0, Number(process.env.AMAZON_BATCH_DELAY_MAX_MS || 20000)),
];
const batchWait = async () => {
  const deadline = Date.now() + batchDelayRange[0] + Math.floor(Math.random() * Math.max(1, batchDelayRange[1] - batchDelayRange[0] + 1));
  while (Date.now() < deadline) {
    if (batchPauseFile && fs.existsSync(batchPauseFile)) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
  }
};
const isBlockedError = error => /_sec\/verify|WAF|HTTP\s*202|CAPTCHA|人机验证|搜索框无法定位|首页加载异常|网络连接未建立|Target page, context or browser has been closed/i.test(String(error || ''));
fs.mkdirSync(outputDir, { recursive: true });

const pause = message => new Promise(resolve => {
  console.log(`\n[PAUSED] ${message}`);
  console.log('[PAUSED] Press Enter here after you have completed any required manual step, or press Ctrl+C to stop.');
  readline.createInterface({ input: process.stdin, output: process.stdout }).question('', () => resolve());
});
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const asinOf = value => (String(value || '').toUpperCase().match(/\bB0[A-Z0-9]{8}\b/) || [null])[0];
const isCaptcha = text => /captcha|robot check|enter the characters you see below|type the characters you see/i.test(text || '');

async function measure(log, stage, work) {
  const started = Date.now();
  try { return await work(); }
  finally {
    const elapsedMs = Date.now() - started;
    log.timings ??= {};
    log.timings[stage] = elapsedMs;
    console.log(`[PERF] ${stage}=${elapsedMs}ms`);
  }
}

function normalizeTask(override) {
  const sheet = clean(override.sheet);
  const spu = clean(override.spu || sheet);
  const keyword = clean(override.keyword);
  const childAsins = [...new Set((Array.isArray(override.childAsins) ? override.childAsins : [override.childAsin])
    .map(asinOf).filter(Boolean))];
  const mappingAsins = [...new Set((Array.isArray(override.mappingAsins) ? override.mappingAsins : [])
    .map(asinOf).filter(Boolean))];
  const maxPages = Number(override.maxPages || defaultMaxPages);
  if (!sheet || !spu || !keyword || !mappingAsins.length || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > projectConfig.amazon.maxPages) {
    throw new Error(`Keyword task configuration is invalid: ${JSON.stringify({ sheet, spu, keyword, mappingAsins, maxPages })}`);
  }
  const mode = ['visible-incognito-address-search-only', 'diagnose_variants'].includes(override.mode) ? override.mode : 'full';
  return { spu, sheet, keyword, keywordCell: clean(override.keywordCell) || 'UNKNOWN', e2: clean(override.e2), parentInfo: clean(override.parentInfo), parentAsin: asinOf(override.parentAsin || override.parentInfo), childAsin: childAsins[0], childAsins, mappingAsins, maxPages, mode };
}

function readTasks() {
  // Batch mode is opt-in via AMAZON_TASKS_FILE; an absent env keeps the
  // historical single-task behavior byte-for-byte.
  if (!batchTasksPath) return [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(batchTasksPath, 'utf8')); }
  catch (error) { throw new Error(`Batch task configuration cannot be read: ${error.message}`); }
  if (!Array.isArray(raw) || !raw.length) throw new Error('Batch task configuration must be a non-empty JSON array.');
  return raw.map(normalizeTask);
}

function readTask() {
  // The bridge task is authoritative for Tencent Docs orchestration.  This
  // retains the local-Excel fallback for the original single-SPU test while
  // allowing any validated online Sheet/SPU to reuse the frozen Amazon flow.
  if (fs.existsSync(activeTaskPath)) {
    let override;
    try { override = JSON.parse(fs.readFileSync(activeTaskPath, 'utf8')); }
    catch (error) { throw new Error(`Keyword task configuration cannot be read: ${error.message}`); }
    return normalizeTask(override);
  }
  throw new Error('AMAZON_TASK_FILE_MISSING: packaged runner accepts only validated bridge tasks.');
}

async function screenshot(page, name) {
  if (process.env.SKIP_SCREENSHOTS === '1') return null;
  const target = path.join(outputDir, `${String(name).padStart(2, '0')}-${fileStamp}.png`);
  try {
    await page.screenshot({ path: target, fullPage: false });
    console.log(`[SCREENSHOT] ${target}`);
  } catch (error) {
    console.log(`[SCREENSHOT-WARNING] ${error.message}`);
  }
  return target;
}

async function variantRegionScreenshot(page, name) {
  const target = path.join(outputDir, `${String(name).padStart(2, '0')}-${fileStamp}.png`);
  const region = page.locator('#softlinesTwister_feature_div:visible, #twister-plus-desktop-twister-container:visible, #twister_feature_div:visible').first();
  try {
    if (await region.count()) {
      await region.screenshot({ path: target });
      console.log(`[SCREENSHOT] ${target}`);
      return target;
    }
  } catch (error) { console.log(`[SCREENSHOT-WARNING] ${error.message}`); }
  return screenshot(page, name);
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 2000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('CDP endpoint timeout')));
  });
}

async function launchAndAttachToVisibleIncognito() {
  const port = await reserveLocalPort();
  const args = [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${port}`,
    // The observed failures are HTTP/2 PING / connection resets on Amazon's
    // CDN path.  Keep the same network path, but use HTTP/1.1 over TCP for
    // this fresh Chrome process so broken HTTP/2 or QUIC intermediaries cannot
    // terminate the page shell before it hydrates.
    ...projectConfig.amazon.chromeArgs,
  ];
  // Keep the known-good Playwright launch environment (network and Chrome
  // defaults) but expose CDP so the original native Incognito window—not a
  // later browser.newContext()—is the page that receives Amazon operations.
  const launcherBrowser = await chromium.launch({
    executablePath: chromePath,
    headless: false,
    slowMo,
    args,
    ignoreDefaultArgs: ['--no-startup-window'],
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await getJson(`${endpoint}/json/version`);
      const browser = await chromium.connectOverCDP(endpoint, { slowMo });
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      if (!context || !page) throw new Error('Connected Chrome has no initial context/page.');
      console.log('[BROWSER] Attached over CDP to Chrome-created visible Incognito window: ' + JSON.stringify({
        chromePid: 'managed-by-Playwright-launch',
        port,
        args,
        contextCount: browser.contexts().length,
        pageCount: context.pages().length,
        initialUrl: page.url(),
      }));
      return { browser, launcherBrowser, context, page };
    } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  await launcherBrowser.close().catch(() => {});
  throw new Error(`Chrome 启动失败：无法连接 Chrome CDP endpoint ${endpoint}: ${lastError?.message || 'unknown error'}`);
}

async function logControlledPage(stage, page, context) {
  const pages = context.pages();
  let windowId = null;
  try {
    const session = await context.newCDPSession(page);
    windowId = (await session.send('Browser.getWindowForTarget')).windowId;
    await session.detach();
  } catch (error) { windowId = `UNAVAILABLE: ${error.message}`; }
  console.log('[CONTROLLED-PAGE] ' + JSON.stringify({
    stage,
    url: page.url(),
    sameContext: page.context() === context,
    contextPageCount: pages.length,
    pageIndex: pages.indexOf(page),
    chromeWindowId: windowId,
  }));
}

async function pageText(page) {
  return page.locator('body').innerText({ timeout: 12000 }).catch(() => '');
}

async function waitForHumanIfCaptcha(page, stage) {
  const text = `${await page.title().catch(() => '')} ${await pageText(page)}`;
  if (!isCaptcha(text)) return;
  await screenshot(page, `captcha-${stage}`);
  await pause(`CAPTCHA / Amazon 人机验证出现在“${stage}”。请在可见 Chrome 窗口中人工完成验证。程序不会绕过验证。`);
  const after = `${await page.title().catch(() => '')} ${await pageText(page)}`;
  if (isCaptcha(after)) throw new Error(`CAPTCHA / 风控仍未解除，阶段：${stage}`);
}

async function pageLoadState(page) {
  return page.evaluate(() => ({
    readyState: document.readyState,
    title: document.title,
    bodyTextLength: (document.body?.innerText || '').trim().length,
    bodyChildCount: document.body?.children?.length || 0,
    htmlLength: document.documentElement?.outerHTML?.length || 0,
    visibility: document.visibilityState,
    resourceCount: performance.getEntriesByType('resource').length,
  })).catch(error => ({ evaluateError: error.message }));
}

async function amazonHeaderState(page) {
  return page.evaluate(() => {
    const boxOf = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const search = document.querySelector('#twotabsearchtextbox');
    const location = document.querySelector('#nav-global-location-popover-link');
    const bodyText = (document.body?.innerText || '').trim();
    const bodyTextLength = bodyText.length;
    const searchBox = boxOf(search), locationBox = boxOf(location);
    const usable = document.readyState !== 'loading'
      && document.title.trim().length > 0
      && bodyTextLength >= 200
      && !!search && !!location
      && searchBox?.width >= 120 && searchBox.width <= window.innerWidth && searchBox.height >= 20 && searchBox.height <= 80
      && locationBox?.width >= 40 && locationBox.width <= 500 && locationBox.height >= 20 && locationBox.height <= 100;
    return {
      usable, readyState: document.readyState, title: document.title, bodyTextLength,
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      resourceCount: performance.getEntriesByType('resource').length,
      continueShopping: /click the button below to continue shopping|continue shopping/i.test(`${document.title} ${bodyText}`),
      searchBox, locationBox,
    };
  }).catch(error => ({ usable: false, evaluateError: error.message }));
}

async function clickContinueShoppingIfPresent(page) {
  return page.evaluate(() => {
    const text = `${document.title} ${document.body?.innerText || ''}`;
    if (!/click the button below to continue shopping|continue shopping/i.test(text)) return false;
    const candidates = [...document.querySelectorAll('button, input[type="submit"], a')];
    const target = candidates.find(node => /continue shopping/i.test(node.innerText || node.value || node.getAttribute('aria-label') || ''));
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);
}

async function waitForAmazonHeaderReady(page, network = [], networkFailures = []) {
  const deadline = Date.now() + 150000;
  let recoveryNavigation = false;
  let lastLoggedAt = 0;
  while (Date.now() < deadline) {
    const header = await amazonHeaderState(page);
    if (header.usable) break;
    if (Date.now() - lastLoggedAt >= 10000) {
      lastLoggedAt = Date.now();
      console.log('[AMAZON-STATE] ' + JSON.stringify({ elapsedMs: 150000 - (deadline - Date.now()), state: header, recentResponses: network.slice(-8) }));
    }
    if (header.continueShopping && await clickContinueShoppingIfPresent(page)) {
      console.log('[AMAZON] Dismissed Continue shopping interstitial.');
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000);
      continue;
    }
    // There are two observed broken home states: (a) a minimal shell response
    // (document 200 but no usable header), and (b) no usable Amazon document at
    // all after ERR_CONNECTION_CLOSED.  They receive a single state-qualified
    // recovery on the *same CDP-attached Incognito page*, not a task retry.
    const elapsedMs = 150000 - (deadline - Date.now());
    const hasAmazonDocument = network.some(entry => entry.type === 'document' && entry.status >= 200 && entry.status < 400);
    const latestDocument = [...network].reverse().find(entry => entry.type === 'document');
    const degradedShell = header.bodyTextLength < 200 || header.htmlLength < 5000 || latestDocument?.status === 202;
    const recoveryAfterMs = degradedShell ? 3000 : hasAmazonDocument ? 45000 : 15000;
    if (!recoveryNavigation && elapsedMs >= recoveryAfterMs) {
      recoveryNavigation = true;
      console.log('[AMAZON] Home state requires same-page recovery: ' + JSON.stringify({ elapsedMs, hasAmazonDocument, degradedShell, header, recentResponses: network.slice(-8) }));
      await page.goto(`https://www.amazon.com/?ref_=nav_ya_signin&codex_recovery=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(error => console.log(`[AMAZON] Same-page recovery navigation warning: ${error.message}`));
    }
    await page.waitForTimeout(1000);
  }
  const finalHeader = await amazonHeaderState(page);
  if (!finalHeader.usable) {
    const wafFailures = networkFailures.filter(entry => /awswaf\.com/i.test(entry.url));
    if (wafFailures.length) {
      await screenshot(page, 'amazon-home-waf-network-blocked');
      throw new Error(`Amazon WAF 网络连接未建立：同一受控无痕页面在 150 秒内未出现搜索框；WAF failures=${JSON.stringify(wafFailures.slice(-8))}; url=${page.url()}; state=${JSON.stringify(await pageLoadState(page))}`);
    }
    throw new Error(`Amazon 首页加载异常：同一受控无痕页面在 150 秒内未形成可交互页头；url=${page.url()}; state=${JSON.stringify(finalHeader)}; recentResponses=${JSON.stringify(network.slice(-12))}`);
  }
  const location = page.locator('#glow-ingress-line2').first();
  await location.waitFor({ state: 'visible', timeout: 30000 });
  await location.evaluate(el => new Promise(resolve => {
    let previous = '';
    let equalFrames = 0;
    const check = () => {
      const value = (el.innerText || '').trim();
      equalFrames = value && value === previous ? equalFrames + 1 : 0;
      previous = value;
      if (equalFrames >= 2) resolve(); else requestAnimationFrame(check);
    };
    check();
  }));
  // Amazon attaches the location handler after the initially visible header.
  await page.waitForTimeout(900);
}

async function addressUiOpen(page) {
  const modal = page.locator('.a-popover:visible, .a-modal-scroller:visible, [role="dialog"]:visible').first();
  const zipInput = page.locator('input[aria-label*="zip" i]:visible, input[placeholder*="zip" i]:visible, input[name*="zip" i]:visible, input[id*="zip" i]:visible').first();
  return (await modal.count()) > 0 && ((await zipInput.count()) > 0 || /choose your location|zip code|enter a us zip/i.test(await modal.innerText().catch(() => '')));
}

async function waitForAddressUi(page, timeoutMs = 5000) {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    if (await addressUiOpen(page)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function locationInteractionState(page) {
  return page.locator('#nav-global-location-popover-link').first().evaluate(el => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const visiblePopovers = [...document.querySelectorAll('.a-popover, .a-modal-scroller, [role="dialog"]')]
      .filter(node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; })
      .map(node => ({ className: node.className, text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220) }));
    return {
      readyState: document.readyState, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visible: !!(rect.width && rect.height), disabled: el.getAttribute('aria-disabled'),
      hit: hit ? `${hit.tagName}#${hit.id}.${hit.className}` : null,
      targetContainsHit: !!hit && el.contains(hit), popovers: visiblePopovers,
    };
  }).catch(error => ({ error: error.message }));
}

async function popupDiagnostics(page) {
  return page.locator('.a-popover:visible, .a-modal-scroller:visible').last().evaluate(el => {
    const shown = node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    return {
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1800),
      inputs: [...el.querySelectorAll('input')].filter(shown).map(node => ({ id: node.id, ariaLabel: node.getAttribute('aria-label'), type: node.type, value: node.value, disabled: node.disabled })),
      buttons: [...el.querySelectorAll('button, input[type="submit"], input[type="button"]')].filter(shown).map(node => ({ id: node.id, text: (node.innerText || node.value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(), disabled: node.disabled, ariaLabel: node.getAttribute('aria-label') })),
    };
  }).catch(() => null);
}

async function waitForZipInput(page, timeoutMs = 180000) {
  const zipSelector = [
    'input[placeholder*="zip" i]:visible', 'input[aria-label*="zip" i]:visible', 'input[name*="zip" i]:visible',
    'input[id*="zip" i]:visible', 'input[placeholder*="postal" i]:visible', 'input[aria-label*="postal" i]:visible',
  ].join(', ');
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const input = page.locator(zipSelector).first();
    if (await input.count()) return input;
    last = await page.locator('.a-popover:visible, .a-modal-scroller:visible, [role="dialog"]:visible').last().evaluate(el => {
      const shown = node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const spinners = [...el.querySelectorAll('.a-spinner, .a-icon-loading, .a-loading-indicator, [role="progressbar"], [aria-busy="true"]')].filter(shown).length;
      const explicitError = /something went wrong|try again|unable to|error occurred|temporarily unavailable/i.test(text);
      return { text: text.slice(0, 500), spinners, explicitError };
    }).catch(() => ({ text: '', spinners: 0, explicitError: false, noDialog: true }));
    console.log(`[LOCATION] ZIP wait: input=false spinner=${last.spinners || 0} explicitError=${!!last.explicitError} elapsed=${Math.ceil((timeoutMs - Math.max(0, deadline - Date.now())) / 1000)}s/${timeoutMs / 1000}s`);
    await page.waitForTimeout(2000);
  }
  throw new Error(`邮编设置超时：地址弹窗已等待 ${timeoutMs / 1000} 秒仍未出现 ZIP / Postal 输入框。最后状态=${JSON.stringify(last)}`);
}

async function setZipIfNeeded(page, network, networkFailures, recoveryAttempt = 0) {
  const location = page.locator('#glow-ingress-line2').first();
  // Confirmed left-top "Deliver to …" entry point. Open it in every fresh context
  // before inspecting the controls Amazon actually renders.
  await waitForAmazonHeaderReady(page, network, networkFailures);
  const trigger = page.locator('#nav-global-location-popover-link').first();
  console.log('[LOCATION] Address trigger state before interaction: ' + JSON.stringify(await locationInteractionState(page)));
  const attempts = [
    { name: 'normal-click', run: () => trigger.click({ timeout: 15000 }) },
    { name: 'force-click', run: () => trigger.click({ force: true, timeout: 15000 }) },
    { name: 'dom-click', run: () => trigger.evaluate(el => el.click()) },
    { name: 'keyboard-enter', run: async () => { await trigger.focus(); await page.keyboard.press('Enter'); } },
    { name: 'mouse-center', run: async () => {
      const box = await trigger.boundingBox();
      if (!box) throw new Error('配送地址入口没有可用坐标。');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } },
  ];
  let opened = false;
  for (const attempt of attempts) {
    await attempt.run();
    // The native click frequently reaches Amazon's decorative header child but
    // does not open the modal. Give it a brief opportunity, then move to the
    // already-verified force-click path instead of idling for four seconds.
    opened = await waitForAddressUi(page, attempt.name === 'normal-click' ? 1200 : 4000);
    console.log(`[LOCATION] ${attempt.name}: addressUiOpen=${opened}; state=${JSON.stringify(await locationInteractionState(page))}`);
    if (opened) break;
  }
  if (!opened && recoveryAttempt < 2) {
    const delayMs = [15000, 30000][recoveryAttempt] || 30000;
    console.log('[RECOVERY] ' + JSON.stringify({ stage: 'zip-popup', attempt: recoveryAttempt + 1, action: 'reload-and-reopen', delayMs }));
    await page.waitForTimeout(delayMs);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    return setZipIfNeeded(page, network, networkFailures, recoveryAttempt + 1);
  }
  if (!opened) throw new Error('邮编设置失败：配送地址入口的 normal/force/DOM/keyboard/mouse 交互后均未出现地址弹窗。请查看 [LOCATION] 状态日志。');
  await screenshot(page, '02-address-popover');
  await waitForHumanIfCaptcha(page, 'location-popup');

  const current = clean(await location.innerText({ timeout: 12000 }).catch(() => ''));
  console.log(`[LOCATION] Current #glow-ingress-line2 after opening address UI: ${JSON.stringify(current)}`);
  if (current.includes(zip)) {
    await page.keyboard.press('Escape').catch(() => {});
    return { changed: false, value: current };
  }

  // The modal shell can appear before its location form is hydrated. Poll the
  // actual ZIP control, but recover quickly from the shell-only "Done" modal
  // variant instead of burning several minutes before reloading.
  let input;
  try { input = await waitForZipInput(page, 20000); }
  catch (error) {
    if (recoveryAttempt < 2) {
      const delayMs = [15000, 30000][recoveryAttempt] || 30000;
      console.log('[RECOVERY] ' + JSON.stringify({ stage: 'zip-input', attempt: recoveryAttempt + 1, action: 'reload-and-reopen', delayMs }));
      await page.waitForTimeout(delayMs);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      return setZipIfNeeded(page, network, networkFailures, recoveryAttempt + 1);
    }
    throw error;
  }

  const descriptor = await input.evaluate(el => ({ id: el.id, name: el.name, placeholder: el.placeholder, ariaLabel: el.getAttribute('aria-label'), type: el.type }));
  console.log(`[LOCATION] ZIP input found: ${JSON.stringify(descriptor)}`);
  await input.fill(zip);
  // Blur the field once so Amazon's location widget commits its own input
  // state before Apply is pressed.  This avoids a visible click that only
  // closes the modal without issuing the address-change request.
  await input.press('Tab').catch(() => {});
  console.log('[LOCATION] Popup after entering ZIP: ' + JSON.stringify(await popupDiagnostics(page)));

  const popup = page.locator('.a-popover:visible, .a-modal-scroller:visible').last();
  const apply = popup.locator('#GLUXZipUpdate:visible, button:visible, input[type="submit"]:visible, input[type="button"]:visible')
    .filter({ hasText: /apply|update|设置/i }).first()
    .or(popup.locator('#GLUXZipUpdate:visible, input[type="submit"]:not([aria-label]):visible').first());
  if (!await apply.count()) throw new Error('邮编设置失败：已输入 10001，但未找到 Apply / Update / 设置按钮。');
  console.log('[LOCATION] Apply control: ' + JSON.stringify(await apply.evaluate(node => ({ id: node.id, text: node.innerText || node.value || node.getAttribute('aria-label'), disabled: node.disabled, type: node.type }))));
  const locationResponses = [];
  let zipSubmitAt = 0;
  const responseListener = response => {
    if (/glux|location|address|postal|zip/i.test(response.url())) {
      locationResponses.push({ url: response.url(), status: response.status(), elapsedMs: zipSubmitAt ? Date.now() - zipSubmitAt : null });
    }
  };
  page.on('response', responseListener);
  console.log(`[LOCATION] Applying ZIP ${zip}`);
  zipSubmitAt = Date.now();
  await apply.click({ timeout: 15000 });
  // Amazon currently presents a second confirmation panel after the ZIP
  // submission ("You're now shopping for delivery to ... Continue").  This
  // is a separate state transition, so commit it before inspecting the
  // header.  Prefer the readable Continue control, then its inspected DOM id.
  // A real confirmation panel is rendered immediately when this Amazon
  // variant uses one.  Keep a small window for it but do not stall the common
  // direct-apply path.
  const confirmationUntil = Date.now() + 3000;
  let confirmationCommitted = false;
  while (Date.now() < confirmationUntil && !confirmationCommitted) {
    const confirmation = page.locator('.a-popover:visible, .a-modal-scroller:visible').last();
    const confirmationText = clean(await confirmation.innerText().catch(() => ''));
    if (/you.?re now shopping for delivery to/i.test(confirmationText) || /continue|继续/i.test(confirmationText)) {
      // The same input is exposed both by role and id; use one locator to
      // avoid Playwright strict-mode ambiguity when Amazon duplicates labels.
      const continueControl = confirmation.getByRole('button', { name: /continue|继续/i }).first();
      if (await continueControl.count()) {
        console.log('[LOCATION] Confirming selected ZIP with the post-submit Continue control.');
        await continueControl.click({ timeout: 5000 });
        confirmationCommitted = true;
        break;
      }
    }
    await page.waitForTimeout(250);
  }
  if (!confirmationCommitted) console.log('[LOCATION] No post-submit Continue panel appeared; checking header directly.');
  // First wait only until the address endpoint acknowledges the choice or the
  // visible header changes.  The gateway commonly leaves the header in its
  // temporary "Update location" state; waiting a full minute in that state
  // cannot make it render and only delays the same-page verification refresh.
  const until = Date.now() + 12000;
  let updated = current;
  while (Date.now() < until) {
    updated = clean(await location.innerText({ timeout: 2000 }).catch(() => ''));
    if (updated.includes(zip) || /new york/i.test(updated)) break;
    if (locationResponses.some(item => /address-change/i.test(item.url) && item.status >= 200 && item.status < 300)) break;
    await page.waitForTimeout(500);
  }
  const addressAccepted = locationResponses.some(item => /address-change/i.test(item.url) && item.status >= 200 && item.status < 300);
  if (!updated.includes(zip) && !/new york/i.test(updated) && !addressAccepted && recoveryAttempt < 1) {
    // The popup occasionally closes without an address-change request. This
    // is a detected, local control failure (not a keyword retry). Reload the
    // same CDP-attached page and re-open the location control once.
    page.off('response', responseListener);
    console.log('[LOCATION] Apply closed without an address-change response; restoring the same page and retrying the ZIP control once.');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(error => console.log(`[LOCATION] ZIP control recovery refresh warning: ${error.message}`));
    return setZipIfNeeded(page, network, networkFailures, recoveryAttempt + 1);
  }
  if (!updated.includes(zip) && !/new york/i.test(updated) && addressAccepted) {
    // Some Amazon gateway variants accept the ZIP but leave the header in the
    // temporary "Update location" state and never request get-location-label.
    // Refresh the same controlled page once so the accepted delivery cookie is
    // rendered into the header, then validate the visible value again.
    console.log('[LOCATION] ZIP API accepted but header is still transitional; refreshing the same controlled page for visible verification.');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(error => console.log(`[LOCATION] Verification refresh warning: ${error.message}`));
    await waitForAmazonHeaderReady(page, network, networkFailures);
    const refreshUntil = Date.now() + 30000;
    while (Date.now() < refreshUntil) {
      updated = clean(await location.innerText({ timeout: 2000 }).catch(() => ''));
      if (updated.includes(zip) || /new york/i.test(updated)) break;
      await page.waitForTimeout(1000);
    }
  }
  const done = page.getByRole('button', { name: /done|完成/i }).first();
  if (await done.count()) await done.click({ timeout: 5000 }).catch(() => {});
  updated = clean(await location.innerText({ timeout: 5000 }).catch(() => updated));
  page.off('response', responseListener);
  console.log('[LOCATION] Responses after ZIP submit: ' + JSON.stringify(locationResponses));
  console.log('[LOCATION] Popup after ZIP submit: ' + JSON.stringify(await popupDiagnostics(page)));
  console.log(`[LOCATION] Updated #glow-ingress-line2: ${JSON.stringify(updated)}`);
  if (!updated.includes(zip) && !/new york/i.test(updated)) throw new Error(`邮编设置失败：顶部地址未验证为 ${zip} / New York，当前为 ${JSON.stringify(updated)}`);
  await screenshot(page, '03-address-verified');
  return { changed: true, value: updated };
}

async function getResultCards(page) {
  return page.locator('[data-component-type="s-search-result"][data-asin]').evaluateAll(nodes => nodes.map(node => ({
    asin: (node.getAttribute('data-asin') || '').toUpperCase(),
    text: (node.innerText || '').slice(0, 3000),
    href: node.querySelector('h2 a, a.a-link-normal.s-no-outline')?.href || null,
  })));
}

const targetFamilyCache = new Map();

function targetAsinsForTask(task) {
  return [...new Set((task.mappingAsins || []).map(asinOf).filter(Boolean))];
}

async function targetFamilyAsins(page, task, context) {
  const mappingTargets = [...new Set((task.mappingAsins || []).map(asinOf).filter(Boolean))];
  const preloadTargets = mappingTargets;
  const key = preloadTargets.slice().sort().join('|');
  if (!key) return [];
  if (targetFamilyCache.has(key)) return targetFamilyCache.get(key);

  const family = new Set(preloadTargets);
  const maxPreloads = Math.max(1, Math.min(8, Number(process.env.AMAZON_FAMILY_PRELOAD_LIMIT || 4)));
  for (const target of preloadTargets.slice(0, maxPreloads)) {
    try {
      await page.goto(`https://www.amazon.com/dp/${target}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await logControlledPage(`target-family-${target}`, page, context);
      await waitForHumanIfCaptcha(page, `target-family-${target}`);
      const evidence = await collectVariationEvidence(page, target, preloadTargets);
      for (const asin of evidence.familyAsins || []) family.add(asin);
      console.log('[TARGET-FAMILY] ' + JSON.stringify({ target, familySize: family.size, asinSource: 'SPU-scoped asin尺寸颜色对应表', mappingAsinCount: mappingTargets.length, parentAsins: evidence.parentAsins || [], hasDimensionMap: evidence.hasDimensionMap === true }));
      if (evidence.hasDimensionMap === true && family.size > preloadTargets.length) break;
    } catch (error) {
      console.log('[TARGET-FAMILY-WARNING] ' + JSON.stringify({ target, error: error.message || String(error) }));
    }
  }
  const result = [...family];
  targetFamilyCache.set(key, result);
  return result;
}

async function inspectCandidate(detail, card, task, pageNo, pageNaturalPosition, totalNaturalRank, context) {
  {
    await detail.goto(card.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await logControlledPage(`detail-candidate-page-${pageNo}`, detail, context);
    await waitForHumanIfCaptcha(detail, `candidate-page-${pageNo}`);
    // Variant widgets hydrate after the initial HTML.  Wait for the actual
    // selected Color and Size labels, then keep one short settle interval;
    // do not hold every detail page for a fixed 30 seconds.
    const dimensionLabels = detail.locator(
      '#inline-twister-expanded-dimension-text-color_name:visible, #inline-twister-dim-title-color_name:visible, #inline-twister-expander-header-color_name:visible, ' +
      '#inline-twister-expanded-dimension-text-size_name:visible, #inline-twister-dim-title-size_name:visible, #inline-twister-expander-header-size_name:visible'
    );
    await dimensionLabels.first().waitFor({ state: 'visible', timeout: 12000 })
      .catch(error => console.log(`[DETAIL-WARNING] Color/Size widget did not become visible; rank match remains valid: ${error.message}`));
    await detail.locator('#inline-twister-expanded-dimension-text-size_name:visible, #inline-twister-dim-title-size_name:visible, #inline-twister-expander-header-size_name:visible').first()
      .waitFor({ state: 'visible', timeout: 12000 })
      .catch(error => console.log(`[DETAIL-WARNING] Selected Size is unavailable; FOUND will be returned without Size: ${error.message}`));
    await detail.waitForTimeout(500);
    // #ASIN (or the loaded /dp/ ASIN) identifies the variation actually shown.
    // Text in a variation page includes sibling and parent ASINs, so it must
    // never be used as match evidence: that was the source of parent-ASIN
    // false positives in historical results.
    const detailAsin = clean(await detail.locator('#ASIN, input[name="ASIN"]').first().inputValue({ timeout: 5000 }).catch(() => '')).toUpperCase();
    const urlAsin = asinOf(new URL(detail.url()).pathname);
    const actualDetailAsin = detailAsin || urlAsin;
    // Both production and diagnostics use product_match.cjs. A brand hit is
    // merely a candidate; only exact ASIN or proven variation evidence wins.
    let variationEvidence = { parentAsins: [], familyAsins: [], hasDimensionMap: false };
    const targetAsins = targetAsinsForTask(task);
    if (actualDetailAsin && !targetAsins.includes(actualDetailAsin)) {
      variationEvidence = await collectVariationEvidence(detail, actualDetailAsin, targetAsins);
    }
    const match = productMatch({ actualAsin: actualDetailAsin, targetAsins, variationEvidence });
    console.log('[PRODUCT-MATCH] ' + JSON.stringify({ candidateAsin: card.asin, targets: targetAsins, targetSource: 'SPU-scoped asin尺寸颜色对应表 only', sheetChildAsinsIgnored: task.childAsins, mappingAsinCount: task.mappingAsins?.length || 0, match, variationEvidence }));
    if (match.status === 'FAILED') throw new Error(`产品匹配解析失败：${match.reason}`);
    if (match.status !== 'FOUND') {
      // The diagnostic payload is evidence only; it cannot create a match.
      if (task.mode === 'diagnose_variants') {
        const html = await detail.content();
        const familyAsins = [...new Set((html.toUpperCase().match(/\bB0[A-Z0-9]{8}\b/g) || []))].sort();
        const targetPresence = Object.fromEntries(targetAsins.map(asin => [asin, familyAsins.includes(asin)]));
        const twisterEvidence = await detail.evaluate(({ targets, actualAsin }) => {
          const root = document.querySelector('#twister, #inline-twister-container, #inline-twister-expanded-dimension-text-color_name')?.closest('#twister, [id*="twister" i], [class*="twister" i]');
          const attrs = ['data-asin', 'data-defaultasin', 'data-dp-url', 'data-url', 'href'];
          const nodes = [];
          if (root) {
            for (const el of root.querySelectorAll('*')) {
              const values = attrs.map(name => el.getAttribute(name)).filter(Boolean).join(' ');
              const hit = targets.find(target => values.toUpperCase().includes(target));
              if (hit) nodes.push({ target: hit, tag: el.tagName, id: el.id, className: String(el.className || '').slice(0, 160), values: values.slice(0, 500), text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
            }
          }
          const scriptEvidence = [];
          for (const script of document.scripts) {
            const text = (script.textContent || '').replace(/\s+/g, ' ');
            const upper = text.toUpperCase();
            if (!actualAsin || !upper.includes(actualAsin)) continue;
            for (const target of targets) {
              const index = upper.indexOf(target);
              if (index < 0) continue;
              const context = text.slice(Math.max(0, index - 600), Math.min(text.length, index + 600));
              const variationContext = /dimensionToAsinMap|asinVariationValues|variationValues|twister|variationDisplayLabels/i.test(context);
              scriptEvidence.push({ target, scriptId: script.id || null, variationContext, context: context.slice(0, 1200) });
            }
          }
          const selectedText = name => {
            const el = document.querySelector(`#inline-twister-expanded-dimension-text-${name}_name, #inline-twister-dim-title-${name}_name, #inline-twister-expander-header-${name}_name`);
            return (el?.innerText || '').replace(new RegExp(`^${name}:\\s*`, 'i'), '').trim() || 'UNKNOWN';
          };
          const title = (document.querySelector('#productTitle')?.textContent || '').replace(/\s+/g, ' ').trim();
          const parentCandidates = [...new Set((document.documentElement.innerHTML.match(/(?:parentAsin|parent_asin)[^B]{0,80}(B0[A-Z0-9]{8})/gi) || []).map(value => (value.match(/B0[A-Z0-9]{8}/i) || [])[0]?.toUpperCase()).filter(Boolean))];
          return {
            present: !!root,
            targetHits: Object.fromEntries(targets.map(target => [target, !!root && root.innerHTML.toUpperCase().includes(target)])),
            nodes: nodes.slice(0, 50), scriptEvidence: scriptEvidence.slice(0, 20),
            familyConfirmed: scriptEvidence.some(item => item.variationContext),
            title, color: selectedText('color'), size: selectedText('size'), parentCandidates,
          };
        }, { targets: targetAsins, actualAsin: actualDetailAsin });
        console.log('[VARIANT-DIAGNOSTIC] ' + JSON.stringify({ candidateAsin: card.asin, actualDetailAsin, targetAsins, targetPresence, twisterEvidence, familyAsins: familyAsins.slice(0, 200) }));
      }
      return null;
    }
    const selectionEvidence = await detail.evaluate(() => {
      const visible = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
      const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const describe = el => ({
        tag: el.tagName, id: el.id, className: el.className, text: text(el).slice(0, 180), visible: visible(el),
        ariaSelected: el.getAttribute('aria-selected'), ariaChecked: el.getAttribute('aria-checked'), selected: el.getAttribute('selected'),
        ariaLabel: el.getAttribute('aria-label'), value: el.value || null, dataAsin: el.getAttribute('data-asin') || el.getAttribute('data-defaultasin'),
      });
      const all = [...document.querySelectorAll('[id*="size" i], [name*="size" i], [aria-label*="size" i]')];
      const selected = all.filter(el => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true' || el.hasAttribute('selected') || /a-button-selected|selected/i.test(String(el.className)));
      const visibleSelectedLabel = [...document.querySelectorAll('#inline-twister-expanded-dimension-text-size_name, #inline-twister-dim-title-size_name, #inline-twister-expander-header-size_name')].filter(visible);
      return {
        currentAsin: document.querySelector('#ASIN')?.value || document.querySelector('input[name="ASIN"]')?.value || null,
        sizeCandidates: all.filter(visible).slice(0, 120).map(describe),
        selectedCandidates: selected.filter(visible).slice(0, 50).map(describe),
        visibleSelectedLabels: visibleSelectedLabel.map(describe),
      };
    });
    console.log('[DETAIL] Selected-variant DOM evidence: ' + JSON.stringify(selectionEvidence));

    const selectedDimension = async (name) => {
      const selected = detail.locator(`#inline-twister-expanded-dimension-text-${name}_name:visible, #inline-twister-dim-title-${name}_name:visible, #inline-twister-expander-header-${name}_name:visible`).first();
      const value = clean(await selected.innerText().catch(() => ''));
      return value ? value.replace(new RegExp(`^${name}:\\s*`, 'i'), '') : 'UNKNOWN';
    };
    const colorEN = await selectedDimension('color');
    const size = await selectedDimension('size');
    const colorCN = colorToChinese(colorEN, projectConfig);
    await variantRegionScreenshot(detail, 'target-color-size');
    await screenshot(detail, 'target-detail');
    return { asin: match.actualAsin, matchedTargetAsin: match.matchedTargetAsin, matchType: match.matchType, page: pageNo, pageNaturalPosition, totalNaturalRank, color: colorEN, color_EN: colorEN, color_CN: colorCN, size, selectedSize: size, url: detail.url(), selectionEvidence, variationEvidence };
  }
}

// Shared keyword flow for single and batch mode.  The page has already been prepared (Amazon home loaded, ZIP/address verified); this submits one keyword and walks result pages.
async function runKeywordFlow(task, log, page, context, homeResponses, homeNetworkFailures) {
    const candidateAsins = await targetFamilyAsins(page, task, context);
    await measure(log, 'searchSubmit', async () => {
      console.log(`[SEARCH] Typing ${task.keywordCell} keyword in Amazon search box: ${JSON.stringify(task.keyword)}`);
      const search = page.locator('#twotabsearchtextbox').first();
      if (!await search.count()) throw new Error('搜索框无法定位：未找到 #twotabsearchtextbox。');
      await search.fill(task.keyword);
      await search.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
      await logControlledPage('search-results', page, context);
      await waitForHumanIfCaptcha(page, 'search-results');
    });

    if (task.mode === 'visible-incognito-address-search-only') {
      const cards = page.locator('[data-component-type="s-search-result"][data-asin]');
      await cards.first().waitFor({ state: 'visible', timeout: 30000 });
      log.status = 'SEARCH_UI_VERIFIED';
      log.result = { url: page.url(), visibleResultCards: await cards.count(), chromeWindow: 'Chrome-created Incognito page controlled over CDP' };
      console.log('[VERIFY] Visible Incognito window completed address + search on the attached original page.');
      return;
    }

    let naturalBefore = 0;
    for (let pageNo = 1; pageNo <= task.maxPages; pageNo += 1) {
      const { naturalCount, sponsoredCount, candidates } = await measure(log, `resultPage${pageNo}Parse`, async () => {
        const resultCards = page.locator('[data-component-type="s-search-result"][data-asin]');
        try { await resultCards.first().waitFor({ state: 'visible', timeout: 30000 }); }
        catch (error) {
          const currentUrl = page.url();
          console.log('[RECOVERY] ' + JSON.stringify({ stage: 'search-results', action: 'goto-exact-url-reload', url: currentUrl }));
          await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await resultCards.first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => { throw new Error(`商品卡片未出现：搜索结果页没有可见的正常商品卡片。原始错误=${error.message}`); });
        }
        return classifySearchCards(await getResultCards(page), projectConfig.amazon.brand, candidateAsins);
      });
      const pageLog = { page: pageNo, naturalCount, sponsoredCount, musshoeCandidates: candidates.map(c => ({ asin: c.asin, pageNaturalPosition: c.pageNaturalPosition })) };
      log.pages.push(pageLog);
      console.log('[PAGE] ' + JSON.stringify(pageLog));
      await screenshot(page, `results-page-${pageNo}`);

      const searchResultsUrl = page.url();
      for (const candidate of candidates) {
        const result = await measure(log, `detailPage${pageNo}`, () => inspectCandidate(page, candidate, task, pageNo, candidate.pageNaturalPosition, naturalBefore + candidate.pageNaturalPosition, context));
        if (result) { log.status = 'FOUND'; log.result = result; break; }
        // Candidate inspection uses the same controlled tab. A non-matching
        // MUSSHOE detail page must return to this exact search page before
        // inspecting another candidate or locating pagination controls.
        await page.goto(searchResultsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('[data-component-type="s-search-result"][data-asin]').first().waitFor({ state: 'visible', timeout: 30000 });
        await logControlledPage(`return-search-page-${pageNo}`, page, context);
      }
      if (log.result) break;
      naturalBefore += naturalCount;
      if (pageNo === task.maxPages) { log.status = 'NOT_FOUND'; break; }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
      const next = page.locator('a.s-pagination-next:not(.s-pagination-disabled), a[aria-label*="next page" i]').first();
      if (!await next.count()) {
        // Amazon's body contains unrelated marketing counts such as
        // "60,000+ results".  Treating that text as a pagination contract
        // forced direct requests beyond the real last page and converted a
        // valid NOT_FOUND into a technical card-loading failure.  A direct
        // page fallback is only justified when the current organic page is
        // full; a partial page without an enabled Next control is the end.
        if (naturalCount >= 40) {
          const nextUrl = new URL(page.url());
          nextUrl.searchParams.set('page', String(pageNo + 1));
          nextUrl.searchParams.set('ref', `sr_pg_${pageNo + 1}`);
          console.log('[PAGINATION-FALLBACK] ' + JSON.stringify({ pageNo, naturalBefore, naturalCount, reason: 'full-page-without-next-control', nextUrl: nextUrl.toString() }));
          await page.goto(nextUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
          await logControlledPage(`pagination-${pageNo + 1}`, page, context);
          await waitForHumanIfCaptcha(page, `pagination-${pageNo + 1}`);
          continue;
        }
        log.status = 'NOT_FOUND'; break;
      }
      await next.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
      await logControlledPage(`pagination-${pageNo + 1}`, page, context);
      await waitForHumanIfCaptcha(page, `pagination-${pageNo + 1}`);
    }
}

(async () => {
  let browser, launcherBrowser;
  const batchTasks = readTasks();
  const isBatch = batchTasks.length > 0;
  const batchStartedAt = new Date().toISOString();
  const log = { startedAt: batchStartedAt, task: null, location: null, pages: [], timings: {}, status: 'STARTED', result: null, failedStep: null, error: null };
  const logs = [];
  const executionLogPath = process.env.AMAZON_EXECUTION_LOG || path.join(outputDir, 'execution-log.json');
  let batchStatus = 'RUNNING';
  let batchError = null;
  const writeExecutionLog = () => {
    // Single mode keeps the historical per-run log shape; batch mode writes an
    // incremental {status, results[]} envelope after every keyword so a
    // watchdog kill still preserves completed keyword outcomes.
    const payload = isBatch
      ? { startedAt: batchStartedAt, finishedAt: new Date().toISOString(), status: batchStatus, batch: { total: batchTasks.length, completed: logs.length }, error: batchError, results: logs }
      : log;
    try {
      fs.writeFileSync(executionLogPath, JSON.stringify(payload, null, 2));
      console.log(`[LOG] ${executionLogPath}`);
    } catch (writeError) {
      console.log(`[LOG-WARNING] Could not write execution log: ${writeError.message}`);
    }
  };
  try {
    const task = isBatch ? batchTasks[0] : readTask();
    log.task = isBatch ? { sheet: task.sheet, batchTotal: batchTasks.length } : task;
    console.log('[TASK] ' + JSON.stringify(isBatch ? batchTasks.map((item, index) => ({ ...item, batchIndex: index + 1 })) : task, null, 2));
    if (!chromePath) throw new Error('Chrome 启动失败：未在常见安装路径找到 chrome.exe。');

    // Chrome, rather than Playwright, creates the visible Incognito window.
    // CDP then attaches to its original page. No browser.newContext() and no
    // page.newPage() are used for the Amazon flow.
    const attached = await measure(log, 'launchAndAttach', () => launchAndAttachToVisibleIncognito());
    browser = attached.browser;
    launcherBrowser = attached.launcherBrowser;
    const context = attached.context;
    const page = attached.page;
    console.log('[CONTEXT] Attached to Chrome-created Incognito context; no browser.newContext() was created.');
    await logControlledPage('initial-visible-incognito-page', page, context);
    console.log(`[BROWSER] Local Chrome started in real incognito mode: ${chromePath}; --incognito; fresh process; temporary profile; slowMo=${slowMo}ms`);

    const homeResponses = [];
    const homeNetworkFailures = [];
    page.on('response', response => {
      if (/amazon\.com/i.test(response.url())) homeResponses.push({ url: response.url().slice(0, 300), status: response.status(), type: response.request().resourceType() });
      if (homeResponses.length > 80) homeResponses.shift();
    });
    page.on('requestfailed', request => {
      const failure = { url: request.url().slice(0, 300), error: request.failure()?.errorText || null, type: request.resourceType() };
      if (/amazon\.com|awswaf\.com/i.test(failure.url)) homeNetworkFailures.push(failure);
      if (homeNetworkFailures.length > 80) homeNetworkFailures.shift();
      console.log('[NETWORK-FAILED] ' + JSON.stringify(failure));
    });
    await measure(log, 'amazonHomeReady', async () => {
      try {
        await page.goto(projectConfig.amazon.siteUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {
        // Do not classify an initial transport close as a page-load failure before
        // checking the controlled page state.  waitForAmazonHeaderReady records
        // the state and performs at most one same-page recovery if needed.
        console.log('[AMAZON] Initial home navigation warning: ' + e.message);
      }
      await logControlledPage('amazon-home', page, context);
      await screenshot(page, '01-amazon-home');
      await waitForHumanIfCaptcha(page, 'amazon-home');
      await waitForAmazonHeaderReady(page, homeResponses, homeNetworkFailures);
    });
    log.location = await measure(log, 'setZip', () => setZipIfNeeded(page, homeResponses, homeNetworkFailures));
    await logControlledPage('address-verified', page, context);

    if (!isBatch) {
      await runKeywordFlow(task, log, page, context, homeResponses, homeNetworkFailures);
    } else {
      // One Sheet-wide visible Incognito session, one keyword at a time. Amazon
      // home + ZIP setup run once; every keyword still gets its own search,
      // pagination walk, per-task log, and screenshot stamp.
      for (let index = 0; index < batchTasks.length; index += 1) {
        if (batchPauseFile && fs.existsSync(batchPauseFile)) { batchStatus = 'PAUSED_PARTIAL'; break; }
        const task = batchTasks[index];
        const keywordStartedAt = Date.now();
        const klog = { startedAt: new Date().toISOString(), task, location: log.location, pages: [], timings: {}, status: 'STARTED', result: null, failedStep: null, error: null };
        fileStamp = `${stamp}-k${index + 1}`;
        console.log('[TASK] ' + JSON.stringify({ ...task, batchIndex: index + 1, batchTotal: batchTasks.length }));
        try {
          await runKeywordFlow(task, klog, page, context, homeResponses, homeNetworkFailures);
        } catch (error) {
          klog.status = 'FAILED';
          klog.failedStep = error.message.split(':')[0];
          klog.error = error.message;
          console.error(`[FAIL] ${error.message}`);
        }
        klog.finishedAt = new Date().toISOString();
        klog.durationMs = Date.now() - keywordStartedAt;
        logs.push(klog);
        writeExecutionLog();
        console.log('[BATCH-KEYWORD-DONE] ' + JSON.stringify({ index: index + 1, total: batchTasks.length, keyword: task.keyword, keywordCell: task.keywordCell, status: klog.status }));
        if (klog.status === 'FAILED' && isBlockedError(klog.error)) { batchStatus = 'BLOCKED_PARTIAL'; break; }
        if (index < batchTasks.length - 1) {
          if (batchPauseFile && fs.existsSync(batchPauseFile)) { batchStatus = 'PAUSED_PARTIAL'; break; }
          await batchWait();
        }
      }
      if (batchStatus === 'RUNNING') batchStatus = 'COMPLETED';
    }
  } catch (error) {
    if (isBatch) {
      batchStatus = 'FAILED';
      batchError = error.stack || error.message;
      console.error(`[FAIL] ${error.message}`);
    } else {
      log.status = 'FAILED';
      log.failedStep = error.message.split(':')[0];
      log.error = error.message;
      console.error(`[FAIL] ${error.message}`);
    }
  } finally {
    if (isBatch) {
      console.log('[BATCH-FINAL] ' + JSON.stringify({ status: batchStatus, total: batchTasks.length, completed: logs.length, statuses: logs.map(item => ({ keywordCell: item.task.keywordCell, keyword: item.task.keyword, status: item.status })) }));
    } else {
      log.finishedAt = new Date().toISOString();
      console.log('[FINAL] ' + JSON.stringify(log, null, 2));
    }
    writeExecutionLog();
    const pauseNeeded = isBatch ? batchStatus === 'FAILED' : log.status === 'FAILED';
    const pauseStep = isBatch ? 'batch' : log.failedStep;
    if (pauseNeeded && process.env.NO_PAUSE !== '1') await pause(`Failure step: ${pauseStep}. Review the visible Chrome window and screenshots, then press Enter to close.`);
    if (browser) await browser.close().catch(() => {});
    if (launcherBrowser) await launcherBrowser.close().catch(() => {});
  }
})();
