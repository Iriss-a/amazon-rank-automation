const fs = require('fs');
const path = require('path');

function sanitizeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Transforms run state and verified results into structured export records.
 *
 * Design constraints from Issue #2 & docs/DESIGN.md:
 * 1. Post-writeback: export is a derived artifact after writeback verification.
 * 2. Three-valued semantic preservation: FOUND, NOT_FOUND, FAILED are strictly
 *    distinguished. FAILED is never collapsed into empty/dash.
 * 3. Required metadata: run_id, business_date (America/Los_Angeles), collected_at,
 *    match_type (EXACT_ASIN / VARIATION_FAMILY / null), failure reason.
 */
function buildExportRecords(state) {
  const runId = state.runId || state.startedAt || new Date().toISOString();
  const businessDate = state.businessDate || (state.businessDateEpoch ? new Date(state.businessDateEpoch).toISOString().slice(0, 10) : null);
  const results = Array.isArray(state.results) ? state.results : [];

  return results.map(item => {
    // 3-value semantic: status is FOUND, NOT_FOUND, or FAILED
    let semanticStatus = 'FAILED';
    let failureReason = null;

    if (item.status === 'SUCCESS' || item.status === 'FOUND') {
      semanticStatus = 'FOUND';
    } else if (item.status === 'NOT_FOUND') {
      semanticStatus = 'NOT_FOUND';
    } else {
      semanticStatus = 'FAILED';
      failureReason = item.error || item.reason || (item.writeback && !item.writeback.verified ? item.writeback.error : null) || item.status;
    }

    const matchType = item.result?.matchType || item.matchType || (semanticStatus === 'FOUND' ? (item.matchType || 'EXACT_ASIN') : null);
    const actualAsin = item.result?.asin || item.asin || null;
    const matchedTargetAsin = item.result?.matchedTargetAsin || item.matchedTargetAsin || null;

    return {
      run_id: runId,
      business_date: item.businessDate || businessDate,
      sheet_name: item.sheet || null,
      keyword: item.keyword || null,
      keyword_cell: item.keywordCell || null,
      output_cell: item.outputCell || null,
      status: semanticStatus,
      raw_status: item.status,
      writeback_value: item.writeback?.value ?? null,
      writeback_verified: Boolean(item.writeback?.verified),
      actual_asin: actualAsin,
      matched_target_asin: matchedTargetAsin,
      match_type: matchType,
      rank: item.result?.totalNaturalRank ?? item.totalNaturalRank ?? null,
      page: item.result?.page ?? item.page ?? null,
      page_position: item.result?.pageNaturalPosition ?? item.pageNaturalPosition ?? null,
      color: item.result?.color ?? item.color ?? null,
      size: item.result?.size ?? item.size ?? null,
      collected_at: item.finishedAt || item.collectedAt || state.finishedAt || new Date().toISOString(),
      duration_ms: item.durationMs ?? null,
      failure_reason: failureReason,
    };
  });
}

/**
 * Format records as JSONL (one JSON object per line)
 */
function formatJsonl(records) {
  return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

/**
 * Format records as CSV
 */
function formatCsv(records) {
  const headers = [
    'run_id',
    'business_date',
    'sheet_name',
    'keyword',
    'keyword_cell',
    'output_cell',
    'status',
    'raw_status',
    'writeback_value',
    'writeback_verified',
    'actual_asin',
    'matched_target_asin',
    'match_type',
    'rank',
    'page',
    'page_position',
    'color',
    'size',
    'collected_at',
    'duration_ms',
    'failure_reason',
  ];

  const lines = [headers.join(',')];
  for (const record of records) {
    const row = headers.map(h => sanitizeCsvField(record[h]));
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Export derived rank collection results to disk in JSONL and optionally CSV.
 * Only called AFTER writeback is flushed/completed.
 */
function exportResults({ state, outputDir, formats = ['jsonl', 'csv'] }) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const records = buildExportRecords(state);
  const businessDate = (state.businessDate || (state.businessDateEpoch ? new Date(state.businessDateEpoch).toISOString().slice(0, 10) : 'unknown')).replace(/[\/-]/g, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `rank-export-${businessDate}-${timestamp}`;

  const generatedFiles = [];

  if (formats.includes('jsonl')) {
    const jsonlPath = path.join(outputDir, `${baseName}.jsonl`);
    fs.writeFileSync(jsonlPath, formatJsonl(records), 'utf8');
    generatedFiles.push(jsonlPath);
  }

  if (formats.includes('csv')) {
    const csvPath = path.join(outputDir, `${baseName}.csv`);
    fs.writeFileSync(csvPath, formatCsv(records), 'utf8');
    generatedFiles.push(csvPath);
  }

  return { records, generatedFiles };
}

module.exports = {
  buildExportRecords,
  formatJsonl,
  formatCsv,
  exportResults,
};
