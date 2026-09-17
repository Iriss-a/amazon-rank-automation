const { spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const root = __dirname;
const raw = process.argv.find(arg => arg.startsWith('--sheet='))?.slice('--sheet='.length).trim();
if (!raw || raw.includes(',') || /[*?]/.test(raw)) {
  console.error('Usage: node run_owned_sheet.cjs --sheet=<exact SPU/Sheet name> [--resume-checkpoint]');
  process.exit(2);
}

// Owner-scoped runs always use one shared Incognito Context for the complete
// Sheet. The coordinator still checkpoints each keyword independently.
const args = [path.join(root, 'run_tencent_multi_sheet_cycle.cjs'), `--sheets=${raw}`, '--batch-browser'];
if (process.argv.includes('--resume-checkpoint')) args.push('--resume-checkpoint');
if (process.argv.includes('--recheck-not-found')) args.push('--recheck-not-found');

const normalized = raw.toLowerCase();
const safe = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'spu';
const suffix = safe.toLowerCase() === normalized ? '' : `-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
const env = {
  ...process.env,
  AMAZON_STATE_SCOPE: `sheet-${safe}${suffix}`,
  AMAZON_SHEET_CONCURRENCY: '1',
};
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });
process.exitCode = result.status ?? 1;
