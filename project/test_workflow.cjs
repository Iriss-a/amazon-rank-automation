const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'run_tencent_multi_sheet_cycle.cjs'), 'utf8');
const batchSource = source.slice(source.indexOf('async function collectSheetBatch('), source.indexOf('async function collectSheets('));
const { formatBusinessDate, formatDateLike } = require('./core/date_format.cjs');
const { classifySearchCards } = require('./core/rank_parser.cjs');
const { buildExportRecords, formatJsonl, formatCsv, exportResults } = require('./core/structured_export.cjs');

async function scenario({ completed = false, recovered = false, startupFailures = 0, health = true } = {}) {
  const counts = { health: 0, dispatch: 0, saves: 0, pauses: 0 };
  const keyword = { keyword: 'jelly sandals', keywordCell: 'G1', col: 6 };
  const plan = { info: { sheet_name: 'TEST', sheet_id: 'test' }, keywords: [keyword], sheet: {}, children: ['B012345678'] };
  const row = { sheet: 'TEST', keywordCell: 'G1', businessDate: '9/15/26', status: 'SUCCESS', writeback: { pending: true } };
  const state = { sheetRuns: {}, results: completed ? [row] : [], businessDateEpoch: 0 };
  const context = {
    console: { log() {}, warn() {}, error() {} }, process: { argv: [], exitCode: 0 },
    fs: { existsSync: () => counts.pauses > 0, writeFileSync: () => counts.pauses++ },
    path, bridge: 'mock', coordinatorPauseFile: 'mock-pause',
    ensureDate: async () => ({ row: 78, dateText: '9/15/26' }), optionValue: () => null,
    reachedDispatchCutoff: () => false, cell: () => '', normalValue: () => false,
    colName: () => 'G', save: () => counts.saves++, effectiveResults: rows => rows,
    completedBridgeResult: () => recovered ? { id: 'old', execution: { status: 'FOUND' } } : null,
    applyKeywordOutcome: () => { state.results.push({ ...row }); return { status: 'SUCCESS', blocked: false }; },
    amazonHealthCheck: () => { counts.health++; if (!health) counts.pauses++; return health; },
    requireFreshRunner() {}, projectConfig: { amazon: { maxPages: 7 } },
    atomicJson: () => counts.dispatch++,
    awaitRunner: async () => counts.dispatch <= startupFailures
      ? { state: 'FAILED', exitCode: 1, execution: { error: 'WAF HTTP 202', results: [] } }
      : { execution: { results: [{ task: keyword, status: 'FOUND', durationMs: 10 }] } },
    maxContextRecoveries: 3, maxCollectionPasses: 3,
    isAmazonBlocked: error => /WAF|HTTP 202/.test(error), wait: async () => {},
  };
  vm.createContext(context);
  vm.runInContext(batchSource, context);
  await context.collectSheetBatch(plan, state, {}, 1);
  return { counts, state, exitCode: context.process.exitCode };
}

(async () => {
  assert.equal(formatBusinessDate(Date.UTC(2026, 8, 15)), '2026/9/15');
  assert.equal(formatDateLike(Date.UTC(2026, 8, 15), '9/14/26'), '9/15/26');
  {
    const parsed = classifySearchCards([
      { asin: 'B0FAMILY01', text: 'Plain result title without brand' },
      { asin: 'B0OTHER001', text: 'MUSSHOE other style' },
    ], 'MUSSHOE', ['B0FAMILY01']);
    assert.deepEqual(parsed.candidates.map(item => item.asin), ['B0FAMILY01', 'B0OTHER001']);
  }
  for (const options of [{ completed: true }, { recovered: true }]) {
    const result = await scenario(options);
    assert.equal(result.counts.health, 0);
    assert.equal(result.counts.dispatch, 0);
    assert.equal(result.state.results.length, 1);
    assert.equal(result.state.results[0].writeback.pending, true);
  }
  const success = await scenario();
  assert.equal(success.counts.health, 1);
  assert.equal(success.counts.dispatch, 1);
  const retry = await scenario({ startupFailures: 1 });
  assert.equal(retry.counts.dispatch, 2);
  assert.equal(retry.state.results.length, 1);
  const exhausted = await scenario({ startupFailures: 100 });
  assert.equal(exhausted.counts.dispatch, 3);
  assert.equal(exhausted.counts.pauses, 1);
  assert.equal(exhausted.state.results.length, 0);
  const blocked = await scenario({ health: false });
  assert.equal(blocked.counts.dispatch, 0);
  assert.equal(blocked.exitCode, 3);

  const browserSource = fs.readFileSync(path.join(__dirname, 'run_single_test.cjs'), 'utf8');
  const ownerSource = fs.readFileSync(path.join(__dirname, 'run_owned_sheets.cjs'), 'utf8');
  const summarySource = ownerSource.slice(ownerSource.indexOf('const summarize ='), ownerSource.indexOf("if (action === 'status')"));
  const summaryContext = { readJson: () => null, pausePath: sheet => sheet };
  vm.createContext(summaryContext);
  const summarize = vm.runInContext(summarySource + '\nsummarize;', summaryContext);
  const summaryState = { finishedAt: '2026-09-15', plans: [{ name: 'TEST', keywords: 1 }], results: [] };
  assert.equal(summarize('TEST', summaryState).status, 'RUNNING_OR_RESUMABLE');
  summaryState.results = [{ sheet: 'TEST', keywordCell: 'G1', status: 'SUCCESS', writeback: { pending: true } }];
  assert.equal(summarize('TEST', summaryState).status, 'RUNNING_OR_RESUMABLE');
  summaryState.results[0].writeback = { verified: true };
  assert.equal(summarize('TEST', summaryState).status, 'COMPLETED');
  summaryState.results[0].status = 'FAILED';
  assert.equal(summarize('TEST', summaryState).status, 'RUNNING_OR_RESUMABLE');
  const waitSource = browserSource.slice(browserSource.indexOf('const batchWait ='), browserSource.indexOf('const isBlockedError ='));
  for (const pauseAt of [Infinity, 500]) {
    let now = 0;
    const context = { Date: { now: () => now }, Math, Promise, batchDelayRange: [20000, 20000], batchPauseFile: 'pause',
      fs: { existsSync: () => now >= pauseAt }, setTimeout: (resolve, ms) => { now += ms; resolve(); } };
    vm.createContext(context);
    await vm.runInContext(waitSource + '\nbatchWait();', context);
    assert.equal(now, pauseAt === Infinity ? 20000 : 500);
  }

  // Unit tests for structured export (#2)
  {
    const mockState = {
      runId: 'run-20260915-001',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:30:00.000Z',
      businessDateEpoch: Date.UTC(2026, 8, 15),
      results: [
        {
          sheet: 'Sandals',
          keyword: 'jelly shoes',
          keywordCell: 'G1',
          outputCell: 'G78',
          businessDate: '2026/9/15',
          status: 'SUCCESS',
          writeback: { value: 'page 1 #4, 裸色 7', verified: true },
          result: {
            asin: 'B0TESTASIN1',
            matchedTargetAsin: 'B0TARGET001',
            matchType: 'VARIATION_FAMILY',
            page: 1,
            pageNaturalPosition: 4,
            totalNaturalRank: 4,
            color: 'Nude',
            size: '7',
          },
          durationMs: 1200,
        },
        {
          sheet: 'Sandals',
          keyword: 'heeled sandals',
          keywordCell: 'H1',
          outputCell: 'H78',
          businessDate: '2026/9/15',
          status: 'NOT_FOUND',
          writeback: { value: '-', verified: true },
          durationMs: 4500,
        },
        {
          sheet: 'Sandals',
          keyword: 'beach flip flops',
          keywordCell: 'I1',
          outputCell: 'I78',
          businessDate: '2026/9/15',
          status: 'FAILED',
          error: 'WAF HTTP 202 interstitial blocked',
          writeback: null,
          durationMs: 600,
        },
      ],
    };

    const records = buildExportRecords(mockState);
    assert.equal(records.length, 3);

    // 1. Verify 3-valued status semantics
    assert.equal(records[0].status, 'FOUND');
    assert.equal(records[0].match_type, 'VARIATION_FAMILY');
    assert.equal(records[0].actual_asin, 'B0TESTASIN1');
    assert.equal(records[0].matched_target_asin, 'B0TARGET001');
    assert.equal(records[0].writeback_verified, true);
    assert.equal(records[0].failure_reason, null);

    assert.equal(records[1].status, 'NOT_FOUND');
    assert.equal(records[1].writeback_value, '-');
    assert.equal(records[1].writeback_verified, true);
    assert.equal(records[1].failure_reason, null);

    assert.equal(records[2].status, 'FAILED');
    assert.equal(records[2].failure_reason, 'WAF HTTP 202 interstitial blocked');
    assert.equal(records[2].writeback_verified, false);
    // Crucial: FAILED must not be collapsed to empty or dash!
    assert.notEqual(records[2].status, 'NOT_FOUND');
    assert.notEqual(records[2].status, '');

    // 2. Verify JSONL formatting
    const jsonl = formatJsonl(records);
    const lines = jsonl.trim().split('\n');
    assert.equal(lines.length, 3);
    const parsedLine0 = JSON.parse(lines[0]);
    assert.equal(parsedLine0.status, 'FOUND');
    assert.equal(parsedLine0.keyword, 'jelly shoes');

    // 3. Verify CSV formatting
    const csv = formatCsv(records);
    assert.ok(csv.startsWith('run_id,business_date,sheet_name,keyword'));
    assert.ok(csv.includes('WAF HTTP 202 interstitial blocked'));

    // 4. Verify file export to a temp folder
    const tempExportDir = path.join(__dirname, 'work', 'test-export-temp');
    const { generatedFiles } = exportResults({ state: mockState, outputDir: tempExportDir, formats: ['jsonl', 'csv'] });
    assert.equal(generatedFiles.length, 2);
    assert.ok(fs.existsSync(generatedFiles[0]));
    assert.ok(fs.existsSync(generatedFiles[1]));
    // Cleanup temp files
    fs.rmSync(tempExportDir, { recursive: true, force: true });
  }

  console.log('PASS: date format, expanded candidate ASINs, completed/recovered skip browser, health gate, startup retry, bounded exhaustion, pending writes preserved, interruptible pacing, structured export.');
})().catch(error => { console.error(error); process.exitCode = 1; });
