// Tencent Docs multi-sheet coordinator.  It only supplies validated task input
// to the frozen local runner; all Amazon/browser rules remain in run_single_test.cjs.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadTencentDocsToken } = require('./tencent_token.cjs');
const { loadTencentDocConfig } = require('./tencent_doc_config.cjs');
const { loadProjectConfig, colorToChinese: mapColor } = require('./config/project_config.cjs');
const { writeAndVerify } = require('./core/writeback_guard.cjs');
const { formatBusinessDate } = require('./core/date_format.cjs');
const { csvToSheet, encodeCol, encodeCell, decodeCell } = require('./core/sheet_grid.cjs');

const root = __dirname;
const bridge = path.join(root, 'bridge');
const { fileId } = loadTencentDocConfig();
const projectConfig = loadProjectConfig();
const endpoint = 'https://docs.qq.com/api/v6/sheet/mcp';
const stateScope = cleanScope(process.env.AMAZON_STATE_SCOPE || 'multi');
const scopedStateDir = path.join(root, 'state');
if (stateScope !== 'multi') fs.mkdirSync(scopedStateDir, { recursive: true });
const stateFile = stateScope === 'multi' ? path.join(root, 'tencent-multi-state.json') : path.join(scopedStateDir, `tencent-${stateScope}-state.json`);
const coordinatorLockFile = stateScope === 'multi' ? path.join(root, 'tencent-multi-state.coordinator.lock') : path.join(scopedStateDir, `tencent-${stateScope}.coordinator.lock`);
const coordinatorPauseFile = stateScope === 'multi' ? path.join(root, 'tencent-multi-state.paused.json') : path.join(scopedStateDir, `tencent-${stateScope}.paused.json`);
const dailySummaryFile = stateScope === 'multi' ? path.join(root, 'latest-daily-summary.json') : path.join(scopedStateDir, `latest-${stateScope}-summary.json`);
const maxSheetConcurrency = Math.max(1, Math.min(8, Number(process.env.AMAZON_SHEET_CONCURRENCY || 1)));
const maxCollectionPasses = Math.max(1, Math.min(5, Number(process.env.AMAZON_COLLECTION_PASSES || 3)));
const maxNotFoundAttempts = Math.max(1, Math.min(5, Number(process.env.AMAZON_NOT_FOUND_ATTEMPTS || 3)));
// Batch browser mode: one Chrome session for the complete pending portion of
// one Sheet. Checkpoints remain per keyword; a blocked Context is rebuilt and
// receives only the still-unfinished suffix.
const batchBrowserMode = process.argv.includes('--batch-browser') || String(process.env.AMAZON_BATCH_BROWSER || '') === '1';
const maxContextRecoveries = Math.max(1, Math.min(5, Number(process.env.AMAZON_CONTEXT_RECOVERIES || 3)));
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const extractAsins = value => String(value || '').toUpperCase().match(/\bB0[A-Z0-9]{8}\b/g) || [];
const cell = (sheet, row, col) => clean(sheet[encodeCell({ r: row, c: col })]?.w ?? sheet[encodeCell({ r: row, c: col })]?.v);
const colName = col => encodeCol(col);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const lowFreqDelay = () => 20000 + Math.floor(Math.random() * 40001);
const stopNewAfterEpoch = Number(process.env.AMAZON_STOP_NEW_AFTER_EPOCH || 0);
const reachedDispatchCutoff = () => stopNewAfterEpoch > 0 && Date.now() >= stopNewAfterEpoch;
function cleanScope(value) {
  const scope = String(value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!scope) throw new Error('INVALID_STATE_SCOPE');
  return scope.toLowerCase();
}
const isAmazonBlocked = error => /_sec\/verify|WAF|HTTP\s*202|CAPTCHA|人机验证|搜索框无法定位|首页加载异常|网络连接未建立|RUNNER_UNAVAILABLE|RUNNER_STALE|Target page, context or browser has been closed/i.test(String(error || ''));
function requireFreshRunner() {
  let runner;
  try { runner = JSON.parse(fs.readFileSync(path.join(bridge, 'runner-status.json'), 'utf8')); }
  catch (error) { throw new Error(`RUNNER_UNAVAILABLE:STATUS_UNREADABLE:${error.message}`); }
  const ageMs = Date.now() - Date.parse(runner.updatedAt || 0);
  if (!Number.isFinite(ageMs) || ageMs > 45000) throw new Error(`RUNNER_UNAVAILABLE:STALE_HEARTBEAT:${ageMs}`);
  return runner;
}
function amazonHealthCheck() {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'amazon_health_check.cjs')], { cwd: __dirname, encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (result.status !== 0) {
    const detail = (result.stdout || result.stderr || '').trim().slice(-2000);
    fs.writeFileSync(coordinatorPauseFile, JSON.stringify({ reason: 'AMAZON_HEALTH_BLOCKED', detail, createdAt: new Date().toISOString() }), 'utf8');
    console.error('[HEALTH-BLOCKED] ' + detail);
    return false;
  }
  console.log('[HEALTH-OK] ' + (result.stdout || '').trim());
  return true;
}
const isKeyword = value => /^[A-Za-z][A-Za-z0-9 '\-]+$/.test(value);
const normalValue = value => value === projectConfig.writeback.notFoundText || /^\d+\s*[，,]\s*\d+/.test(value);
const colorToChinese = value => mapColor(value, projectConfig) !== 'UNKNOWN' ? mapColor(value, projectConfig) : clean(value) || '未知';

function atomicJson(target, value) {
  const payload = JSON.stringify(value, null, 2);
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const tmp = `${target}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, target);
      return;
    } catch (error) {
      lastError = error;
      try { fs.unlinkSync(tmp); } catch { /* temporary file may be locked or already absent */ }
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 7) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
  throw lastError;
}

function acquireCoordinatorLock() {
  try {
    const descriptor = fs.openSync(coordinatorLockFile, 'wx');
    const lock = { pid: process.pid, startedAt: new Date().toISOString() };
    fs.writeFileSync(descriptor, JSON.stringify(lock), 'utf8');
    fs.closeSync(descriptor);
    return lock;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let holder = {};
    try { holder = JSON.parse(fs.readFileSync(coordinatorLockFile, 'utf8')); } catch { /* preserve unreadable lock */ }
    if (Number.isInteger(holder.pid)) {
      try {
        process.kill(holder.pid, 0);
        throw new Error(`COORDINATOR_ALREADY_RUNNING:PID_${holder.pid}`);
      } catch (probeError) {
        if (probeError.message.startsWith('COORDINATOR_ALREADY_RUNNING')) throw probeError;
        if (probeError.code === 'EPERM') throw new Error(`COORDINATOR_ALREADY_RUNNING:PID_${holder.pid}`);
      }
    }
    // A dead owner's lock must not block a checkpoint recovery after a crash.
    fs.unlinkSync(coordinatorLockFile);
    return acquireCoordinatorLock();
  }
}

function releaseCoordinatorLock(lock) {
  if (!lock) return;
  try {
    const current = JSON.parse(fs.readFileSync(coordinatorLockFile, 'utf8'));
    if (current.pid === lock.pid && current.startedAt === lock.startedAt) fs.unlinkSync(coordinatorLockFile);
  } catch { /* never remove a lock we cannot prove belongs to this process */ }
}
async function rpc(method, params) {
  const readOnly = method === 'initialize' || (method === 'tools/call' && ['get_sheet_info', 'get_cell_data'].includes(params?.name));
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: process.env.TENCENT_DOCS_TOKEN },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      break;
    } catch (error) {
      if (!readOnly || attempt >= 2) throw error;
      await wait(1000 * (attempt + 1));
    }
  }
  const body = JSON.parse(await response.text());
  if (body.error) throw new Error(body.error.message);
  return body.result?.structuredContent || JSON.parse(body.result?.content?.[0]?.text || '{}');
}
async function tool(name, args) { return rpc('tools/call', { name, arguments: args }); }
async function grid(sheetId, rows, cols) {
  const data = await tool('get_cell_data', {
    file_id: fileId, sheet_id: sheetId, start_row: 0, start_col: 0,
    end_row: rows - 1, end_col: cols - 1, return_csv: true,
  });
  return csvToSheet(data.csv_data || '');
}
async function oneCell(sheetId, row, col) {
  const data = await tool('get_cell_data', { file_id: fileId, sheet_id: sheetId, start_row: row, start_col: col, end_row: row, end_col: col, return_csv: true });
  return cell(csvToSheet(data.csv_data || ''), 0, 0);
}
function parseDate(value) {
  const text = clean(value);
  let match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (match) return Date.UTC(+match[1], +match[2] - 1, +match[3]);
  match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (!match) return null;
  const year = +match[3] < 100 ? 2000 + +match[3] : +match[3];
  return Date.UTC(year, +match[1] - 1, +match[2]);
}
function laEpoch() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: projectConfig.business.timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).map(part => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day);
}
function businessDateKey(value = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: projectConfig.business.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function checkpointStartedAt(previous, businessDateEpoch, retained) {
  const targetDate = new Date(businessDateEpoch).toISOString().slice(0, 10);
  if (previous?.businessDateEpoch === businessDateEpoch && previous.startedAt && businessDateKey(previous.startedAt) === targetDate) return previous.startedAt;
  const keys = new Set(retained.filter(item => item.keywordCell).map(item => `${item.sheet}\n${item.keywordCell}\n${item.keyword}`));
  let earliest = null;
  try {
    for (const name of fs.readdirSync(path.join(bridge, 'results')).filter(name => name.startsWith('qq-') && name.endsWith('.json'))) {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(bridge, 'results', name), 'utf8'));
        const task = item.execution?.task, startedAt = item.execution?.startedAt || item.startedAt;
        if (!task || !startedAt || businessDateKey(startedAt) !== targetDate || !keys.has(`${task.sheet}\n${task.keywordCell}\n${task.keyword}`)) continue;
        if (!earliest || Date.parse(startedAt) < Date.parse(earliest)) earliest = startedAt;
      } catch { /* ignore unrelated or partial bridge result */ }
    }
  } catch { /* bridge result directory is validated by the runner */ }
  return earliest || new Date().toISOString();
}
function formatDate(epoch) {
  return formatBusinessDate(epoch);
}
function isHistoricalRank(value) {
  return /^\s*(?:page\s*\d+.*#\s*\d+|\d+\s*[，,]\s*\d+|自然流内未找到该商品|-)/i.test(clean(value));
}
function keywordRegion(sheet, rows, cols, dates) {
  let best = { items: [], score: -1, historyHits: 0 };
  const maxHeaderRow = Math.min(rows, Math.max(8, (dates[0]?.row ?? 8)));
  for (let keywordRow = 0; keywordRow < maxHeaderRow; keywordRow += 1) {
    for (let start = 0; start < cols;) {
      if (!isKeyword(cell(sheet, keywordRow, start))) { start += 1; continue; }
      const items = [];
      let col = start;
      while (col < cols && isKeyword(cell(sheet, keywordRow, col))) {
        const keyword = cell(sheet, keywordRow, col);
        items.push({ col, keyword, keywordCell: `${colName(col)}${keywordRow + 1}`, keywordRow });
        col += 1;
      }
      if (items.length >= 2) {
        const historyHits = items.reduce((sum, item) => sum + dates.reduce((n, date) => n + (isHistoricalRank(cell(sheet, date.row, item.col)) ? 1 : 0), 0), 0);
        const hasCategoryHeader = items.some(item => {
          for (let row = 0; row < keywordRow; row += 1) if (/词根/i.test(cell(sheet, row, item.col))) return true;
          return false;
        });
        const score = historyHits * 1000 + (hasCategoryHeader ? 100 : 0) + items.length;
        if ((historyHits > 0 || hasCategoryHeader) && score > best.score) best = { items, score, historyHits };
      }
      start = Math.max(col, start + 1);
    }
  }
  return best;
}
function dateColumn(sheet, rows, cols) {
  const candidates = [];
  for (let col = 0; col < Math.min(cols, 12); col += 1) {
    const dates = [];
    for (let row = 0; row < rows; row += 1) {
      const value = cell(sheet, row, col), epoch = parseDate(value);
      if (epoch !== null) dates.push({ row, value, epoch });
    }
    if (dates.length >= 2) {
      const regressions = dates.filter((item, index) => index > 0 && item.epoch <= dates[index - 1].epoch).length;
      const tail = dates.slice(-Math.min(10, dates.length));
      const tailIncreasing = !tail.some((item, index) => index > 0 && item.epoch <= tail[index - 1].epoch);
      if (tailIncreasing && regressions / dates.length <= 0.1) candidates.push({ col, dates, regressions });
    }
  }
  if (!candidates.length) return { error: 'NO_STRICTLY_INCREASING_DATE_COLUMN' };
  return candidates.find(item => item.col === 1) || candidates.sort((a, b) => b.dates.length - a.dates.length)[0];
}
function latestDateEvidence(sheet, rows, cols) {
  const candidates = [];
  for (let col = 0; col < Math.min(cols, 12); col += 1) {
    const dates = [];
    for (let row = 0; row < rows; row += 1) {
      const value = cell(sheet, row, col), epoch = parseDate(value);
      if (epoch !== null) dates.push({ row, value, epoch });
    }
    if (dates.length) candidates.push({ col, latest: dates.at(-1), count: dates.length });
  }
  return candidates.find(item => item.col === 1) || candidates.sort((a, b) => b.count - a.count)[0] || null;
}
function variantMap(sheetInfo, sheet) {
  const map = {};
  for (let row = 0; row < sheetInfo.row_count; row += 1) for (let col = 0; col < sheetInfo.col_count - 1; col += 1) {
    const asin = extractAsins(cell(sheet, row, col))[0];
    const standard = cell(sheet, row, col + 1);
    if (asin && standard) {
      const [color = '', ...sizeParts] = standard.split(/[，,]/).map(clean);
      map[asin] = { color: colorToChinese(color), size: sizeParts.join(',') || '' };
    }
  }
  return map;
}
const normalizeSpuKey = value => clean(value).replace(/\s+/g, '').toUpperCase();
function mappingAsinsForSheet(mappingInfo, mappingSheet, sheetName) {
  if (!mappingInfo || !mappingSheet) return [];
  const target = normalizeSpuKey(sheetName);
  if (!target) return [];
  const headerRow = 0;
  const groups = [];
  for (let col = 0; col < mappingInfo.col_count; col += 1) {
    const label = normalizeSpuKey(cell(mappingSheet, headerRow, col));
    if (!label) continue;
    groups.push({ label, start: col, end: mappingInfo.col_count - 1 });
  }
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index + 1]) groups[index].end = groups[index + 1].start - 1;
  }
  const exact = groups.find(item => item.label === target);
  const fuzzy = exact ? [] : groups.filter(item => item.label.startsWith(target) || item.label.endsWith(target));
  const group = exact || (fuzzy.length === 1 ? fuzzy[0] : null);
  if (!group) return [];
  const asins = [];
  for (let row = 1; row < mappingInfo.row_count; row += 1) {
    for (let col = group.start; col <= group.end; col += 1) {
      asins.push(...extractAsins(cell(mappingSheet, row, col)));
    }
  }
  return [...new Set(asins)];
}
function classifySheet(info, sheet, variants, mappingInfo, mappingSheet) {
  const fail = reason => ({ info, status: reason.startsWith('UNCERTAIN') ? 'SKIPPED_UNCERTAIN_STRUCTURE' : 'SKIPPED_NON_AMAZON_SHEET', reason });
  if (/[（(]旧表[）)]/.test(info.sheet_name)) return fail('ARCHIVED_OLD_SHEET');
  if (info.hidden || info.is_hidden || info.visible === false || info.sheet_type !== 'worksheet') return fail('NON_VISIBLE_WORKSHEET');
  if (info.row_count < 4 || info.col_count < 8) return fail('TOO_SMALL_FOR_AMAZON_RANKING_LAYOUT');
  const topAsinCells = [];
  for (let row = 0; row < Math.min(info.row_count, 4); row += 1) for (let col = 0; col < info.col_count; col += 1) {
    const value = cell(sheet, row, col); const found = extractAsins(value);
    if (found.length) topAsinCells.push({ row, col, value, found });
  }
  const labelled = (value, label, other) => {
    const match = String(value).match(new RegExp(`(?:${label})\\s*[:：]([\\s\\S]*?)(?=(?:${other})\\s*[:：]|$)`, 'i'));
    return extractAsins(match?.[1] || '');
  };
  const labelledChildren = topAsinCells.flatMap(item => labelled(item.value, '子体|child', '父体|parent'));
  const labelledParents = topAsinCells.flatMap(item => labelled(item.value, '父体|parent', '子体|child'));
  // Prefer explicit children. In older layouts, the parent/"主卖 asin" sits
  // on the top row while size/colour-specific ASINs sit on the following row;
  // those lower product-ID cells are the child set. Only a Sheet with neither
  // signal keeps an unlabelled ASIN as a candidate.
  const isParentOnly = value => /(?:父体|parent)\s*[:：]/i.test(value) && !/(?:子体|child)\s*[:：]/i.test(value);
  const lowerVariantAsins = topAsinCells.filter(item => item.row > 0 && !isParentOnly(item.value)).flatMap(item => item.found);
  const unlabelledAsins = topAsinCells.filter(item => !isParentOnly(item.value)).flatMap(item => item.found);
  const children = [...new Set(labelledChildren.length ? labelledChildren : (lowerVariantAsins.length ? lowerVariantAsins : unlabelledAsins))];
  const parent = labelledParents[0] || topAsinCells.find(item => item.row === 0 && item.col === 3)?.found[0] || null;
  const mappingAsins = mappingAsinsForSheet(mappingInfo, mappingSheet, info.sheet_name);
  if (!mappingAsins.length) return fail('NON_AMAZON_NO_SPU_MAPPING_ASINS');
  const dates = dateColumn(sheet, info.row_count, info.col_count);
  if (dates.error) return fail(`UNCERTAIN_${dates.error}`);
  const keywordEvidence = keywordRegion(sheet, info.row_count, info.col_count, dates.dates);
  if (!keywordEvidence.items.length) return fail('UNCERTAIN_KEYWORD_REGION_NOT_IDENTIFIABLE_OR_NO_HISTORY_EVIDENCE');
  const historyValues = keywordEvidence.items.flatMap(item => dates.dates.map(date => cell(sheet, date.row, item.col))).filter(isHistoricalRank);
  const outputStyle = historyValues.filter(value => /^\s*page\s*\d+/i.test(value)).length > historyValues.length / 2 ? 'PAGE_HASH' : 'COMMA';
  return { info, sheet, status: 'AMAZON_RANKING_SHEET', parent, children, mappingAsins, keywords: keywordEvidence.items, dates: dates.dates, dateCol: dates.col, keywordHistoryHits: keywordEvidence.historyHits, outputStyle, variantAvailability: Object.fromEntries(children.map(asin => [asin, !!variants[asin]])) };
}
async function ensureDate(plan, businessEpoch) {
  const found = plan.dates.find(item => item.epoch === businessEpoch);
  // An existing business-date row is authoritative, including its displayed
  // separator, year width and zero padding. New rows inherit the immediately
  // preceding date rather than an old first-row format that may be different.
  if (found) return { row: found.row, dateText: found.value, created: false };
  const dateText = formatDate(businessEpoch);
  const row = plan.dates.at(-1).row + 1;
  if (row >= plan.info.row_count) throw new Error('DATE_ROW_CAPACITY_EXCEEDED');
  // Date creation is deferred with result writeback, after Amazon collection.
  return { row, dateText, created: true };
}
async function awaitRunner(id, deadlineMs = 20 * 60 * 1000) {
  const resultFile = path.join(bridge, 'results', `${id}.json`);
  const deadline = Date.now() + deadlineMs;
  let lastRunnerCheck = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        if (result.state === 'COMPLETED' || result.state === 'FAILED') return result;
      } catch { /* atomic file is not complete yet */ }
    }
    // Fail fast when the local runner has gone stale instead of waiting the
    // full 20 minutes with a queued request that nobody can consume.
    if (Date.now() - lastRunnerCheck >= 10000) {
      lastRunnerCheck = Date.now();
      try {
        const runner = JSON.parse(fs.readFileSync(path.join(bridge, 'runner-status.json'), 'utf8'));
        const ageMs = Date.now() - Date.parse(runner.updatedAt || 0);
        const activeTooLong = Array.isArray(runner.activeJobs) && runner.activeJobs.some(job => Date.now() - Date.parse(job.startedAt || 0) > 18 * 60 * 1000);
        if (ageMs > 45000) throw new Error(`RUNNER_STALE:${ageMs}`);
        if (activeTooLong) throw new Error(`RUNNER_JOB_TIMEOUT:${ageMs}`);
      } catch (error) {
        if (String(error.message || error).startsWith('RUNNER_STALE:')) throw error;
      }
    }
    await wait(2000);
  }
  throw new Error('RUNNER_RESULT_TIMEOUT');
}
function completedBridgeResult(sheet, keywordCell, keyword, businessDateEpoch) {
  const files = fs.readdirSync(path.join(bridge, 'results')).filter(name => name.endsWith('.json'));
  const targetDate = new Date(businessDateEpoch).toISOString().slice(0, 10);
  let best = null;
  for (const name of files) {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(bridge, 'results', name), 'utf8'));
      const direct = item.execution?.task ? item.execution : null;
      const batchRow = Array.isArray(item.execution?.results)
        ? item.execution.results.find(row => row.task?.sheet === sheet && row.task?.keywordCell === keywordCell && row.task?.keyword === keyword)
        : null;
      const execution = direct || (batchRow ? { task: batchRow.task, status: batchRow.status, result: batchRow.result, error: batchRow.error, startedAt: batchRow.startedAt, finishedAt: batchRow.finishedAt, durationMs: batchRow.durationMs } : null);
      const task = execution?.task;
      if (!['FOUND', 'NOT_FOUND'].includes(execution?.status)) continue;
      if (item.state === 'COMPLETED' && item.finishedAt && businessDateKey(item.finishedAt) === targetDate && task?.sheet === sheet && task?.keywordCell === keywordCell && task?.keyword === keyword) {
        const candidate = { ...item, execution };
        if (!best || String(item.finishedAt) > String(best.finishedAt)) best = candidate;
      }
    } catch { /* ignore unrelated partial results */ }
  }
  return best;
}
function save(state) { atomicJson(stateFile, state); }
function effectiveResults(results) {
  const latest = new Map();
  const unkeyed = [];
  for (const item of results) {
    if (!item.keywordCell || !item.businessDate) { unkeyed.push(item); continue; }
    const key = `${item.sheet}\n${item.keywordCell}\n${item.businessDate}`;
    const previous = latest.get(key);
    if (!previous || previous.status !== 'SUCCESS' || item.status === 'SUCCESS') latest.set(key, item);
  }
  return [...unkeyed, ...latest.values()];
}
function summary(state) {
  const results = effectiveResults(state.results);
  const count = status => results.filter(item => item.status === status).length;
  const queried = results.filter(item => ['SUCCESS', 'NOT_FOUND', 'FAILED', 'TECHNICAL_BLOCKED'].includes(item.status));
  const technicalFailures = count('FAILED') + count('TECHNICAL_BLOCKED');
  return {
    totalSheets: state.sheets.length,
    amazonSheets: state.plans.length,
    skippedSheets: state.sheets.filter(item => item.status !== 'AMAZON_RANKING_SHEET').length,
    completedSheets: [...new Set(results.map(item => item.sheet))].length,
    keywords: results.length,
    success: count('SUCCESS'), notFound: count('NOT_FOUND'), failed: technicalFailures,
    preservedExisting: count('PRESERVED_EXISTING'), writebackSuccess: results.filter(item => item.writeback?.verified).length,
    writebackPending: results.filter(item => item.writeback?.pending).length,
    writebackFailed: results.filter(item => item.writeback && !item.writeback.verified && !item.writeback.pending).length,
    technicalFailureRate: queried.length ? Number((technicalFailures / queried.length * 100).toFixed(2)) : 0,
    totalDurationMs: Math.max(0, Date.parse(state.finishedAt || new Date().toISOString()) - Date.parse(state.startedAt)),
    averageKeywordDurationMs: queried.length ? Math.round(queried.reduce((sum, item) => sum + (item.durationMs || 0), 0) / queried.length) : 0,
  };
}
function writeDailySummary(state) {
  const totals = summary(state);
  const businessDate = new Date(state.businessDateEpoch).toISOString().slice(0, 10);
  const text = [
    `Amazon 自然排名日报（洛杉矶 ${businessDate}）`,
    `Sheet：${totals.completedSheets}/${totals.amazonSheets} 已处理`,
    `关键词：${totals.keywords}`, `成功：${totals.success}`, `未找到：${totals.notFound}`,
    `技术失败：${totals.failed}`, `腾讯写回成功：${totals.writebackSuccess}`, `腾讯写回待处理：${totals.writebackPending}`, `腾讯写回失败：${totals.writebackFailed}`,
    `技术失败率：${totals.technicalFailureRate}%`,
    `总耗时：${Math.round(totals.totalDurationMs / 60000)} 分钟`,
    state.cycleError ? `运行异常：${state.cycleError}` : '',
  ].filter(Boolean).join('\n');
  atomicJson(dailySummaryFile, { generatedAt: new Date().toISOString(), businessDate, ...totals, cycleError: state.cycleError || null, text });
}
function writeStartupFailureSummary(error) {
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* no prior checkpoint */ }
  const state = previous && Array.isArray(previous.results)
    ? { ...previous, finishedAt: new Date().toISOString(), cycleError: error.message || String(error) }
    : { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), businessDateEpoch: laEpoch(), sheets: [], plans: [], results: [], cycleError: error.message || String(error) };
  save(state);
  writeDailySummary(state);
}
async function flushTencentWritebacks(state, plans) {
  for (const plan of plans) {
    const rows = effectiveResults(state.results).filter(item => item.sheet === plan.info.sheet_name && ['SUCCESS', 'NOT_FOUND'].includes(item.status) && !item.writeback?.verified);
    if (!rows.length) continue;
    try {
      const date = await ensureDate(plan, state.businessDateEpoch);
      if (date.created) {
        await tool('set_cell_value', { file_id: fileId, sheet_id: plan.info.sheet_id, row: date.row, col: plan.dateCol, value_type: 'STRING', string_value: date.dateText });
        const afterDate = await oneCell(plan.info.sheet_id, date.row, plan.dateCol);
        if (afterDate !== date.dateText) throw new Error(`DATE_WRITE_VERIFY_FAILED:${afterDate}`);
      }
      for (const item of rows) {
        const col = decodeCell(item.keywordCell).c;
        try {
          const verified = await writeAndVerify({
            read: () => oneCell(plan.info.sheet_id, date.row, col),
            write: value => tool('set_cell_value', { file_id: fileId, sheet_id: plan.info.sheet_id, row: date.row, col, value_type: 'STRING', string_value: value }),
            expected: item.writeback.value,
          });
          item.writeback = { value: item.writeback.value, before: verified.before, after: verified.after, verified: true };
        } catch (writeError) {
          item.writeback = { value: item.writeback.value, verified: false, error: writeError.message || String(writeError) };
          console.error('[TENCENT-WRITEBACK-FAILED] ' + JSON.stringify({ sheet: item.sheet, keywordCell: item.keywordCell, error: item.writeback.error }));
        }
        save(state);
      }
    } catch (writeError) {
      for (const item of rows) item.writeback = { value: item.writeback.value, verified: false, error: writeError.message || String(writeError) };
      save(state);
      console.error('[TENCENT-WRITEBACK-FAILED] ' + JSON.stringify({ sheet: plan.info.sheet_name, error: writeError.message || String(writeError) }));
    }
  }
}
function failureSignature(error) { return clean(error || 'UNKNOWN').replace(/\b\d{2,}\b/g, '#').replace(/https?:\/\/\S+/g, '<url>').slice(0, 240); }

function optionValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function successRowValue(plan, mapping, execution, asin) {
  const result = execution.result || {};
  if (!result.page || !result.pageNaturalPosition || !asin) throw new Error('FOUND_RANK_OR_ASIN_INCOMPLETE');
  const mapped = mapping[asin] || null;
  const color = mapped?.color || colorToChinese(result.color_CN && result.color_CN !== 'UNKNOWN' ? result.color_CN : result.color_EN || result.color);
  const selectedSize = mapped?.size || (result.selectedSize && result.selectedSize !== 'UNKNOWN' ? result.selectedSize : result.size && result.size !== 'UNKNOWN' ? result.size : '未知');
  // Historical COMMA cells store the mapped color label as a complete
  // descriptor (for example `裸色羊京绒8`), so appending the separate
  // size again would produce the incorrect `裸色羊京绒8，8`.
  const descriptor = mapped?.color ? color : `${color}，${selectedSize}`;
  return plan.outputStyle === 'PAGE_HASH' ? `Page ${result.page} · #${result.pageNaturalPosition}` : `${result.page}，${result.pageNaturalPosition}，${descriptor}`;
}

async function collectSheet(plan, state, mapping, workerId, keywordLimit = null) {
  if (batchBrowserMode) return collectSheetBatch(plan, state, mapping, workerId, keywordLimit);
  const sheetName = plan.info.sheet_name;
  const run = state.sheetRuns[sheetName] = { status: 'RUNNING', workerId, startedAt: new Date().toISOString(), finishedAt: null };
  let repeated = { signature: null, count: 0 };
  let date;
  try { date = await ensureDate(plan, state.businessDateEpoch); }
  catch (error) {
    state.results.push({ sheet: sheetName, status: 'SHEET_FAILED', error: `DATE_POSITION_FAILED:${error.message}`, durationMs: 0 });
    Object.assign(run, { status: 'FAILED', error: error.message, finishedAt: new Date().toISOString() });
    save(state); return;
  }
  let dispatched = 0;
  const targetKeywordCell = optionValue('keyword-cell');
  for (const keyword of plan.keywords) {
    if (targetKeywordCell && keyword.keywordCell !== targetKeywordCell) continue;
    // Finish an already-dispatched keyword, then stop before consuming the
    // next one. This keeps results on the business date selected at startup
    // and makes the 15:00 China / 00:00 Los Angeles rollover deterministic.
    if (reachedDispatchCutoff()) {
      console.log('[BUSINESS-DATE-CUTOFF] ' + JSON.stringify({ sheet: sheetName, keywordCell: keyword.keywordCell, stopNewAfterEpoch }));
      Object.assign(run, { status: 'CUTOFF_REACHED', finishedAt: new Date().toISOString() });
      save(state); return;
    }
    if (fs.existsSync(coordinatorPauseFile)) {
      Object.assign(run, { status: 'PAUSED', finishedAt: new Date().toISOString() });
      save(state); return;
    }
    const completedStatuses = process.argv.includes('--recheck-not-found') ? ['SUCCESS', 'PRESERVED_EXISTING'] : ['SUCCESS', 'NOT_FOUND', 'PRESERVED_EXISTING'];
    if (state.results.some(item => item.sheet === sheetName && item.keywordCell === keyword.keywordCell && item.businessDate === date.dateText && completedStatuses.includes(item.status))) continue;
    if (keywordLimit !== null && dispatched >= keywordLimit) break;
    dispatched += 1;
    const started = Date.now();
    const before = cell(plan.sheet, date.row, keyword.col);
    const base = { sheet: sheetName, keyword: keyword.keyword, keywordCell: keyword.keywordCell, outputCell: `${colName(keyword.col)}${date.row + 1}`, businessDate: date.dateText, before, durationMs: 0, writeback: null };
    if (before && normalValue(before)) {
      state.results.push({ ...base, status: 'PRESERVED_EXISTING', durationMs: Date.now() - started });
      save(state); continue;
    }
    if (before) {
      console.warn('[INVALID-EXISTING-VALUE] ' + JSON.stringify({ sheet: sheetName, keyword: keyword.keyword, outputCell: base.outputCell, before }));
    }
    const id = `qq-${plan.info.sheet_id}-${keyword.col}-${Date.now()}`;
    try {
      let runner = process.argv.includes('--recheck-not-found') ? null : completedBridgeResult(sheetName, keyword.keywordCell, keyword.keyword, state.businessDateEpoch);
      if (runner) console.log('[RECOVER-COMPLETED] ' + JSON.stringify({ workerId, sheet: sheetName, keyword: keyword.keyword, priorJob: runner.id }));
      if (!runner) {
        // Never enqueue work against a dead runner. Without this preflight a
        // stale IDLE status caused every Sheet to enqueue immediately, while
        // awaitRunner rejected each request as stale.
        requireFreshRunner();
        const task = { spu: sheetName, sheet: sheetName, keyword: keyword.keyword, keywordCell: keyword.keywordCell, parentAsin: plan.parent, childAsins: plan.children, mappingAsins: plan.mappingAsins || [], maxPages: projectConfig.amazon.maxPages, mode: 'full', createdAt: new Date().toISOString() };
        atomicJson(path.join(bridge, 'requests', `${id}.json`), { id, action: 'run_single_amazon_test', sheet: sheetName, task, createdAt: new Date().toISOString() });
        console.log('[QUEUE] ' + JSON.stringify({ workerId, sheet: sheetName, keyword: keyword.keyword, id, outputCell: base.outputCell }));
        runner = await awaitRunner(id);
      }
      const execution = runner.execution || {};
      let value, status, asin = execution.result?.asin || execution.task?.childAsin || null;
      if (execution.status === 'FOUND') { value = successRowValue(plan, mapping, execution, asin); status = 'SUCCESS'; }
      else if (execution.status === 'NOT_FOUND') { value = projectConfig.writeback.notFoundText; status = 'NOT_FOUND'; }
      else throw new Error(`AMAZON_${execution.status || runner.state}:${execution.error || runner.error || 'UNKNOWN'}`);
      const row = { ...base, asin, status, result: execution.result || null, durationMs: Date.now() - started, writeback: { value, verified: false, pending: true } };
      state.results.push(row); save(state); repeated = { signature: null, count: 0 };
      console.log('[RESULT] ' + JSON.stringify({ workerId, ...row }));
      if (status === 'SUCCESS' || status === 'NOT_FOUND') {
        const delayMs = lowFreqDelay();
        console.log('[LOW-FREQ-DELAY] ' + JSON.stringify({ sheet: sheetName, keywordCell: keyword.keywordCell, delayMs }));
        await wait(delayMs);
      }
    } catch (error) {
      const err = error.message || String(error), signature = failureSignature(err), blocked = isAmazonBlocked(err);
      const row = { ...base, status: blocked ? 'TECHNICAL_BLOCKED' : 'FAILED', error: err, durationMs: Date.now() - started, writeback: null };
      state.results.push(row); save(state); console.error('[KEYWORD-FAILED] ' + JSON.stringify({ workerId, ...row }));
      if (blocked) {
        fs.writeFileSync(coordinatorPauseFile, JSON.stringify({ reason: 'AMAZON_BLOCKED', sheet: sheetName, keywordCell: keyword.keywordCell, error: err, createdAt: new Date().toISOString() }), 'utf8');
        Object.assign(run, { status: 'TECHNICAL_BLOCKED', error: err, finishedAt: new Date().toISOString() });
        save(state);
        return;
      }
      repeated = repeated.signature === signature ? { signature, count: repeated.count + 1 } : { signature, count: 1 };
      if (repeated.count >= 3) {
        Object.assign(run, { status: 'FAILED_SYSTEMIC', error: `SYSTEMIC_TECHNICAL_FAILURE_AFTER_3:${signature}`, finishedAt: new Date().toISOString() });
        save(state); return;
      }
    }
  }
  Object.assign(run, { status: keywordLimit === null ? 'COMPLETED' : 'TEST_COMPLETED', finishedAt: new Date().toISOString() });
  save(state);
}

function applyKeywordOutcome(plan, state, mapping, item, execution, workerId, durationMs) {
  const { base } = item;
  let value, status;
  const asin = execution?.result?.asin || execution?.task?.childAsin || null;
  try {
    if (execution?.status === 'FOUND') { value = successRowValue(plan, mapping, execution, asin); status = 'SUCCESS'; }
    else if (execution?.status === 'NOT_FOUND') { value = projectConfig.writeback.notFoundText; status = 'NOT_FOUND'; }
    else throw new Error(`AMAZON_${execution?.status || 'NO_RESULT'}:${execution?.error || (execution ? 'UNKNOWN' : 'BATCH_INCOMPLETE:KEYWORD_HAS_NO_OUTCOME')}`);
  } catch (error) {
    const err = error.message || String(error);
    const blocked = isAmazonBlocked(err);
    const row = { ...base, status: blocked ? 'TECHNICAL_BLOCKED' : 'FAILED', error: err, durationMs, writeback: null };
    state.results.push(row);
    console.error('[KEYWORD-FAILED] ' + JSON.stringify({ workerId, ...row }));
    return { status: row.status, blocked, error: err };
  }
  const row = { ...base, asin, status, result: execution.result || null, durationMs, writeback: { value, verified: false, pending: true } };
  state.results.push(row);
  console.log('[RESULT] ' + JSON.stringify({ workerId, ...row }));
  return { status, blocked: false, error: null };
}

// Batch-mode sheet collection: pending keywords are grouped into chunks and
// each chunk runs inside one shared Chrome session (runner action
// run_batch_amazon_tests).  Pause files, the business-date cutoff, checkpoint
// skipping, preserved values, and per-keyword bridge recovery all behave
// exactly as in single mode; only the per-keyword low-frequency delay moves
// inside the batch business script.
async function collectSheetBatch(plan, state, mapping, workerId, keywordLimit = null) {
  const sheetName = plan.info.sheet_name;
  const run = state.sheetRuns[sheetName] = { status: 'RUNNING', workerId, startedAt: new Date().toISOString(), finishedAt: null };
  let date;
  try { date = await ensureDate(plan, state.businessDateEpoch); }
  catch (error) {
    state.results.push({ sheet: sheetName, status: 'SHEET_FAILED', error: `DATE_POSITION_FAILED:${error.message}`, durationMs: 0 });
    Object.assign(run, { status: 'FAILED', error: error.message, finishedAt: new Date().toISOString() });
    save(state); return;
  }
  const targetKeywordCell = optionValue('keyword-cell');
  const completedStatuses = process.argv.includes('--recheck-not-found') ? ['SUCCESS', 'PRESERVED_EXISTING'] : ['SUCCESS', 'NOT_FOUND', 'PRESERVED_EXISTING'];
  const pending = [];
  for (const keyword of plan.keywords) {
    if (targetKeywordCell && keyword.keywordCell !== targetKeywordCell) continue;
    if (fs.existsSync(coordinatorPauseFile) || reachedDispatchCutoff()) break;
    if (state.results.some(item => item.sheet === sheetName && item.keywordCell === keyword.keywordCell && item.businessDate === date.dateText && completedStatuses.includes(item.status))) continue;
    if (keywordLimit !== null && pending.length >= keywordLimit) break;
    const started = Date.now();
    const before = cell(plan.sheet, date.row, keyword.col);
    const base = { sheet: sheetName, keyword: keyword.keyword, keywordCell: keyword.keywordCell, outputCell: `${colName(keyword.col)}${date.row + 1}`, businessDate: date.dateText, before, durationMs: 0, writeback: null };
    if (before && normalValue(before)) {
      state.results.push({ ...base, status: 'PRESERVED_EXISTING', durationMs: Date.now() - started });
      save(state); continue;
    }
    if (before) {
      console.warn('[INVALID-EXISTING-VALUE] ' + JSON.stringify({ sheet: sheetName, keyword: keyword.keyword, outputCell: base.outputCell, before }));
    }
    pending.push({ keyword, base, started });
  }
  save(state);
  console.log('[SHEET-CONTEXT-PENDING] ' + JSON.stringify({ workerId, sheet: sheetName, pending: pending.length, browserLifecycle: 'ONE_CONTEXT_PER_SHEET', businessDate: date.dateText }));
  let contextGeneration = 0;
  let healthChecked = false;
  let blockedRecoveries = 0;
  const technicalAttempts = new Map();
  const notFoundAttempts = new Map();
  const exhausted = new Set();
  const completedStatusesSet = new Set(completedStatuses);
  const isCompleted = item => effectiveResults(state.results).some(row =>
    row.sheet === sheetName && row.keywordCell === item.keyword.keywordCell &&
    row.businessDate === date.dateText && completedStatusesSet.has(row.status));
  while (pending.some(item => !isCompleted(item) && !exhausted.has(item.keyword.keywordCell))) {
    if (fs.existsSync(coordinatorPauseFile)) {
      Object.assign(run, { status: 'PAUSED', finishedAt: new Date().toISOString() });
      save(state); return;
    }
    if (reachedDispatchCutoff()) {
      console.log('[BUSINESS-DATE-CUTOFF] ' + JSON.stringify({ sheet: sheetName, contextGeneration, stopNewAfterEpoch }));
      Object.assign(run, { status: 'CUTOFF_REACHED', finishedAt: new Date().toISOString() });
      save(state); return;
    }
    const chunk = [];
    for (const item of pending.filter(item => !isCompleted(item) && !exhausted.has(item.keyword.keywordCell))) {
      let runner = process.argv.includes('--recheck-not-found') ? null : completedBridgeResult(sheetName, item.keyword.keywordCell, item.keyword.keyword, state.businessDateEpoch);
      if (runner) {
        console.log('[RECOVER-COMPLETED] ' + JSON.stringify({ workerId, sheet: sheetName, keyword: item.keyword.keyword, priorJob: runner.id }));
        applyKeywordOutcome(plan, state, mapping, item, runner.execution, workerId, Date.now() - item.started);
        save(state);
      } else {
        chunk.push(item);
      }
    }
    if (!chunk.length) break;
    // Recovered results and writeback-only resumes need no Amazon browser.
    if (!healthChecked) {
      if (!amazonHealthCheck()) {
        Object.assign(run, { status: 'TECHNICAL_BLOCKED', finishedAt: new Date().toISOString() });
        process.exitCode = 3;
        save(state); return;
      }
      healthChecked = true;
    }
    contextGeneration += 1;
    const id = `qq-${plan.info.sheet_id}-sheet-${contextGeneration}-${Date.now()}`;
    try {
      requireFreshRunner();
      const tasks = chunk.map(item => ({ spu: sheetName, sheet: sheetName, keyword: item.keyword.keyword, keywordCell: item.keyword.keywordCell, parentAsin: plan.parent, childAsins: plan.children, mappingAsins: plan.mappingAsins || [], maxPages: projectConfig.amazon.maxPages, mode: 'full' }));
      const chunkTimeoutMs = Math.min(8 * 60 * 60 * 1000, (chunk.length * 360 + 240) * 1000);
      atomicJson(path.join(bridge, 'requests', `${id}.json`), { id, action: 'run_batch_amazon_tests', sheet: sheetName, tasks, batchPauseFile: coordinatorPauseFile, timeoutMs: chunkTimeoutMs, createdAt: new Date().toISOString() });
      console.log('[SHEET-CONTEXT-QUEUE] ' + JSON.stringify({ workerId, sheet: sheetName, contextGeneration, id, keywords: chunk.map(item => item.keyword.keyword), outputCells: chunk.map(item => item.base.outputCell), timeoutMs: chunkTimeoutMs }));
      const result = await awaitRunner(id, chunkTimeoutMs + 5 * 60 * 1000);
      const outcomes = Array.isArray(result.execution?.results) ? result.execution.results : [];
      if (outcomes.length === 0 && !fs.existsSync(coordinatorPauseFile)) {
        throw new Error(`SHEET_CONTEXT_NO_OUTCOMES:state=${result.state}:exitCode=${result.exitCode}:log=${result.logPath || id}:error=${result.execution?.error || 'unknown'}`);
      }
      let blockedOutcome = null;
      for (const item of chunk) {
        const outcomeLog = outcomes.find(row => row.task?.keywordCell === item.keyword.keywordCell && row.task?.keyword === item.keyword.keyword) || null;
        // A blocked Context stops before later tasks. Those tasks remain absent
        // from the execution envelope and therefore remain pending; do not
        // manufacture failures for work that never started.
        if (!outcomeLog) continue;
        const execution = outcomeLog ? { status: outcomeLog.status, result: outcomeLog.result, error: outcomeLog.error, durationMs: outcomeLog.durationMs } : null;
        const applied = applyKeywordOutcome(plan, state, mapping, item, execution, workerId, Number(outcomeLog?.durationMs) || Date.now() - item.started);
        save(state);
        if (applied.blocked) { blockedOutcome = { item, applied }; break; }
        if (applied.status === 'NOT_FOUND') {
          const attempts = (notFoundAttempts.get(item.keyword.keywordCell) || 0) + 1;
          notFoundAttempts.set(item.keyword.keywordCell, attempts);
          if (process.argv.includes('--recheck-not-found') && attempts >= maxNotFoundAttempts) {
            exhausted.add(item.keyword.keywordCell);
            console.log('[NOT-FOUND-RECHECK-EXHAUSTED] ' + JSON.stringify({ sheet: sheetName, keywordCell: item.keyword.keywordCell, attempts: maxNotFoundAttempts }));
          }
        }
        if (applied.status === 'FAILED') {
          const attempts = (technicalAttempts.get(item.keyword.keywordCell) || 0) + 1;
          technicalAttempts.set(item.keyword.keywordCell, attempts);
          if (attempts >= maxCollectionPasses) {
            exhausted.add(item.keyword.keywordCell);
            console.error('[KEYWORD-RECOVERY-EXHAUSTED] ' + JSON.stringify({ sheet: sheetName, keywordCell: item.keyword.keywordCell, attempts }));
          }
        }
      }
      if (blockedOutcome) {
        blockedRecoveries += 1;
        if (blockedRecoveries >= maxContextRecoveries) {
          fs.writeFileSync(coordinatorPauseFile, JSON.stringify({ reason: 'AMAZON_BLOCKED_AFTER_CONTEXT_RECOVERY', sheet: sheetName, keywordCell: blockedOutcome.item.keyword.keywordCell, recoveries: blockedRecoveries, error: blockedOutcome.applied.error, createdAt: new Date().toISOString() }), 'utf8');
          Object.assign(run, { status: 'TECHNICAL_BLOCKED', error: blockedOutcome.applied.error, finishedAt: new Date().toISOString() });
          save(state); return;
        }
        const recoveryDelayMs = 15000 * blockedRecoveries;
        console.log('[SHEET-CONTEXT-REBUILD] ' + JSON.stringify({ sheet: sheetName, failedKeywordCell: blockedOutcome.item.keyword.keywordCell, blockedRecoveries, maxContextRecoveries, recoveryDelayMs, completedKeywords: pending.filter(isCompleted).length }));
        await wait(recoveryDelayMs);
        continue;
      }
      blockedRecoveries = 0;
    } catch (error) {
      const err = error.message || String(error), blocked = isAmazonBlocked(err);
      if (blocked) {
        blockedRecoveries += 1;
        if (blockedRecoveries < maxContextRecoveries) {
          const recoveryDelayMs = 15000 * blockedRecoveries;
          console.log('[SHEET-CONTEXT-REBUILD] ' + JSON.stringify({ sheet: sheetName, contextGeneration, blockedRecoveries, maxContextRecoveries, recoveryDelayMs, error: err }));
          await wait(recoveryDelayMs);
          continue;
        }
      }
      fs.writeFileSync(coordinatorPauseFile, JSON.stringify({ reason: blocked ? 'AMAZON_BLOCKED_AFTER_CONTEXT_RECOVERY' : 'SHEET_CONTEXT_JOB_FAILED', sheet: sheetName, contextGeneration, recoveries: blockedRecoveries, error: err, createdAt: new Date().toISOString() }), 'utf8');
      Object.assign(run, { status: blocked ? 'TECHNICAL_BLOCKED' : 'FAILED_SYSTEMIC', error: err, finishedAt: new Date().toISOString() });
      save(state); return;
    }
  }
  Object.assign(run, { status: 'COMPLETED', finishedAt: new Date().toISOString() });
  save(state);
}

async function collectSheets(plans, state, mapping, keywordLimit) {
  let nextIndex = 0;
  async function worker(workerId) {
    while (true) {
      if (fs.existsSync(coordinatorPauseFile)) return;
      const index = nextIndex++;
      if (index >= plans.length) return;
      const plan = plans[index];
      try { await collectSheet(plan, state, mapping, workerId, keywordLimit); }
      catch (error) {
        state.sheetRuns[plan.info.sheet_name] = { status: 'FAILED', workerId, error: error.message || String(error), finishedAt: new Date().toISOString() };
        save(state);
        console.error('[SHEET-FAILED] ' + JSON.stringify({ workerId, sheet: plan.info.sheet_name, error: error.message || String(error) }));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxSheetConcurrency, plans.length) }, (_, index) => worker(index + 1)));
}

async function main() {
  loadTencentDocsToken();
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex', version: '1' } });
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  // An unfinished cycle keeps its original LA business date across a deliberate
  // pause or crash, so resuming on a later wall-clock date cannot discard its checkpoint.
  const resumeCheckpoint = process.argv.includes('--resume-checkpoint');
  const businessDateEpoch = (resumeCheckpoint || previous?.finishedAt === null) && Number.isFinite(previous?.businessDateEpoch)
    ? previous.businessDateEpoch
    : laEpoch();
  const requestedSheets = optionValue('sheets')?.split(',').map(clean).filter(Boolean) || null;
  const infos = (await tool('get_sheet_info', { file_id: fileId })).sheets || [];
  const mappingInfo = infos.find(info => info.sheet_name === 'asin尺寸颜色对应表');
  if (!mappingInfo) throw new Error('STANDARD_VARIANT_MAPPING_SHEET_MISSING');
  if (requestedSheets) {
    const knownNames = new Set(infos.map(info => info.sheet_name));
    const missing = requestedSheets.filter(name => !knownNames.has(name));
    if (missing.length) throw new Error(`TEST_SHEET_NOT_FOUND:${missing.join(',')}`);
  }
  const mappingSheet = await grid(mappingInfo.sheet_id, mappingInfo.row_count, mappingInfo.col_count);
  const mapping = variantMap(mappingInfo, mappingSheet);
  const sheets = [], plans = [];
  const infosToInspect = requestedSheets ? infos.filter(info => requestedSheets.includes(info.sheet_name)) : infos;
  for (const info of infosToInspect) {
    if (info.sheet_id === mappingInfo.sheet_id) { sheets.push({ name: info.sheet_name, status: 'SKIPPED_NON_AMAZON_SHEET', reason: 'STANDARD_VARIANT_MAPPING_SHEET' }); continue; }
    try {
      const sheet = await grid(info.sheet_id, info.row_count, info.col_count);
      const latestEvidence = latestDateEvidence(sheet, info.row_count, info.col_count);
      const evidenceDays = latestEvidence ? Math.floor((businessDateEpoch - latestEvidence.latest.epoch) / 86400000) : null;
      if (evidenceDays > projectConfig.business.staleSheetDays) {
        sheets.push({ name: info.sheet_name, status: 'SKIPPED_STALE_SHEET', reason: `LATEST_DATE_${latestEvidence.latest.value}_IS_${evidenceDays}_DAYS_BEHIND`, keywordCount: 0, childAsins: [], latestDate: latestEvidence.latest.value, staleDays: evidenceDays });
        continue;
      }
      const plan = classifySheet(info, sheet, mapping, mappingInfo, mappingSheet);
      const latest = plan.dates?.at(-1);
      const staleDays = latest ? Math.floor((businessDateEpoch - latest.epoch) / 86400000) : null;
      if (plan.status === 'AMAZON_RANKING_SHEET' && staleDays > projectConfig.business.staleSheetDays) {
        sheets.push({ name: info.sheet_name, status: 'SKIPPED_STALE_SHEET', reason: `LATEST_DATE_${latest.value}_IS_${staleDays}_DAYS_BEHIND`, keywordCount: plan.keywords.length, childAsins: plan.children, latestDate: latest.value, staleDays });
      } else {
        sheets.push({ name: info.sheet_name, status: plan.status, reason: plan.reason || null, keywordCount: plan.keywords?.length || 0, childAsins: plan.children || [], latestDate: latest?.value || null, staleDays });
        if (plan.status === 'AMAZON_RANKING_SHEET') plans.push(plan);
      }
    } catch (error) {
      sheets.push({ name: info.sheet_name, status: 'SKIPPED_UNCERTAIN_STRUCTURE', reason: `READ_OR_PARSE_ERROR:${error.message}` });
    }
  }
  const retained = previous?.businessDateEpoch === businessDateEpoch && Array.isArray(previous?.results) ? previous.results : [];
  const state = { startedAt: checkpointStartedAt(previous, businessDateEpoch, retained), finishedAt: null, businessDateEpoch, maxSheetConcurrency, sheets, plans: plans.map(plan => ({ name: plan.info.sheet_name, id: plan.info.sheet_id, keywords: plan.keywords.length, sheetTopAsinsIgnored: plan.children, mappingAsinCount: plan.mappingAsins?.length || 0, asinSource: 'SPU-scoped asin尺寸颜色对应表 only', keywordHeaderRow: plan.keywords[0].keywordRow + 1, keywordRange: `${plan.keywords[0].keywordCell}:${plan.keywords.at(-1).keywordCell}`, dateColumn: colName(plan.dateCol), keywordHistoryHits: plan.keywordHistoryHits, outputStyle: plan.outputStyle })), sheetRuns: previous?.sheetRuns || {}, results: retained };
  save(state);
  console.log('[SHEET-SCAN] ' + JSON.stringify({ total: sheets.length, valid: plans.map(plan => ({ sheet: plan.info.sheet_name, keywords: plan.keywords.length, sheetTopAsinsIgnored: plan.children, mappingAsinCount: plan.mappingAsins?.length || 0 })), skipped: sheets.filter(item => item.status !== 'AMAZON_RANKING_SHEET') }));
  if (process.argv.includes('--scan-only')) return;

  const selectedSheets = requestedSheets;
  const keywordLimitValue = optionValue('max-keywords-per-sheet');
  const keywordLimit = keywordLimitValue === null ? null : Math.max(1, Number(keywordLimitValue));
  const runPlans = selectedSheets ? plans.filter(plan => selectedSheets.includes(plan.info.sheet_name)) : plans;
  if (selectedSheets && runPlans.length !== selectedSheets.length) throw new Error(`TEST_SHEET_NOT_FOUND:${selectedSheets.filter(name => !runPlans.some(plan => plan.info.sheet_name === name)).join(',')}`);
  console.log('[PARALLEL-CONFIG] ' + JSON.stringify({ maxSheetConcurrency, maxCollectionPasses, resumeCheckpoint, batchBrowserMode, browserLifecycle: batchBrowserMode ? 'ONE_CONTEXT_PER_SHEET' : 'ONE_CONTEXT_PER_KEYWORD', maxContextRecoveries, sheets: runPlans.map(plan => plan.info.sheet_name), keywordLimit, collectOnly: process.argv.includes('--collect-only') }));
  const collectOnly = process.argv.includes('--collect-only');
  let healthBlocked = false;
  try {
    for (let pass = 1; pass <= maxCollectionPasses; pass += 1) {
      if (!batchBrowserMode && !amazonHealthCheck()) { healthBlocked = true; break; }
      if (pass > 1) {
        // Give Amazon's shared-IP WAF and the interactive runner a recovery
        // window between bounded retry passes; immediate re-submission tends
        // to reproduce the same interstitial across all three contexts.
        const retryBackoffMs = Math.min(60000, 15000 * (pass - 1));
        console.log('[COLLECTION-BACKOFF] ' + JSON.stringify({ pass, retryBackoffMs }));
        await wait(retryBackoffMs);
      }
      await collectSheets(runPlans, state, mapping, keywordLimit);
      const failed = effectiveResults(state.results).filter(item => item.keywordCell && item.businessDate && item.status === 'FAILED' && runPlans.some(plan => plan.info.sheet_name === item.sheet));
      console.log('[COLLECTION-PASS] ' + JSON.stringify({ pass, remainingTechnicalFailures: failed.length }));
      if (!failed.length || keywordLimit !== null || fs.existsSync(coordinatorPauseFile)) break;
    }
  } finally {
    state.finishedAt = collectOnly ? null : new Date().toISOString(); save(state);
    // The local summary exists before the Tencent write phase, so a Tencent
    // outage never loses collected rankings or suppresses DingTalk notification.
    writeDailySummary(state);
    if (!collectOnly) await flushTencentWritebacks(state, plans);
    state.finishedAt = collectOnly ? null : new Date().toISOString(); save(state);
    writeDailySummary(state);
    console.log('[SUMMARY] ' + JSON.stringify(summary(state)));
    if (healthBlocked) process.exitCode = 3;
  }
}
(async () => {
  let lock = null;
  try {
    if (fs.existsSync(coordinatorPauseFile)) {
      let pause = {};
      try { pause = JSON.parse(fs.readFileSync(coordinatorPauseFile, 'utf8')); } catch { /* preserve unknown pause */ }
      if (/USER_|MANUAL_/i.test(String(pause.reason || ''))) {
        console.log('[COORDINATOR-PAUSED] User pause is active; use the owner-scoped resume command.');
        return;
      }
      if (!amazonHealthCheck()) { console.log('[COORDINATOR-PAUSED] Amazon health check still blocked.'); return; }
      fs.unlinkSync(coordinatorPauseFile);
      console.log('[COORDINATOR-RESUME-HEALTHY] Amazon health check passed; continuing checkpoint.');
    }
    lock = acquireCoordinatorLock();
    console.log('[COORDINATOR-LOCK] ' + JSON.stringify(lock));
    await main();
  } catch (error) {
    if (!lock && String(error.message || error).startsWith('COORDINATOR_ALREADY_RUNNING:')) {
      console.log('[COORDINATOR-SKIP] ' + (error.message || error));
      return;
    }
    try { writeStartupFailureSummary(error); } catch (summaryError) { console.error('[SUMMARY-FAIL] ' + (summaryError.stack || summaryError.message)); }
    console.error('[CYCLE-FAIL] ' + (error.stack || error.message));
    process.exitCode = 1;
  } finally {
    releaseCoordinatorLock(lock);
  }
})();
