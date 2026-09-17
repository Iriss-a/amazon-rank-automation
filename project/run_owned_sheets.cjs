const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = __dirname;
const stateDir = path.join(root, 'state');
const buildInfo = readJsonSafe(path.join(root, 'version.json')) || { version: 'unknown' };
const action = (process.argv[2] || 'run').toLowerCase();
const raw = process.argv.find(arg => arg.startsWith('--sheets='))?.slice('--sheets='.length) || '';
const sheets = raw.split(',').map(value => value.trim()).filter(Boolean);
const recheckNotFound = process.argv.includes('--recheck-not-found');

function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function fail(message) { console.error(message); process.exit(2); }
if (!['run', 'resume', 'status', 'pause'].includes(action)) fail('Action must be run, resume, status, or pause.');
if (!sheets.length || sheets.some(name => /[*?]/.test(name) || name.toLowerCase() === 'all') || new Set(sheets).size !== sheets.length) {
  fail('Provide one or more unique exact Sheet names with --sheets=918,B06. Wildcards and all are not allowed.');
}
const scope = sheet => {
  const safe = sheet.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'spu';
  const suffix = safe.toLowerCase() === sheet.toLowerCase() ? '' : `-${crypto.createHash('sha1').update(sheet).digest('hex').slice(0, 8)}`;
  return `sheet-${safe}${suffix}`.toLowerCase();
};
const statePath = sheet => path.join(stateDir, `tencent-${scope(sheet)}-state.json`);
const pausePath = sheet => path.join(stateDir, `tencent-${scope(sheet)}.paused.json`);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const summarize = (sheet, state) => {
  const rows = (state?.results || []).filter(row => row.sheet === sheet && row.keywordCell);
  const latest = new Map();
  for (const row of rows) latest.set(`${row.businessDate}|${row.keywordCell}`, row);
  const values = [...latest.values()];
  const count = status => values.filter(row => row.status === status).length;
  const expected = state?.plans?.find(plan => plan.name === sheet)?.keywords;
  const finished = Number.isInteger(expected) && expected > 0 && values.length === expected &&
    values.every(row => row.status === 'PRESERVED_EXISTING' ||
      (['SUCCESS', 'NOT_FOUND'].includes(row.status) && row.writeback?.verified));
  return {
    sheet,
    businessDate: values.at(-1)?.businessDate || null,
    status: readJson(pausePath(sheet)) ? 'PAUSED' : state?.finishedAt && finished ? 'COMPLETED' : state ? 'RUNNING_OR_RESUMABLE' : 'NOT_STARTED',
    total: values.length,
    success: count('SUCCESS'),
    notFound: count('NOT_FOUND'),
    preservedExisting: count('PRESERVED_EXISTING'),
    technicalFailed: values.filter(row => ['FAILED', 'TECHNICAL_BLOCKED'].includes(row.status)).length,
    writebackVerified: values.filter(row => row.writeback?.verified).length,
    writebackPending: values.filter(row => row.writeback?.pending).length,
    startedAt: state?.startedAt || null,
    finishedAt: state?.finishedAt || null,
  };
};

if (action === 'status') {
  for (const sheet of sheets) console.log('[OWNER-SHEET-STATUS] ' + JSON.stringify(summarize(sheet, readJson(statePath(sheet)))));
  process.exit(0);
}
if (action === 'pause') {
  fs.mkdirSync(stateDir, { recursive: true });
  for (const sheet of sheets) {
    fs.writeFileSync(pausePath(sheet), JSON.stringify({ reason: 'USER_OWNER_SHEET_PAUSE', sheet, createdAt: new Date().toISOString() }, null, 2));
    console.log('[OWNER-SHEET-PAUSE-REQUESTED] ' + JSON.stringify({ sheet, behavior: 'finish-current-keyword-then-stop' }));
  }
  process.exit(0);
}

let failed = 0;
console.log('[OWNER-SHEET-SEQUENCE] ' + JSON.stringify({ action, sheets, concurrency: 1, version: buildInfo.version, browserLifecycle: buildInfo.browserLifecycle || null, recheckNotFound }));
for (const sheet of sheets) {
  if (action === 'resume' && fs.existsSync(pausePath(sheet))) fs.unlinkSync(pausePath(sheet));
  console.log('[OWNER-SHEET-START] ' + JSON.stringify({ sheet, action }));
  const args = [path.join(root, 'run_owned_sheet.cjs'), `--sheet=${sheet}`];
  if (action === 'resume') args.push('--resume-checkpoint');
  if (recheckNotFound) args.push('--recheck-not-found');
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
  const summary = summarize(sheet, readJson(statePath(sheet)));
  console.log('[OWNER-SHEET-FINAL] ' + JSON.stringify({ ...summary, exitCode: result.status ?? 1 }));
  if ((result.status ?? 1) !== 0 || summary.status !== 'COMPLETED') failed += 1;
  if (result.status === 3) {
    console.log('[OWNER-BATCH-STOPPED] Amazon health gate blocked; remaining Sheets were not consumed.');
    break;
  }
}
process.exitCode = failed ? 1 : 0;
